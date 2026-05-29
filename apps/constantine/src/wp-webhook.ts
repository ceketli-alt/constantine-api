/**
 * wp-webhook — WhatsApp inbound webhook (Meta'dan)
 * Port of supabase/functions/wp-webhook/index.ts
 *
 * GET  /functions/v1/wp-webhook  — Meta verification handshake (hub.challenge)
 * POST /functions/v1/wp-webhook  — Inbound message + quick-reply button parser
 *
 * Button reply handlers:
 *   - "yes_share_link"  → handleAgreedLink (status → qualified, hot)
 *   - "not_interested"  → handleOptOut (status → opted_out, unsubscribes upsert)
 *
 * Sprint 2 stub: Meta onayı sonrası live test edilecek (outreach_link_delivery_2026 template send).
 *
 * Security: X-Hub-Signature-256 (SHA256 HMAC) verify — opsiyonel, env'de
 * META_WP_APP_SECRET varsa zorlanır.
 */
import type { Context } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from './db.js';

const VERIFY_TOKEN = process.env.META_WP_WEBHOOK_VERIFY_TOKEN ?? '';
const APP_SECRET = process.env.META_WP_APP_SECRET ?? '';

const BUTTON_YES = 'yes_share_link';
const BUTTON_NO = 'not_interested';

