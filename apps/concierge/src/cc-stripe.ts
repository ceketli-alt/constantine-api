// Concierge Connect — cc-stripe (checkout + webhook), ported from the Supabase
// Edge Function to Hono/Node with the real Stripe SDK.
//
//   POST ?action=checkout  { bookingReference, returnUrl } -> { checkout_url, stub? }
//   POST ?action=webhook   (Stripe event; Stripe-Signature verified)
//
// When STRIPE_SECRET_KEY is unset, checkout returns a stub URL (stripe_status =
// 'pending_stub') so the storefront flow stays testable before keys arrive.
//
// On a real `checkout.session.completed`, the booking is captured under a
// platform-admin request context (so it passes bookings_guard + RLS): it sets
// status=confirmed + payment_type=platform_card + payment_status=paid, which
// fires bookings_post_ledger_trg → ledger_entry + ledger_movements, and
// bookings_notify_trg → booking.confirmed notification. Idempotent per booking.
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { sql, withRequestContext } from './db.js';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const STOREFRONT_URL = process.env.SITE_URL_STOREFRONT ?? 'https://cc-storefront.constantineyachts.com';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

let adminIdCache: string | null = null;
async function platformAdminId(): Promise<string> {
  if (adminIdCache) return adminIdCache;
  const r = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE role = 'platform_admin' ORDER BY created_at ASC LIMIT 1`;
  if (!r[0]) throw new Error('no platform_admin profile configured');
  adminIdCache = r[0].id;
  return adminIdCache;
}

// Booking reads/writes need a platform-admin context (bookings RLS has no
// anon/service policy; the guard restricts non-admin column changes).
async function withAdmin<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  const adminId = await platformAdminId();
  return withRequestContext({ userId: adminId, role: 'platform_admin' }, fn);
}

function appendQuery(url: string, qs: string): string {
  if (!url) return `${STOREFRONT_URL}?${qs}`;
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`;
}

async function handleCheckout(c: Context): Promise<Response> {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const ref = (body.bookingReference ?? '').trim();
  const returnUrl = (body.returnUrl ?? '').trim();
  if (!ref) return c.json({ error: 'bookingReference required' }, 400);

  const booking = await withAdmin(async (tx) => {
    const r = await tx`
      SELECT id, reference, total, currency, status, payment_status, product_title, guest_email
      FROM bookings WHERE reference = ${ref} LIMIT 1
    `;
    return r[0] ?? null;
  });
  if (!booking) return c.json({ error: 'booking_not_found' }, 404);
  if (booking.payment_status === 'paid') return c.json({ error: 'already_paid' }, 409);

  // STUB path — no secret yet: return a mock URL that bounces back with a stub
  // session id so the storefront end-to-end flow is exercisable now.
  if (!stripe) {
    const mockSessionId = 'cs_test_stub_' + randomUUID();
    const mockUrl = appendQuery(returnUrl, `stub=ok&session_id=${mockSessionId}`);
    await withAdmin((tx) => tx`UPDATE bookings SET stripe_checkout_session_id = ${mockSessionId}, stripe_status = 'pending_stub' WHERE id = ${booking.id}`);
    return c.json({
      stub: true,
      checkout_url: mockUrl,
      session_id: mockSessionId,
      message: 'Stripe scaffolding — set STRIPE_SECRET_KEY to enable real payments.',
    });
  }

  // Real Stripe Checkout Session. Amount in minor units of the booking currency.
  const amount = Math.round(Number(booking.total) * 100);
  if (!(amount > 0)) return c.json({ error: 'invalid_amount' }, 400);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: String(booking.currency).toLowerCase(),
        product_data: { name: booking.product_title || `Booking ${booking.reference}` },
        unit_amount: amount,
      },
      quantity: 1,
    }],
    client_reference_id: booking.reference,
    customer_email: booking.guest_email || undefined,
    metadata: { booking_reference: booking.reference, booking_id: booking.id },
    success_url: appendQuery(returnUrl, 'paid=1&session_id={CHECKOUT_SESSION_ID}'),
    cancel_url: appendQuery(returnUrl, 'canceled=1'),
  });
  await withAdmin((tx) => tx`UPDATE bookings SET stripe_checkout_session_id = ${session.id}, stripe_status = 'pending' WHERE id = ${booking.id}`);
  return c.json({ checkout_url: session.url });
}

// Capture a paid booking. Idempotent: a no-op if already paid. The status +
// payment_type transition is what fires the ledger/commission + notification.
export async function captureStripePayment(reference: string, sessionId: string | null, paymentIntentId: string | null): Promise<'captured' | 'skipped' | 'not_found'> {
  return withAdmin(async (tx) => {
    const cur = await tx`SELECT id, payment_status FROM bookings WHERE reference = ${reference} LIMIT 1`;
    if (!cur[0]) return 'not_found';
    if (cur[0].payment_status === 'paid') return 'skipped';
    await tx`
      UPDATE bookings SET
        status = 'confirmed',
        payment_type = 'platform_card',
        payment_status = 'paid',
        payment_captured_at = now(),
        stripe_checkout_session_id = COALESCE(${sessionId}, stripe_checkout_session_id),
        stripe_payment_intent_id = ${paymentIntentId},
        stripe_status = 'paid'
      WHERE id = ${cur[0].id}
    `;
    return 'captured';
  });
}

async function handleWebhook(c: Context): Promise<Response> {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    // No secret yet — acknowledge so Stripe's test dashboard doesn't retry-storm.
    return c.json({ stub: true, received: true, note: 'STRIPE_SECRET_KEY/WEBHOOK_SECRET unset' });
  }
  const sig = c.req.header('stripe-signature');
  if (!sig) return c.json({ error: 'missing_signature' }, 400);
  // Raw body BEFORE any json() — required for signature verification.
  const raw = await c.req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e: any) {
    console.error('[cc-stripe] webhook signature verify failed:', e?.message);
    return c.json({ error: 'invalid_signature' }, 400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const ref = session.client_reference_id ?? (session.metadata as Record<string, string> | null)?.booking_reference ?? null;
    const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
    if (ref) {
      try {
        const result = await captureStripePayment(ref, session.id, pi);
        console.log(`[cc-stripe] capture ${ref}: ${result}`);
      } catch (e: any) {
        console.error(`[cc-stripe] capture ${ref} failed:`, e?.message);
        return c.json({ error: 'capture_failed' }, 500); // Stripe will retry
      }
    }
  }
  return c.json({ received: true });
}

export async function handleCcStripe(c: Context): Promise<Response> {
  if (c.req.method !== 'POST') return c.json({ error: 'method_not_allowed' }, 405);
  const action = c.req.query('action');
  try {
    if (action === 'checkout') return await handleCheckout(c);
    if (action === 'webhook') return await handleWebhook(c);
    return c.json({ error: 'unknown_action' }, 400);
  } catch (e: any) {
    console.error('[cc-stripe]', action, e?.message ?? e);
    return c.json({ error: 'internal_error' }, 500);
  }
}
