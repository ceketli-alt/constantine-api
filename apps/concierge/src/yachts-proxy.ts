/**
 * yachts-proxy — /functions/v1/yachts-api
 *
 * CC storefront "Private Yachts" sekmesinin veri kaynağı. Constantine'in
 * agency-panel API'sine sunucu tarafında token enjekte ederek proxy'ler:
 *   - Token tarayıcıya sızmaz (storefront public — token'ı bundle'a koyamayız)
 *   - CORS sorunu yok (storefront zaten api-cc origin'ine izinli)
 *   - Talepler Constantine tarafında "Concierge Connect" acentesi olarak düşer
 *
 * Aksiyonlar (whitelist): boats, boat-detail, availability, search (GET) +
 * request, concierge (POST). Üstkaynak aynı sunucuda → localhost:4001 (env override).
 */
import type { Context } from 'hono';

const UPSTREAM = process.env.CONSTANTINE_AGENCY_API_URL
  || 'http://127.0.0.1:4001/functions/v1/agency-panel';
const TOKEN = process.env.CONSTANTINE_YACHTS_TOKEN || '';

const GET_ACTIONS = new Set(['boats', 'boat-detail', 'availability', 'search']);
const POST_ACTIONS = new Set(['request', 'concierge']);

export async function handleYachtsProxy(c: Context): Promise<Response> {
  if (!TOKEN) {
    return c.json({ error: 'yachts_not_configured', message: 'CONSTANTINE_YACHTS_TOKEN env eksik' }, 503);
  }

  const action = c.req.query('action') ?? '';
  const isPost = POST_ACTIONS.has(action);
  if (!GET_ACTIONS.has(action) && !isPost) {
    return c.json({ error: `unknown action: ${action}` }, 400);
  }
  if (isPost && c.req.method !== 'POST') {
    return c.json({ error: `${action} action requires POST` }, 405);
  }

  const url = new URL(UPSTREAM);
  url.searchParams.set('token', TOKEN);
  url.searchParams.set('action', action);

  // Yalnız beklenen parametreler iletilir (token override / param smuggling engellenir)
  if (action === 'boat-detail' || action === 'availability') {
    const boatId = c.req.query('boat_id') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(boatId)) return c.json({ error: 'invalid boat_id' }, 400);
    url.searchParams.set('boat_id', boatId);
  }
  if (action === 'availability') {
    const from = c.req.query('from') ?? '';
    const to = c.req.query('to') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return c.json({ error: 'invalid date format (YYYY-MM-DD)' }, 400);
    }
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
  }
  if (action === 'search') {
    const date = c.req.query('date') ?? '';
    const startTime = c.req.query('start_time') ?? '';
    const duration = c.req.query('duration_hours') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date (YYYY-MM-DD)' }, 400);
    if (!/^\d{2}:\d{2}$/.test(startTime)) return c.json({ error: 'invalid start_time (HH:MM)' }, 400);
    if (!/^\d+(\.\d+)?$/.test(duration)) return c.json({ error: 'invalid duration_hours' }, 400);
    url.searchParams.set('date', date);
    url.searchParams.set('start_time', startTime);
    url.searchParams.set('duration_hours', duration);
  }

  try {
    let upstreamRes: Response;
    if (isPost) {
      // request + concierge: gövdeyi olduğu gibi ilet (token query'den enjekte edilir)
      const body = await c.req.text();
      upstreamRes = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } else {
      upstreamRes = await fetch(url.toString());
    }
    const json = await upstreamRes.json().catch(() => ({ error: 'upstream_invalid_json' }));
    return c.json(json as Record<string, unknown>, upstreamRes.status as any);
  } catch (e: any) {
    console.error('[yachts-proxy] upstream error:', e?.message);
    return c.json({ error: 'upstream_unreachable', message: e?.message }, 502);
  }
}
