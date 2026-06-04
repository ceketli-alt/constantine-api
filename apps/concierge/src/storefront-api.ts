// Concierge Connect — public storefront API (ported from the Supabase Edge
// Function to Hono/Node).
//
// Serves the white-label guest storefront: catalog / product / availability /
// reseller branding / promo validation / booking creation / voucher / reviews
// / messages. The booking write path delegates to the self-sufficient
// create_cart_booking() RPC (capacity + promo + discount + inserts).
//
// Security model (mirrors the original service_role design): RLS on every
// storefront table is owner/admin-scoped with NO public-read policy, so reads
// run under a platform-admin request context (is_platform_admin() passes) and
// the published+approved WHERE filters + server-side pricing ARE the security
// boundary. Only public-safe columns are selected.
//
// Differences vs the Supabase original (schema has drifted): this DB has no
// resolve_markup / redeem_promo_code / create_booking-callable RPCs, so reseller
// markup is not applied (vendor base prices, consistent across product view +
// booking), promo is validated/redeemed inside create_cart_booking, and BOTH
// `book` and `cart_book` route through create_cart_booking. `bookings` has no
// cancelled_at/cancellation_reason columns, so self-cancel sets status only.
import type { Context } from 'hono';
import { sql, withRequestContext } from './db.js';

