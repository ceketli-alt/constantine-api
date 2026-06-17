/**
 * Partner tekne takvim senkronu — /functions/v1/partner-calendar-sync + cron (her 10 dk)
 *
 * agency_only=true (dış/partner) + Google bağlı tekneler için freeBusy.query çağırır,
 * dolu aralıkları boat_busy_slots cache'ine yazar (boat başına tek transaction'da
 * full-replace: DELETE source='google' date>=bugün + INSERT). Acente paneli availability
 * endpoint'i bu cache'i bookings ile birleştirir → portal canlı müsaitlik gösterir.
 *
 * freeBusy event detayı dönmez (privacy) — "yalnızca müsait/meşgul" paylaşımıyla da çalışır.
 */
import type { Context } from 'hono';
import { sql } from './db.js';
import { requireAuth } from './middleware.js';
import { getAccessTokenForBoat, freeBusyQuery } from './google.js';
import { isoToLocalParts } from './google-calendar.js';

const TZ = 'Europe/Istanbul';
const HORIZON_DAYS = 60;

interface DayRow {
  date: string;   // YYYY-MM-DD (Istanbul lokal)
  start: string;  // HH:MM
  end: string;    // HH:MM
}

/** Lokal tarihe gün ekle — öğlen çapasıyla (DST-tarzı sınır bug'larından kaçınır). */
function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Bir UTC busy period'unu Istanbul-lokal gün satırlarına böler.
 * Gece yarısını aşanlar: [start,23:59] / [00:00,23:59] / [00:00,end].
 * end '00:00' ise son segment atlanır (boat_busy_slots CHECK end>start garantisi).
 */
export function busyPeriodToDayRows(startIso: string, endIso: string): DayRow[] {
  const s = isoToLocalParts(startIso, TZ);
  const e = isoToLocalParts(endIso, TZ);
  if (e.date < s.date || (e.date === s.date && e.time <= s.time)) return [];

  if (s.date === e.date) {
    return [{ date: s.date, start: s.time, end: e.time }];
  }

  const rows: DayRow[] = [{ date: s.date, start: s.time, end: '23:59' }];
  let cur = addDaysToDateStr(s.date, 1);
  while (cur < e.date) {
    rows.push({ date: cur, start: '00:00', end: '23:59' });
    cur = addDaysToDateStr(cur, 1);
  }
  if (e.time !== '00:00') {
    rows.push({ date: e.date, start: '00:00', end: e.time });
  }
  return rows;
}

export interface PartnerSyncResult {
  boats: number;
  synced: number;
  slots: number;
  errors: Array<{ boat_id: string; boat_name: string; error: string }>;
}

export async function runPartnerCalendarSync(boatIds?: string[]): Promise<PartnerSyncResult> {
  const boats = boatIds && boatIds.length > 0
    ? await sql`
        SELECT id, name, google_calendar_id FROM boats
        WHERE agency_only = true AND google_calendar_connected = true AND active = true
          AND id = ANY(${boatIds}::uuid[])
      `
    : await sql`
        SELECT id, name, google_calendar_id FROM boats
        WHERE agency_only = true AND google_calendar_connected = true AND active = true
      `;

  const result: PartnerSyncResult = { boats: boats.length, synced: 0, slots: 0, errors: [] };

  // Istanbul sabit UTC+3 (2016'dan beri DST yok) — bugünün 00:00'ı.
  // timeMin bugün başı: günün geçmiş blokları da gece yarısına dek görünür kalsın.
  const todayIst = isoToLocalParts(new Date().toISOString(), TZ).date;
  const timeMin = new Date(`${todayIst}T00:00:00+03:00`).toISOString();
  const timeMax = new Date(Date.now() + HORIZON_DAYS * 86400_000).toISOString();

  // Sıralı işle — paralel getAccessTokenForBoat refresh'leri birbirini ezebilir (B5 dersi).
  for (const boat of boats as any[]) {
    try {
      const accessToken = await getAccessTokenForBoat(boat.id);
      const busy = await freeBusyQuery({
        accessToken,
        calendarId: boat.google_calendar_id || 'primary',
        timeMin,
        timeMax,
        timeZone: TZ,
      });
      const rows = busy.flatMap((p) => busyPeriodToDayRows(p.start, p.end));

      await sql.begin(async (tx) => {
        await tx`
          DELETE FROM boat_busy_slots
          WHERE boat_id = ${boat.id} AND source = 'google' AND date >= CURRENT_DATE
        `;
        for (const r of rows) {
          await tx`
            INSERT INTO boat_busy_slots (boat_id, date, start_time, end_time, source, synced_at)
            VALUES (${boat.id}, ${r.date}::date, ${r.start}::time, ${r.end}::time, 'google', now())
          `;
        }
        await tx`UPDATE boats SET google_last_sync_at = now() WHERE id = ${boat.id}`;
      });

      result.synced++;
      result.slots += rows.length;
    } catch (err: any) {
      console.error(`[partner-sync] ${boat.name} failed:`, err?.message);
      result.errors.push({ boat_id: boat.id, boat_name: boat.name, error: err?.message ?? String(err) });
    }
  }

  // Son çalışma kaydı — hem cron hem manuel tetik buraya yazar
  try {
    await sql`
      INSERT INTO app_config (key, value)
      VALUES ('partner.cron.last_calendar_sync', ${sql.json({
        boats: result.boats,
        synced: result.synced,
        slots: result.slots,
        errors: result.errors.length,
        at: new Date().toISOString(),
      })})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  } catch (e: any) {
    console.warn('[partner-sync] last_run write skipped:', e?.message);
  }

  return result;
}

/** Manuel tetik — Settings → Tekneler "Şimdi senkronla". super_admin gerek. */
export async function handlePartnerCalendarSync(c: Context): Promise<Response> {
  const auth = requireAuth(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);

  const prof = await sql`SELECT role::text AS role FROM profiles WHERE id = ${auth.userId}`;
  if (prof[0]?.role !== 'super_admin') return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => ({})) as { boat_ids?: string[] };
  let boatIds: string[] | undefined;
  if (body.boat_ids !== undefined) {
    if (!Array.isArray(body.boat_ids) || body.boat_ids.some((b) => typeof b !== 'string' || !/^[0-9a-f-]{36}$/i.test(b))) {
      return c.json({ error: 'boat_ids must be an array of uuids' }, 400);
    }
    boatIds = body.boat_ids;
  }

  const result = await runPartnerCalendarSync(boatIds);
  return c.json(result);
}