// =========================================================
// Signature verification (Meta App Secret HMAC)
// =========================================================
function verifyMetaSignature(rawBody: string, signature: string | undefined): boolean {
  // Fail closed — caller secret'ı pre-validate eder.
  if (!APP_SECRET) return false;
  if (!signature) return false;
  const expected = 'sha256=' + createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// =========================================================
// Hono handler
// =========================================================
export async function handleWpWebhook(c: Context): Promise<Response> {
  // GET — Meta verification handshake
  if (c.req.method === 'GET') {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    if (mode === 'subscribe' && token && token === VERIFY_TOKEN) {
      return new Response(challenge ?? '', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // POST — inbound payload
  if (c.req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Read raw body for signature verify
  const rawBody = await c.req.text();
  if (!APP_SECRET) {
    console.error('[wp-webhook] META_WP_APP_SECRET not configured — rejecting POST (fail-closed)');
    return new Response('webhook_not_configured', { status: 503 });
  }
  const sig = c.req.header('x-hub-signature-256');
  if (!verifyMetaSignature(rawBody, sig)) {
    console.warn('[wp-webhook] invalid signature');
    return new Response('invalid signature', { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  try {
    // Raw payload log her zaman (audit trail)
    try {
      await sql`
        INSERT INTO wp_webhook_log (payload)
        VALUES (${sql.json(payload as any)})
      `;
    } catch (e: any) {
      console.warn('[wp-webhook] wp_webhook_log insert skipped:', e?.message);
    }

    // Quick reply parser — best-effort, hata olsa bile 200 dön
    try {
      await processMessages(payload);
    } catch (parseErr: any) {
      console.warn('[wp-webhook] parse hatasi (log atildi, devam):', parseErr?.message);
    }

    return new Response('OK', { status: 200 });
  } catch (e: any) {
    console.error('[wp-webhook] fatal:', e);
    return new Response('Error', { status: 500 });
  }
}

// =========================================================
// Payload parsing
// =========================================================
interface WpMessage {
  from?: string;
  type?: string;
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
  };
  text?: { body?: string };
}

async function processMessages(payload: unknown): Promise<void> {
  const entries =
    (payload as { entry?: Array<{ changes?: Array<{ value?: { messages?: WpMessage[] } }> }> }).entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const messages = change.value?.messages ?? [];
      for (const msg of messages) {
        if (msg.type === 'interactive' && msg.interactive?.button_reply) {
          const buttonId = msg.interactive.button_reply.id;
          const fromPhone = msg.from;
          if (!fromPhone) continue;

          // E.164 normalize
          const e164 = fromPhone.startsWith('+') ? fromPhone : `+${fromPhone}`;

          if (buttonId === BUTTON_YES) {
            await handleAgreedLink(e164);
          } else if (buttonId === BUTTON_NO) {
            await handleOptOut(e164);
          }
        }
      }
    }
  }
}

// =========================================================
// system fallback user_id (activity_events NOT NULL)
// =========================================================
async function getSystemUserId(): Promise<string | null> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM profiles
    WHERE role::text = 'super_admin' AND active = TRUE
    ORDER BY created_at
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

// =========================================================
// Button handlers
// =========================================================
async function handleAgreedLink(phone: string): Promise<void> {
  const leadRows = await sql<Array<{
    id: string;
    company_name: string | null;
    primary_contact_name: string | null;
    primary_contact_phone: string | null;
    status: string;
    converted_channel_id: string | null;
  }>>`
    SELECT id, company_name, primary_contact_name, primary_contact_phone, status, converted_channel_id
    FROM leads
    WHERE primary_contact_phone = ${phone}
    LIMIT 1
  `;
  const lead = leadRows[0];
  if (!lead) {
    console.warn('[wp-webhook] handleAgreedLink: lead bulunamadı', phone);
    return;
  }

  if (lead.status === 'new' || lead.status === 'contacted') {
    await sql`
      UPDATE leads
      SET status = 'qualified', temperature = 'hot'
      WHERE id = ${lead.id}
    `;
  }

  const systemUserId = await getSystemUserId();
  if (systemUserId) {
    try {
      await sql`
        INSERT INTO activity_events (
          user_id, event_type, category, points, target_type, target_id, metadata
        ) VALUES (
          ${systemUserId}::uuid,
          'lead_status_changed',
          'standard',
          0,
          'lead',
          ${lead.id}::uuid,
          ${sql.json({
            lead_id: lead.id,
            from: lead.status,
            to: 'qualified',
            reason: 'wp_quick_reply_agreed',
            source: 'wp_webhook',
          })}
        )
      `;
    } catch (e: any) {
      console.warn('[wp-webhook] activity_events insert skipped:', e?.message);
    }
  }

  // Sprint 2 stub: agency_channel insert + outreach_link_delivery_2026 send
  // Meta onayı sonrası live edilecek.
  if (!lead.converted_channel_id) {
    console.info('[wp-webhook] handleAgreedLink: agency channel + outreach_link_delivery_2026 send (Meta onayı sonrası live)', {
      lead_id: lead.id,
      phone,
    });
  }
}

async function handleOptOut(phone: string): Promise<void> {
  const leadRows = await sql<Array<{ id: string; status: string }>>`
    SELECT id, status FROM leads
    WHERE primary_contact_phone = ${phone}
    LIMIT 1
  `;
  const lead = leadRows[0];

  // Unsubscribes registry upsert (lead bulunsa da bulunmasa da)
  try {
    await sql`
      INSERT INTO unsubscribes (channel, identifier, reason, source)
      VALUES ('whatsapp', ${phone}, 'whatsapp_quick_reply', 'wp_webhook')
      ON CONFLICT (channel, identifier) DO UPDATE
        SET reason = EXCLUDED.reason, source = EXCLUDED.source
    `;
  } catch (e: any) {
    console.warn('[wp-webhook] unsubscribes upsert skipped:', e?.message);
  }

  if (!lead) {
    console.warn('[wp-webhook] handleOptOut: lead bulunamadı', phone);
    return;
  }

  // Lead status update + opted_out
  try {
    await sql`
      UPDATE leads
      SET status = 'opted_out',
          opted_out_at = ${new Date().toISOString()},
          opted_out_channel = 'whatsapp',
          opted_out_reason = 'wp_quick_reply'
      WHERE id = ${lead.id}
    `;
  } catch (e: any) {
    console.warn('[wp-webhook] lead status update failed:', e?.message);
  }

  const systemUserId = await getSystemUserId();
  if (systemUserId) {
    try {
      await sql`
        INSERT INTO activity_events (
          user_id, event_type, category, points, target_type, target_id, metadata
        ) VALUES (
          ${systemUserId}::uuid,
          'lead_opted_out',
          'standard',
          0,
          'lead',
          ${lead.id}::uuid,
          ${sql.json({
            lead_id: lead.id,
            channel: 'whatsapp',
            reason: 'wp_quick_reply',
            source: 'wp_webhook',
          })}
        )
      `;
    } catch (e: any) {
      console.warn('[wp-webhook] activity_events insert skipped:', e?.message);
    }
  }
}