// postgres-js transaction handle (typed loosely; tsx strips types at runtime).
type Tx = any;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let adminIdCache: string | null = null;
async function platformAdminId(): Promise<string> {
  if (adminIdCache) return adminIdCache;
  const r = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE role = 'platform_admin' ORDER BY created_at ASC LIMIT 1`;
  if (!r[0]) throw new Error('no platform_admin profile configured');
  adminIdCache = r[0].id;
  return adminIdCache;
}

function minBookingDate(advanceHours: number): string {
  const days = Math.max(1, Math.ceil((advanceHours || 0) / 24));
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function bookingErrorMessage(raw: string): string {
  if (raw.includes('insufficient capacity')) return 'Seçtiğiniz tarihte yeterli kontenjan yok.';
  if (raw.includes('date not available')) return 'Seçtiğiniz tarih müsait değil.';
  if (raw.includes('booking date too soon')) return 'Seçtiğiniz tarih çok yakın, lütfen ileri bir tarih seçin.';
  if (raw.includes('product not available')) return 'Bu ürün şu an rezervasyona kapalı.';
  if (raw.includes('invalid promo')) return 'Promosyon kodu geçersiz.';
  if (raw.includes('empty cart')) return 'Sepetiniz boş.';
  if (raw.includes('mixed currency') || raw.includes('invalid currency')) return 'Sepette tek geçerli para birimi (EUR/USD) kullanılabilir.';
  return 'Rezervasyon oluşturulamadı, lütfen tekrar deneyin.';
}
const BOOKING_ERR_RE = /insufficient capacity|date not available|booking date too soon|product not available|invalid promo|empty cart|mixed currency|invalid currency|no guests|invalid booking item/i;

// ───────────────────────── read handlers ─────────────────────────

async function catalog(tx: Tx, c: Context): Promise<Response> {
  const products = await tx`
    SELECT p.id, p.type, p.title, p.title_en, p.description, p.description_en,
           p.category, p.category_en, p.duration_minutes, p.capacity_min, p.capacity_max,
           p.featured_rank, p.featured_until, p.translations,
           json_build_object('display_name', v.display_name) AS vendors,
           COALESCE((SELECT json_agg(json_build_object('url', pi.url, 'sort_order', pi.sort_order) ORDER BY pi.sort_order)
                     FROM product_images pi WHERE pi.product_id = p.id), '[]'::json) AS product_images
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE p.status = 'published' AND v.status = 'approved'
    ORDER BY (p.featured_rank IS NOT NULL AND (p.featured_until IS NULL OR p.featured_until >= now())) DESC,
             p.featured_rank ASC NULLS LAST,
             p.created_at DESC
  `;
  return c.json({ products });
}

async function product(tx: Tx, c: Context): Promise<Response> {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id required' }, 400);
  // `slug` accepted for API compatibility; reseller markup is not applied (no
  // resolve_markup in this DB) so prices are the vendor base, consistent with /book.
  const rows = await tx`
    SELECT p.id, p.type, p.title, p.title_en, p.description, p.description_en,
           p.category, p.category_en, p.duration_minutes, p.capacity_min, p.capacity_max,
           p.featured_rank, p.featured_until, p.translations,
           p.meeting_type, p.meeting_details, p.meeting_details_en, p.details,
           p.vendor_id, p.time_slots,
           json_build_object('display_name', v.display_name) AS vendors,
           COALESCE((SELECT json_agg(json_build_object('url', pi.url, 'sort_order', pi.sort_order) ORDER BY pi.sort_order)
                     FROM product_images pi WHERE pi.product_id = p.id), '[]'::json) AS product_images,
           COALESCE((SELECT json_agg(json_build_object('id', pc.id, 'label', pc.label, 'label_en', pc.label_en,
                       'price', pc.price, 'currency', pc.currency, 'min_pax', pc.min_pax, 'max_pax', pc.max_pax,
                       'sort_order', pc.sort_order, 'translations', pc.translations) ORDER BY pc.sort_order)
                     FROM product_pricing_categories pc WHERE pc.product_id = p.id), '[]'::json) AS product_pricing_categories
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE p.id = ${id} AND p.status = 'published' AND v.status = 'approved'
    LIMIT 1
  `;
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  return c.json({ product: rows[0] });
}

async function reseller(tx: Tx, c: Context): Promise<Response> {
  const slug = c.req.query('slug');
  if (!slug) return c.json({ error: 'slug required' }, 400);
  const rows = await tx`
    SELECT id, display_name, kind, slug, logo_url, primary_color, accent_color, default_locale
    FROM resellers WHERE slug = ${slug} AND status = 'approved' LIMIT 1
  `;
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  return c.json({ reseller: rows[0] });
}

async function availability(tx: Tx, c: Context): Promise<Response> {
  const productId = c.req.query('productId');
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (!productId || !from || !to) return c.json({ error: 'productId, from, to required' }, 400);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return c.json({ error: 'invalid date range' }, 400);

  const prod = await tx`
    SELECT p.capacity_max, p.advance_booking_hours
    FROM products p JOIN vendors v ON v.id = p.vendor_id
    WHERE p.id = ${productId} AND p.status = 'published' AND v.status = 'approved' LIMIT 1
  `;
  if (!prod[0]) return c.json({ error: 'not found' }, 404);
  const capacityMax = Number(prod[0].capacity_max);
  const advanceHours = Number(prod[0].advance_booking_hours);

  const exceptions = await tx`
    SELECT date::text AS date, is_open, capacity FROM product_availability
    WHERE product_id = ${productId} AND date >= ${from} AND date <= ${to}
  `;
  const booked = await tx`
    SELECT booking_date::text AS booking_date, pax_total FROM bookings
    WHERE product_id = ${productId} AND status <> 'cancelled' AND booking_date >= ${from} AND booking_date <= ${to}
  `;

  const bookedByDate = new Map<string, number>();
  for (const r of booked) bookedByDate.set(r.booking_date, (bookedByDate.get(r.booking_date) ?? 0) + Number(r.pax_total));
  const exByDate = new Map<string, { is_open: boolean; capacity: number | null }>();
  for (const r of exceptions) exByDate.set(r.date, { is_open: r.is_open, capacity: r.capacity });

  const dates = new Set<string>([...bookedByDate.keys(), ...exByDate.keys()]);
  const days = [...dates].sort().map((date) => {
    const ex = exByDate.get(date);
    const isOpen = ex ? ex.is_open : true;
    const dateCapacity = !isOpen ? 0 : Number(ex?.capacity ?? capacityMax);
    const remaining = Math.max(0, dateCapacity - (bookedByDate.get(date) ?? 0));
    return { date, is_open: isOpen, remaining };
  });

  return c.json({ capacity_max: capacityMax, advance_booking_hours: advanceHours, min_date: minBookingDate(advanceHours), days });
}

async function voucher(tx: Tx, c: Context): Promise<Response> {
  const reference = c.req.query('reference');
  if (!reference) return c.json({ error: 'reference required' }, 400);
  const rows = await tx`
    SELECT b.id, b.reference, b.product_id, b.product_title, b.product_type, b.vendor_name, b.reseller_name,
           b.booking_date::text AS booking_date, b.status, b.pax_total, b.currency, b.total, b.guest_name, b.created_at,
           COALESCE((SELECT json_agg(json_build_object('label', bi.label, 'unit_price', bi.unit_price, 'currency', bi.currency, 'quantity', bi.quantity, 'line_total', bi.line_total))
                     FROM booking_items bi WHERE bi.booking_id = b.id), '[]'::json) AS booking_items
    FROM bookings b WHERE b.reference = ${reference} LIMIT 1
  `;
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  const b = rows[0];
  const today = new Date().toISOString().slice(0, 10);
  const can_review = b.status === 'confirmed' && b.booking_date < today;
  let has_reviewed = false;
  if (can_review) {
    const ex = await tx`SELECT id FROM reviews WHERE booking_id = ${b.id} LIMIT 1`;
    has_reviewed = !!ex[0];
  }
  const { id: _id, ...pub } = b;
  return c.json({ booking: pub, can_review, has_reviewed });
}

async function cartVoucher(tx: Tx, c: Context): Promise<Response> {
  const cartId = c.req.query('cart_id');
  if (!cartId) return c.json({ error: 'cart_id required' }, 400);
  const rows = await tx`
    SELECT b.id, b.reference, b.cart_id, b.product_id, b.product_title, b.product_type, b.vendor_name, b.reseller_name,
           b.booking_date::text AS booking_date, b.slot_time, b.status, b.pax_total, b.currency, b.total, b.discount_amount, b.guest_name, b.created_at,
           COALESCE((SELECT json_agg(json_build_object('label', bi.label, 'unit_price', bi.unit_price, 'currency', bi.currency, 'quantity', bi.quantity, 'line_total', bi.line_total))
                     FROM booking_items bi WHERE bi.booking_id = b.id), '[]'::json) AS booking_items
    FROM bookings b WHERE b.cart_id = ${cartId} ORDER BY b.created_at ASC
  `;
  if (!rows.length) return c.json({ error: 'cart not found' }, 404);
  const byCurrency: Record<string, number> = {};
  let discount = 0;
  for (const r of rows) {
    byCurrency[r.currency] = (byCurrency[r.currency] ?? 0) + Number(r.total);
    discount += Number(r.discount_amount ?? 0);
  }
  const bookings = rows.map(({ id: _i, ...rest }: any) => rest);
  return c.json({ cart: { id: cartId, bookings }, totals: { byCurrency, discount } });
}

async function reviews(tx: Tx, c: Context): Promise<Response> {
  const productId = c.req.query('productId');
  if (!productId) return c.json({ error: 'productId required' }, 400);
  const limit = Math.min(50, parseInt(c.req.query('limit') ?? '10', 10) || 10);
  const list = await tx`
    SELECT id, guest_name, rating, comment, created_at, photo_urls, vendor_reply, vendor_replied_at
    FROM reviews WHERE product_id = ${productId} AND status = 'published'
    ORDER BY created_at DESC LIMIT ${limit}
  `;
  const summary = await tx`SELECT * FROM product_review_summary(${productId})`;
  const s = summary[0] ?? { rating_avg: null, rating_count: 0 };
  return c.json({
    reviews: list,
    rating_avg: s.rating_avg == null ? null : Number(s.rating_avg),
    rating_count: Number(s.rating_count ?? 0),
  });
}

async function messages(tx: Tx, c: Context): Promise<Response> {
  const reference = c.req.query('reference');
  if (!reference) return c.json({ error: 'reference required' }, 400);
  const bk = await tx`SELECT id FROM bookings WHERE reference = ${reference} LIMIT 1`;
  if (!bk[0]) return c.json({ error: 'booking not found' }, 404);
  const list = await tx`
    SELECT id, sender_kind, sender_name, body, created_at FROM booking_messages
    WHERE booking_id = ${bk[0].id} ORDER BY created_at ASC
  `;
  const ids = list.filter((m: any) => m.sender_kind !== 'guest').map((m: any) => m.id);
  if (ids.length) {
    await tx`UPDATE booking_messages SET read_by_guest_at = now() WHERE id = ANY(${ids}::uuid[]) AND read_by_guest_at IS NULL`;
  }
  return c.json({ messages: list });
}

async function promoValidate(tx: Tx, c: Context): Promise<Response> {
  const code = c.req.query('code');
  const slug = c.req.query('slug');
  const productId = c.req.query('productId');
  const subtotal = Number(c.req.query('subtotal') ?? 0);
  const currency = c.req.query('currency') ?? 'EUR';
  if (!code || !slug || !productId) return c.json({ error: 'code, slug, productId required' }, 400);
  const res = await tx`SELECT id FROM resellers WHERE slug = ${slug} AND status = 'approved' LIMIT 1`;
  if (!res[0]) return c.json({ error: 'storefront not found' }, 404);
  const prod = await tx`SELECT vendor_id FROM products WHERE id = ${productId} LIMIT 1`;
  if (!prod[0]) return c.json({ error: 'product not found' }, 404);
  // Mirror create_cart_booking's promo selection (validate-only, no redeem).
  const rows = await tx`
    SELECT discount_type, discount_value, currency FROM promo_codes pc
    WHERE pc.code = ${code} AND pc.active = true
      AND (pc.starts_at IS NULL OR pc.starts_at <= now())
      AND (pc.expires_at IS NULL OR pc.expires_at >= now())
      AND (pc.max_redemptions IS NULL OR pc.redeemed_count < pc.max_redemptions)
      AND (pc.scope = 'global'
           OR (pc.scope = 'reseller' AND pc.reseller_id = ${res[0].id})
           OR (pc.scope = 'vendor' AND pc.vendor_id = ${prod[0].vendor_id}))
    LIMIT 1
  `;
  if (!rows[0]) return c.json({ valid: false, message: 'invalid_code', discount: 0 });
  const p = rows[0];
  let discount = 0;
  if (p.discount_type === 'percent') {
    discount = Math.round(subtotal * Number(p.discount_value) / 100 * 100) / 100;
  } else {
    if (p.currency && p.currency !== currency) return c.json({ valid: false, message: 'currency_mismatch', discount: 0 });
    discount = Math.min(Number(p.discount_value), subtotal);
  }
  return c.json({ valid: true, message: 'ok', discount });
}

// ───────────────────────── write handlers ─────────────────────────

// Recompute one line's items against the published product (vendor base price;
// never trust client prices). Returns the RPC line or throws a guest-facing msg.
async function buildRpcLine(tx: Tx, line: any): Promise<any> {
  const productId = line.productId;
  const bookingDate = line.bookingDate;
  if (!productId) throw { code: 400, msg: 'line productId required' };
  if (!bookingDate || !DATE_RE.test(bookingDate)) throw { code: 400, msg: 'line bookingDate invalid' };
  const items = Array.isArray(line.items) ? line.items : [];
  if (items.length === 0) throw { code: 400, msg: 'line has no items' };

  const prod = await tx`
    SELECT p.id,
           COALESCE(json_agg(json_build_object('id', pc.id, 'label', pc.label, 'price', pc.price, 'currency', pc.currency))
                    FILTER (WHERE pc.id IS NOT NULL), '[]'::json) AS cats
    FROM products p JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN product_pricing_categories pc ON pc.product_id = p.id
    WHERE p.id = ${productId} AND p.status = 'published' AND v.status = 'approved'
    GROUP BY p.id LIMIT 1
  `;
  if (!prod[0]) throw { code: 404, msg: `product ${productId} not available` };
  const cats = new Map<string, any>();
  for (const cc of (prod[0].cats || [])) cats.set(cc.id, cc);

  const lineItems: any[] = [];
  let lineCurrency: string | null = null;
  for (const it of items) {
    const cat = it.pricingCategoryId ? cats.get(it.pricingCategoryId) : undefined;
    const qty = Number(it.quantity);
    if (!cat) throw { code: 400, msg: 'unknown pricing category in line' };
    if (!Number.isInteger(qty) || qty < 1) throw { code: 400, msg: 'invalid quantity' };
    lineCurrency = lineCurrency ?? cat.currency;
    if (lineCurrency !== cat.currency) throw { code: 400, msg: 'mixed currency in line' };
    lineItems.push({ pricing_category_id: it.pricingCategoryId, label: cat.label, unit_price: Number(cat.price), quantity: qty });
  }
  return { product_id: productId, booking_date: bookingDate, slot_time: (line.slotTime ?? null) || null, currency: lineCurrency, items: lineItems };
}

async function cartBook(tx: Tx, c: Context): Promise<Response> {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
  const slug = (body.slug ?? '').trim();
  const guest = body.guest ?? {};
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!slug) return c.json({ error: 'slug required' }, 400);
  if (lines.length === 0) return c.json({ error: 'empty cart' }, 400);
  const guestName = (guest.name ?? '').trim();
  const guestEmail = (guest.email ?? '').trim();
  if (!guestName) return c.json({ error: 'guest name required' }, 400);
  if (!EMAIL_RE.test(guestEmail)) return c.json({ error: 'valid guest email required' }, 400);

  const res = await tx`SELECT id FROM resellers WHERE slug = ${slug} AND status = 'approved' LIMIT 1`;
  if (!res[0]) return c.json({ error: 'storefront not found' }, 404);

  const rpcLines: any[] = [];
  let firstCurrency: string | null = null;
  for (const line of lines) {
    let rpcLine: any;
    try { rpcLine = await buildRpcLine(tx, line); }
    catch (e: any) { return c.json({ error: e?.msg ?? 'invalid line' }, e?.code ?? 400); }
    firstCurrency = firstCurrency ?? rpcLine.currency;
    if (firstCurrency !== rpcLine.currency) return c.json({ error: 'mixed currency cart' }, 400);
    rpcLines.push(rpcLine);
  }

  const guestJson = { name: guestName, email: guestEmail, phone: (guest.phone ?? '').trim() || null, notes: (guest.notes ?? '').trim() || null };
  const out = await tx`SELECT create_cart_booking(${slug}, ${(body.promoCode ?? '').trim() || null}, ${tx.json(guestJson)}, ${tx.json(rpcLines)}) AS cart`;
  return c.json({ cart: out[0].cart });
}

async function book(tx: Tx, c: Context): Promise<Response> {
  // Single-product book → route through create_cart_booking as a one-line cart.
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
  const slug = (body.slug ?? '').trim();
  const guest = body.guest ?? {};
  if (!body.productId) return c.json({ error: 'productId required' }, 400);
  if (!slug) return c.json({ error: 'slug required' }, 400);
  const guestName = (guest.name ?? '').trim();
  const guestEmail = (guest.email ?? '').trim();
  if (!guestName) return c.json({ error: 'guest name required' }, 400);
  if (!EMAIL_RE.test(guestEmail)) return c.json({ error: 'valid guest email required' }, 400);
  if (!Array.isArray(body.items) || body.items.length === 0) return c.json({ error: 'select at least one guest category' }, 400);

  const res = await tx`SELECT id FROM resellers WHERE slug = ${slug} AND status = 'approved' LIMIT 1`;
  if (!res[0]) return c.json({ error: 'storefront not found' }, 404);

  let rpcLine: any;
  try { rpcLine = await buildRpcLine(tx, { productId: body.productId, bookingDate: body.bookingDate, slotTime: body.slotTime, items: body.items }); }
  catch (e: any) { return c.json({ error: e?.msg ?? 'invalid booking' }, e?.code ?? 400); }

  const guestJson = { name: guestName, email: guestEmail, phone: (guest.phone ?? '').trim() || null, notes: (guest.notes ?? '').trim() || null };
  const out = await tx`SELECT create_cart_booking(${slug}, ${(body.promoCode ?? '').trim() || null}, ${tx.json(guestJson)}, ${tx.json([rpcLine])}) AS cart`;
  const ref = out[0]?.cart?.bookings?.[0]?.reference;
  if (!ref) return c.json({ error: 'booking_failed' }, 500);
  return c.json({ booking: { reference: ref } });
}

async function review(tx: Tx, c: Context): Promise<Response> {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
  const reference = (body.reference ?? '').trim();
  const rating = Number(body.rating);
  const comment = (body.comment ?? '').trim() || null;
  const guestName = (body.guest_name ?? '').trim();
  if (!reference) return c.json({ error: 'reference required' }, 400);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return c.json({ error: 'rating must be 1-5' }, 400);
  if (!guestName) return c.json({ error: 'guest_name required' }, 400);

  const bk = await tx`SELECT id, status, booking_date::text AS booking_date, product_id, vendor_id, reseller_id FROM bookings WHERE reference = ${reference} LIMIT 1`;
  if (!bk[0]) return c.json({ error: 'booking not found' }, 404);
  if (bk[0].status !== 'confirmed') return c.json({ error: 'booking must be confirmed to review' }, 400);
  const today = new Date().toISOString().slice(0, 10);
  if (bk[0].booking_date >= today) return c.json({ error: 'review available only after booking date' }, 400);
  const ex = await tx`SELECT id FROM reviews WHERE booking_id = ${bk[0].id} LIMIT 1`;
  if (ex[0]) return c.json({ error: 'review already exists for this booking' }, 409);

  const photos = Array.isArray(body.photo_urls)
    ? body.photo_urls.filter((u: any) => typeof u === 'string' && u.startsWith('https://')).slice(0, 4)
    : [];
  const ins = await tx`
    INSERT INTO reviews (booking_id, product_id, vendor_id, reseller_id, guest_name, rating, comment, photo_urls)
    VALUES (${bk[0].id}, ${bk[0].product_id}, ${bk[0].vendor_id}, ${bk[0].reseller_id}, ${guestName.slice(0, 80)}, ${rating}, ${comment ? comment.slice(0, 1000) : null}, ${photos})
    RETURNING id, rating, comment, guest_name, created_at, photo_urls, vendor_reply, vendor_replied_at
  `;
  return c.json({ review: ins[0] });
}

async function message(tx: Tx, c: Context): Promise<Response> {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
  const reference = (body.reference ?? '').trim();
  const text = (body.body ?? '').trim();
  const senderName = (body.sender_name ?? '').trim();
  if (!reference) return c.json({ error: 'reference required' }, 400);
  if (!text || text.length < 1 || text.length > 4000) return c.json({ error: 'message must be 1-4000 characters' }, 400);
  if (!senderName) return c.json({ error: 'sender_name required' }, 400);

  const bk = await tx`SELECT id, status FROM bookings WHERE reference = ${reference} LIMIT 1`;
  if (!bk[0]) return c.json({ error: 'booking not found' }, 404);
  if (bk[0].status === 'cancelled') return c.json({ error: 'this booking is cancelled' }, 400);
  const ins = await tx`
    INSERT INTO booking_messages (booking_id, sender_kind, sender_id, sender_name, body)
    VALUES (${bk[0].id}, 'guest', NULL, ${senderName.slice(0, 80)}, ${text})
    RETURNING id, sender_kind, sender_name, body, created_at
  `;
  return c.json({ message: ins[0] });
}

async function voucherCancel(tx: Tx, c: Context): Promise<Response> {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const reference = (body.reference ?? '').trim();
  if (!reference) return c.json({ error: 'reference required' }, 400);
  const bk = await tx`SELECT id, booking_date::text AS booking_date, status FROM bookings WHERE reference = ${reference} LIMIT 1`;
  if (!bk[0]) return c.json({ error: 'not found' }, 404);
  if (bk[0].status === 'cancelled') return c.json({ error: 'already_cancelled' }, 400);
  const today = new Date().toISOString().slice(0, 10);
  if (bk[0].booking_date <= today) return c.json({ error: 'too_late_self_cancel' }, 400);
  // bookings has no cancelled_at/cancellation_reason columns; status transition
  // alone fires bookings_notify → booking.cancelled email.
  await tx`UPDATE bookings SET status = 'cancelled' WHERE id = ${bk[0].id}`;
  return c.json({ ok: true });
}

async function voucherReschedule(tx: Tx, c: Context): Promise<Response> {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const reference = (body.reference ?? '').trim();
  const newDate = (body.newDate ?? '').trim();
  if (!reference || !newDate || !DATE_RE.test(newDate)) return c.json({ error: 'invalid_input' }, 400);
  const bk = await tx`SELECT id, booking_date::text AS booking_date, status FROM bookings WHERE reference = ${reference} LIMIT 1`;
  if (!bk[0]) return c.json({ error: 'not found' }, 404);
  if (bk[0].status === 'cancelled') return c.json({ error: 'cancelled' }, 400);
  const today = new Date().toISOString().slice(0, 10);
  if (bk[0].booking_date <= today) return c.json({ error: 'too_late_reschedule' }, 400);
  await tx`SELECT reschedule_booking(${bk[0].id}, ${newDate}::date, ${(body.reason ?? 'guest_self_reschedule').slice(0, 200)})`;
  return c.json({ ok: true });
}

// ───────────────────────── dispatch ─────────────────────────

export async function handleStorefrontApi(c: Context): Promise<Response> {
  const action = c.req.query('action') ?? '';
  const method = c.req.method;
  const needPost = (h: (tx: Tx, c: Context) => Promise<Response>) =>
    method === 'POST' ? h : (async (_tx: Tx, cc: Context) => cc.json({ error: 'POST required' }, 405));

  const routes: Record<string, (tx: Tx, c: Context) => Promise<Response>> = {
    catalog, product, reseller, availability, voucher, reviews, messages, promo: promoValidate,
    cart_voucher: cartVoucher,
    book: needPost(book),
    cart_book: needPost(cartBook),
    review: needPost(review),
    message: needPost(message),
    voucher_cancel: needPost(voucherCancel),
    voucher_reschedule: needPost(voucherReschedule),
  };
  const handler = routes[action];
  if (!handler) return c.json({ error: 'unknown action' }, 400);

  try {
    const adminId = await platformAdminId();
    return await withRequestContext({ userId: adminId, role: 'platform_admin' }, async (tx) => handler(tx, c));
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (BOOKING_ERR_RE.test(msg)) return c.json({ error: bookingErrorMessage(msg) }, 409);
    console.error('[storefront-api]', action, msg);
    return c.json({ error: 'internal_error' }, 500);
  }
}
