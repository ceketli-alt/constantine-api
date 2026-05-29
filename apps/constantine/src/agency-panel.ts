/**
 * /functions/v1/agency-panel — Acente token-bazlı public view (login yok)
 *
 * Endpoints (?action=...):
 *   GET  ?action=boats                                  → aktif tekne listesi
 *   GET  ?action=boat-detail&boat_id=<>                 → tek tekne + galeri
 *   GET  ?action=availability&boat_id=<>&from=<>&to=<>  → busy_blocks (rezervasyonlar)
 *   POST ?action=request                                → rezervasyon isteği yarat
 *
 * Auth: ?token=<32-char URL-safe>. Hiçbir kullanıcı login yok.
 * Headers: X-Robots-Tag: noindex
 */
import type { Context } from 'hono';
import { sql } from './db.js';

// ============================================================
// Token validation
// ============================================================

interface AgencyContext {
  agency: {
    id: string;
    name: string;
    contact_name: string | null;
    phone: string | null;
  };
  token: {
    id: string;
    token: string;
  };
}

async function validateAgencyToken(token: string | null): Promise<AgencyContext | null> {
  if (!token || typeof token !== 'string') return null;
  if (token.length < 30 || token.length > 36) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;

  const rows = await sql`
    SELECT t.id AS token_id, t.token, t.expires_at,
           a.id AS agency_id, a.name AS agency_name,
           a.contact_name, a.phone
    FROM agency_tokens t
    INNER JOIN agencies a ON a.id = t.agency_id
    WHERE t.token = ${token}
      AND t.active = true
      AND a.active = true
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) return null;

  // Fire-and-forget atomic increment
  sql`SELECT increment_agency_token_view(${r.token_id}::uuid)`.catch((e) => {
    console.warn('[agency-panel] increment_agency_token_view failed:', e.message);
  });

  return {
    agency: {
      id: r.agency_id,
      name: r.agency_name,
      contact_name: r.contact_name,
      phone: r.phone,
    },
    token: { id: r.token_id, token: r.token },
  };
}

// ============================================================
// Time helpers
// ============================================================

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function minutesToHHMM(mins: number): string {
  const wrapped = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function addHours(timeStr: string, hours: number): string {
  return minutesToHHMM(timeToMinutes(timeStr) + Math.round(hours * 60));
}

function endMinutesUnwrapped(timeStr: string, hours: number): number {
  return timeToMinutes(timeStr) + Math.round(hours * 60);
}

function rangesOverlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// ============================================================
// Handlers
// ============================================================

async function handleBoats(ctx: AgencyContext) {
  const data = await sql`
    SELECT id, name, image_url, capacity, short_description,
           short_description_translations, default_duration_hours
    FROM boats
    WHERE active = true
    ORDER BY name
  `;
  return { boats: data, agency: { name: ctx.agency.name } };
}

async function handleBoatDetail(boatId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(boatId)) {
    return { status: 400, body: { error: 'invalid boat_id' } };
  }
  const boatRows = await sql`
    SELECT id, name, image_url, capacity, short_description,
           short_description_translations, default_duration_hours, active
    FROM boats WHERE id = ${boatId}
  `;
  const boat = boatRows[0];
  if (!boat || !boat.active) {
    return { status: 404, body: { error: 'boat not found or inactive' } };
  }
  const photos = await sql`
    SELECT id, url, caption, sort_order
    FROM boat_photos
    WHERE boat_id = ${boatId}
    ORDER BY sort_order ASC
  `;
  return {
    status: 200,
    body: {
      boat: {
        id: boat.id,
        name: boat.name,
        image_url: boat.image_url,
        capacity: boat.capacity,
        short_description: boat.short_description,
        short_description_translations: boat.short_description_translations ?? {},
        default_duration_hours: boat.default_duration_hours,
        photos,
      },
    },
  };
}

async function handleAvailability(boatId: string, fromStr: string, toStr: string) {
  if (!boatId || !fromStr || !toStr) {
    return { status: 400, body: { error: 'boat_id, from, to query params required' } };
  }
  if (!/^[0-9a-f-]{36}$/i.test(boatId)) {
    return { status: 400, body: { error: 'invalid boat_id format' } };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
    return { status: 400, body: { error: 'invalid date format (YYYY-MM-DD)' } };
  }
  if (fromStr > toStr) {
    return { status: 400, body: { error: 'from must be <= to' } };
  }
  const days = (new Date(toStr).getTime() - new Date(fromStr).getTime()) / 86400000;
  if (days < 0 || days > 35) {
    return { status: 400, body: { error: 'date range invalid (0-35 days)' } };
  }

  const boatRows = await sql`SELECT id, active FROM boats WHERE id = ${boatId}`;
  if (!boatRows[0] || !boatRows[0].active) {
    return { status: 404, body: { error: 'boat not found or inactive' } };
  }

  const bookings = await sql`
    SELECT date::text AS date, start_time::text AS start_time, duration_hours
    FROM bookings
    WHERE boat_id = ${boatId}
      AND date >= ${fromStr}::date
      AND date <= ${toStr}::date
      AND status != 'cancelled'
  `;

  const byDate: Record<string, Array<{ start_time: string; end_time: string }>> = {};
  for (const b of bookings) {
    if (!b.date) continue;
    const dateKey = String(b.date).slice(0, 10);
    let start: string;
    let end: string;
    if (b.start_time) {
      start = String(b.start_time).slice(0, 5);
      const dur = Number(b.duration_hours) || 4;
      end = addHours(start, dur);
    } else {
      start = '00:00';
      end = '23:59';
    }
    if (!byDate[dateKey]) byDate[dateKey] = [];
    byDate[dateKey].push({ start_time: start, end_time: end });
  }

  const availability = Object.keys(byDate)
    .sort()
    .map((date) => ({
      date,
      busy_blocks: byDate[date]!.sort((x, y) => x.start_time.localeCompare(y.start_time)),
    }));

  return { status: 200, body: { availability } };
}

interface RequestBody {
  boat_id?: unknown;
  date?: unknown;
  start_time?: unknown;
  duration_hours?: unknown;
  guest_count?: unknown;
  guest_name?: unknown;
  notes?: unknown;
}

async function handleRequest(ctx: AgencyContext, body: unknown) {
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'request body must be a JSON object' } };
  }
  const b = body as RequestBody;

  if (typeof b.boat_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.boat_id)) {
    return { status: 400, body: { error: 'invalid boat_id' } };
  }
  if (typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
    return { status: 400, body: { error: 'invalid date (YYYY-MM-DD)' } };
  }
  const reqDate = new Date(b.date + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (reqDate.getTime() < today.getTime()) {
    return { status: 400, body: { error: 'date in past' } };
  }
  if (typeof b.start_time !== 'string' || !/^\d{2}:\d{2}(:\d{2})?$/.test(b.start_time)) {
    return { status: 400, body: { error: 'invalid start_time (HH:MM)' } };
  }
  const startTime = b.start_time.slice(0, 5);
  const startH = Number(startTime.split(':')[0]);
  if (startH < 6 || startH > 23) {
    return { status: 400, body: { error: 'start_time must be 06:00-23:00' } };
  }
  const dur = Number(b.duration_hours);
  if (!Number.isFinite(dur) || dur < 0.5 || dur > 12) {
    return { status: 400, body: { error: 'duration_hours must be between 0.5 and 12' } };
  }
  const guests = Number(b.guest_count);
  if (!Number.isInteger(guests) || guests < 1) {
    return { status: 400, body: { error: 'guest_count must be positive integer' } };
  }
  const guestName = typeof b.guest_name === 'string' ? b.guest_name.trim().slice(0, 200) : null;
  const notes = typeof b.notes === 'string' ? b.notes.trim().slice(0, 1000) : null;

  const boatRows = await sql`
    SELECT id, capacity, active FROM boats WHERE id = ${b.boat_id}
  `;
  const boat = boatRows[0];
  if (!boat || !boat.active) {
    return { status: 404, body: { error: 'boat not found or inactive' } };
  }
  if (guests > boat.capacity) {
    return { status: 400, body: { error: `guest_count (${guests}) exceeds boat capacity (${boat.capacity})` } };
  }

  const startMin = timeToMinutes(startTime);
  const endMin = endMinutesUnwrapped(startTime, dur);

  const insertRows = await sql`
    INSERT INTO agency_requests (
      agency_id, token_id, boat_id, date, start_time,
      duration_hours, guest_count, guest_name, notes
    ) VALUES (
      ${ctx.agency.id}::uuid, ${ctx.token.id}::uuid, ${b.boat_id}::uuid,
      ${b.date}::date, ${startTime}::time,
      ${dur}, ${guests}, ${guestName}, ${notes}
    )
    RETURNING id
  `;
  const insertedId = insertRows[0]?.id;
  if (!insertedId) {
    return { status: 500, body: { error: 'failed to create request' } };
  }

  // Overlap detection (yeni eklediğimiz hariç)
  const overlap = await checkOverlap(b.boat_id, b.date, startMin, endMin, insertedId);

  return { status: 200, body: { request_id: insertedId, overlap } };
}

async function checkOverlap(
  boatId: string,
  date: string,
  startMin: number,
  endMin: number,
  excludeRequestId?: string,
): Promise<boolean> {
  const bks = await sql`
    SELECT start_time::text AS start_time, duration_hours
    FROM bookings
    WHERE boat_id = ${boatId}::uuid AND date = ${date}::date
      AND status != 'cancelled'
  `;
  for (const bk of bks) {
    if (!bk.start_time) return true;
    const bkStartMin = timeToMinutes(String(bk.start_time).slice(0, 5));
    const bkEndMin = bkStartMin + Math.round((Number(bk.duration_hours) || 4) * 60);
    if (rangesOverlapMinutes(startMin, endMin, bkStartMin, bkEndMin)) return true;
  }

  const reqs = excludeRequestId
    ? await sql`
        SELECT id, start_time::text AS start_time, duration_hours
        FROM agency_requests
        WHERE boat_id = ${boatId}::uuid AND date = ${date}::date AND status = 'pending'
          AND id != ${excludeRequestId}::uuid
      `
    : await sql`
        SELECT id, start_time::text AS start_time, duration_hours
        FROM agency_requests
        WHERE boat_id = ${boatId}::uuid AND date = ${date}::date AND status = 'pending'
      `;
  for (const r of reqs) {
    const rStartMin = timeToMinutes(String(r.start_time).slice(0, 5));
    const rEndMin = rStartMin + Math.round(Number(r.duration_hours) * 60);
    if (rangesOverlapMinutes(startMin, endMin, rStartMin, rEndMin)) return true;
  }

  return false;
}

// ============================================================
// Router
// ============================================================

export async function handleAgencyPanel(c: Context): Promise<Response> {
  // X-Robots-Tag header (her response için)
  c.header('X-Robots-Tag', 'noindex, nofollow');

  const token = c.req.query('token') ?? null;
  const action = c.req.query('action') ?? null;

  if (!token) return c.json({ error: 'token query param required' }, 401);
  if (!action) return c.json({ error: 'action query param required' }, 400);

  const ctx = await validateAgencyToken(token);
  if (!ctx) return c.json({ error: 'invalid or expired token' }, 401);

  try {
    switch (action) {
      case 'boats': {
        const result = await handleBoats(ctx);
        return c.json(result);
      }
      case 'boat-detail': {
        const boatId = c.req.query('boat_id') ?? '';
        const result = await handleBoatDetail(boatId);
        return c.json(result.body, result.status as any);
      }
      case 'availability': {
        const boatId = c.req.query('boat_id') ?? '';
        const from = c.req.query('from') ?? '';
        const to = c.req.query('to') ?? '';
        const result = await handleAvailability(boatId, from, to);
        return c.json(result.body, result.status as any);
      }
      case 'request': {
        if (c.req.method !== 'POST') {
          return c.json({ error: 'request action requires POST' }, 405);
        }
        let body: unknown;
        try { body = await c.req.json(); }
        catch { return c.json({ error: 'invalid JSON' }, 400); }
        const result = await handleRequest(ctx, body);
        return c.json(result.body, result.status as any);
      }
      default:
        return c.json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e: any) {
    console.error('[agency-panel] unhandled:', e);
    return c.json({ error: 'internal_error', message: e?.message }, 500);
  }
}
