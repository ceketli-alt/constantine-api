/**
 * Google Calendar pull + push handlers — /functions/v1/google-calendar-{pull,push}
 * Mert'in Deno function'larının Node/Hono port'u.
 */
import type { Context } from 'hono';
import { sql } from './db.js';
import { requireAuth } from './middleware.js';
import {
  getAccessTokenForBoat,
  listCalendarEventsAll,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from './google.js';

export function isoToLocalParts(iso: string, tz: string): { date: string; time: string } {
  const d = new Date(iso);
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(d).reduce<Record<string, string>>((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  } catch {
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
}

export async function handleCalendarPull(c: Context): Promise<Response> {
  const auth = requireAuth(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => ({})) as { boat_ids?: string[]; days_back?: number; days_forward?: number };
  const daysBack = Math.min(Math.max(body.days_back ?? 7, 0), 90);
  const daysForward = Math.min(Math.max(body.days_forward ?? 30, 1), 180);

  // Authz: super_admin tüm bağlı tekneleri, partner sadece kendi atandığı
  const profRows = await sql`SELECT role::text AS role FROM profiles WHERE id = ${auth.userId}`;
  const role = profRows[0]?.role;
  const isSuper = role === 'super_admin';

  let allowedIds: string[] | null = null;
  if (body.boat_ids && body.boat_ids.length > 0) {
    if (!isSuper) {
      // Her tekne için partner assignment kontrol
      for (const bid of body.boat_ids) {
        const a = await sql`SELECT 1 FROM boat_assignments WHERE user_id = ${auth.userId} AND boat_id = ${bid} LIMIT 1`;
        if (a.length === 0) return c.json({ error: 'forbidden', boat_id: bid }, 403);
      }
    }
    allowedIds = body.boat_ids;
  } else if (!isSuper) {
    const rows = await sql`SELECT boat_id FROM boat_assignments WHERE user_id = ${auth.userId}`;
    allowedIds = rows.map((r: any) => r.boat_id);
    if (allowedIds!.length === 0) return c.json({ events: [], note: 'erişilebilir tekne yok' });
  }

  let boatsQuery;
  if (allowedIds && allowedIds.length > 0) {
    boatsQuery = sql`
      SELECT id, name, google_calendar_id FROM boats
      WHERE google_calendar_connected = true AND active = true
        AND id = ANY(${allowedIds}::uuid[])
    `;
  } else {
    boatsQuery = sql`
      SELECT id, name, google_calendar_id FROM boats
      WHERE google_calendar_connected = true AND active = true
    `;
  }
  const boats = await boatsQuery;
  if (boats.length === 0) return c.json({ events: [], note: 'Bağlı tekne yok' });

  const now = new Date();
  const timeMin = new Date(now.getTime() - daysBack * 86400_000).toISOString();
  const timeMax = new Date(now.getTime() + daysForward * 86400_000).toISOString();
  const TZ = 'Europe/Istanbul';

  const existing = await sql`SELECT google_event_id, google_calendar_id FROM bookings WHERE google_event_id IS NOT NULL`;
  const existingSet = new Set(existing.map((r: any) => `${r.google_calendar_id}::${r.google_event_id}`));

  const allPreviews: any[] = [];
  const failedBoats: any[] = [];
  const truncatedBoats: any[] = [];  // events.list page-cap'e takıldı → uzak-gelecek event'ler eksik olabilir

  // Backend B5 fix: token resolve race — Promise.all içinde paralel getAccessTokenForBoat
  // çağrıları aynı boat için yapılırsa (örn. shared id veya idempotent re-entry) iki refresh
  // birbirini ezerdi. Önce sequential token resolve, sonra parallel event fetch.
  const tokensByBoat = new Map<string, string>();
  for (const boat of boats) {
    try {
      tokensByBoat.set(boat.id, await getAccessTokenForBoat(boat.id));
    } catch (err: any) {
      console.error(`token resolve failed for boat ${boat.name}:`, err);
      failedBoats.push({ boat_id: boat.id, boat_name: boat.name, error: err?.message ?? String(err) });
    }
  }

  await Promise.all(boats.map(async (boat: any) => {
    const accessToken = tokensByBoat.get(boat.id);
    if (!accessToken) return; // token resolve fail — failedBoats'a yukarıda eklendi
    const calId = boat.google_calendar_id || 'primary';
    try {
      // Sayfalı oku (nextPageToken) — tek-sayfa 250 cap'i uzak-gelecek event'leri sessizce düşürürdü.
      const { events, truncated } = await listCalendarEventsAll({ accessToken, calendarId: calId, timeMin, timeMax });
      if (truncated) truncatedBoats.push({ boat_id: boat.id, boat_name: boat.name });
      for (const ev of events) {
        if (ev.status === 'cancelled') continue;
        const startIso = ev.start.dateTime ?? (ev.start.date ? `${ev.start.date}T00:00:00Z` : null);
        const endIso = ev.end.dateTime ?? (ev.end.date ? `${ev.end.date}T00:00:00Z` : null);
        if (!startIso || !endIso) continue;
        const tz = ev.start.timeZone ?? TZ;
        const startParts = isoToLocalParts(startIso, tz);
        const isAllDay = !ev.start.dateTime;
        const durationMs = new Date(endIso).getTime() - new Date(startIso).getTime();
        const durationHours = isAllDay ? null : Math.round((durationMs / 3_600_000) * 100) / 100;
        allPreviews.push({
          google_event_id: ev.id,
          google_calendar_id: calId,
          boat_id: boat.id,
          boat_name: boat.name,
          summary: ev.summary ?? '(başlıksız)',
          description: ev.description ?? null,
          start_iso: startIso,
          end_iso: endIso,
          date: startParts.date,
          start_time: isAllDay ? null : startParts.time,
          duration_hours: durationHours,
          status: ev.status ?? 'confirmed',
          html_link: ev.htmlLink ?? null,
          already_imported: existingSet.has(`${calId}::${ev.id}`),
        });
      }
      await sql`UPDATE boats SET google_last_sync_at = now() WHERE id = ${boat.id}`;
    } catch (err: any) {
      console.error(`pull failed for boat ${boat.name}:`, err);
      failedBoats.push({ boat_id: boat.id, boat_name: boat.name, error: err.message ?? String(err) });
    }
  }));

  allPreviews.sort((a, b) => a.start_iso.localeCompare(b.start_iso));
  return c.json({ events: allPreviews, failed_boats: failedBoats, truncated_boats: truncatedBoats });
}

/**
 * handleCalendarBackfill — admin tool: tüm `google_event_id IS NULL` bookingleri
 * sırayla Google Calendar'a push eder. Sadece bağlı tekneler. super_admin gerek.
 * Body: { dry_run?: boolean, date_from?: 'yyyy-MM-dd' }
 */
export async function handleCalendarBackfill(c: Context): Promise<Response> {
  const auth = requireAuth(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);

  const prof = await sql`SELECT role::text AS role FROM profiles WHERE id = ${auth.userId}`;
  if (prof[0]?.role !== 'super_admin') return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => ({})) as { dry_run?: boolean; date_from?: string };

  const boats = await sql`SELECT id FROM boats WHERE google_calendar_connected = true AND active = true`;
  const connectedIds = boats.map((b: any) => b.id);
  if (connectedIds.length === 0) return c.json({ note: 'no connected boats', processed: 0 });

  const dateFromFilter = body.date_from ?? '1970-01-01';
  const rows = await sql`
    SELECT b.id, b.boat_id, b.date, b.start_time, b.duration_hours, b.guest_name, b.contact,
           b.adult, b.child, b.infant, b.notes,
           bo.google_calendar_id AS boat_cal_id, bo.name AS boat_name,
           ch.name AS channel_name
    FROM bookings b
    JOIN boats bo ON bo.id = b.boat_id
    LEFT JOIN channels ch ON ch.id = b.channel_id
    WHERE b.google_event_id IS NULL
      AND b.status != 'cancelled'
      AND b.approval_status != 'rejected'
      AND b.date >= ${dateFromFilter}
      AND b.boat_id = ANY(${connectedIds}::uuid[])
    ORDER BY b.date DESC
  `;

  if (body.dry_run) {
    return c.json({
      would_push: rows.length,
      sample: rows.slice(0, 5).map((r: any) => ({ id: r.id, date: String(r.date).slice(0,10), boat: r.boat_name, guest: r.guest_name })),
    });
  }

  let created = 0, failed = 0;
  const errors: any[] = [];

  for (const bk of rows as any[]) {
    try {
      const datePart = (bk.date instanceof Date) ? bk.date.toISOString().slice(0, 10) : String(bk.date).slice(0, 10);
      const timePart = (bk.start_time && String(bk.start_time).slice(0, 8)) || '12:00:00';
      const start = new Date(`${datePart}T${timePart}`);
      if (Number.isNaN(start.getTime())) {
        failed++; errors.push({ id: bk.id, reason: 'invalid_date', date: String(bk.date) }); continue;
      }
      const dur = Number(bk.duration_hours || 2);
      const end = new Date(start.getTime() + dur * 3600_000);
      const adult = Number(bk.adult || 0), child = Number(bk.child || 0), infant = Number(bk.infant || 0);
      const channelPrefix = bk.channel_name ? `[${bk.channel_name}] ` : '';
      const event = {
        summary: `${channelPrefix}${bk.guest_name || '(misafir)'}`,
        description: [
          `Misafir: ${bk.guest_name || ''}`,
          bk.contact ? `İletişim: ${bk.contact}` : '',
          `Kişi: ${adult}A/${child}C/${infant}I`,
          bk.notes ? `Not: ${bk.notes}` : '',
        ].filter(Boolean).join('\n'),
        start: { dateTime: start.toISOString(), timeZone: 'Europe/Istanbul' },
        end: { dateTime: end.toISOString(), timeZone: 'Europe/Istanbul' },
      };
      const calId = bk.boat_cal_id || 'primary';
      const accessToken = await getAccessTokenForBoat(bk.boat_id);
      const { id: googleId } = await createCalendarEvent({ accessToken, calendarId: calId, event });
      await sql`
        UPDATE bookings
        SET google_event_id = ${googleId}, google_calendar_id = ${calId},
            google_synced_at = now(), google_sync_source = 'pushed'
        WHERE id = ${bk.id}
      `;
      created++;
    } catch (err: any) {
      failed++;
      errors.push({ id: bk.id, guest: bk.guest_name, reason: err?.message ?? String(err) });
    }
  }

  return c.json({ processed: rows.length, created, failed, errors: errors.slice(0, 20) });
}

interface ImportRow {
  google_event_id: string;
  google_calendar_id: string;
  boat_id: string;
  date: string;
  start_time: string | null;
  duration_hours: number | null;
  guest_name: string;
  contact: string | null;
  channel_id: string;
  product_id: string;
  package_id: string;
  our_share: number;
  total_price: number;
  adult: number;
  child: number;
  infant: number;
  notes: string | null;
}

export async function handleCalendarImport(c: Context): Promise<Response> {
  const auth = requireAuth(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);

  // Authz: super_admin / partner / accountant
  const profRows = await sql`SELECT role::text AS role FROM profiles WHERE id = ${auth.userId}`;
  const role = profRows[0]?.role;
  if (!role || !['super_admin', 'partner', 'accountant'].includes(role)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const isSuper = role === 'super_admin';

  const body = await c.req.json().catch(() => ({})) as { imports?: ImportRow[] };
  if (!body.imports || !Array.isArray(body.imports) || body.imports.length === 0) {
    return c.json({ error: 'imports required' }, 400);
  }

  // SEC-5: Each row's boat_id must be manageable. Partner → boat_assignments check.
  // super_admin tüm tekneleri yönetebilir.
  const checkedBoatIds = new Set<string>();
  for (const row of body.imports) {
    if (!row.boat_id || checkedBoatIds.has(row.boat_id)) continue;
    if (!isSuper) {
      const a = await sql`SELECT 1 FROM boat_assignments WHERE user_id = ${auth.userId} AND boat_id = ${row.boat_id} LIMIT 1`;
      if (a.length === 0) return c.json({ error: 'forbidden', boat_id: row.boat_id }, 403);
    }
    checkedBoatIds.add(row.boat_id);
  }

  const created: string[] = [];
  const failed: Array<{ event_id: string; error: string }> = [];

  for (const row of body.imports) {
    try {
      // Aynı google_event_id daha önce kaydedildiyse skip
      const dup = await sql`
        SELECT id FROM bookings
        WHERE google_calendar_id = ${row.google_calendar_id}
          AND google_event_id = ${row.google_event_id}
        LIMIT 1
      `;
      if (dup.length > 0) {
        failed.push({ event_id: row.google_event_id, error: 'zaten kayıtlı' });
        continue;
      }

      const inserted = await sql`
        INSERT INTO bookings (
          date, guest_name, contact,
          adult, child, infant,
          product_id, channel_id, package_id, boat_id,
          start_time, duration_hours,
          our_share, total_price,
          status, payment_status, notes,
          created_by, approval_status, approved_by, approved_at,
          google_event_id, google_calendar_id, google_synced_at, google_sync_source
        ) VALUES (
          ${row.date}, ${row.guest_name || '(takvimden)'}, ${row.contact},
          ${row.adult || 1}, ${row.child || 0}, ${row.infant || 0},
          ${row.product_id}, ${row.channel_id}, ${row.package_id}, ${row.boat_id},
          ${row.start_time}, ${row.duration_hours},
          ${row.our_share || 0}, ${row.total_price || 0},
          'confirmed', 'pending', ${row.notes},
          ${auth.userId}, 'approved', ${auth.userId}, now(),
          ${row.google_event_id}, ${row.google_calendar_id}, now(), 'pulled'
        )
        RETURNING id
      `;
      const newId = inserted[0]?.id;
      if (!newId) throw new Error('insert returned no id');
      created.push(newId);
    } catch (err: any) {
      failed.push({ event_id: row.google_event_id, error: err?.message ?? String(err) });
    }
  }

  return c.json({ created, failed });
}

export async function handleCalendarPush(c: Context): Promise<Response> {
  const auth = requireAuth(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => ({})) as {
    booking_id?: string;
    action?: 'create' | 'update' | 'delete';
  };
  if (!body.booking_id || !body.action) return c.json({ error: 'booking_id + action required' }, 400);

  const rows = await sql`
    SELECT b.id, b.boat_id, b.date, b.start_time, b.duration_hours, b.guest_name, b.contact,
           b.adult, b.child, b.infant, b.notes, b.google_event_id, b.google_calendar_id,
           bo.google_calendar_id AS boat_cal_id, bo.name AS boat_name,
           bo.google_calendar_connected AS boat_connected,
           ch.name AS channel_name
    FROM bookings b
    JOIN boats bo ON bo.id = b.boat_id
    LEFT JOIN channels ch ON ch.id = b.channel_id
    WHERE b.id = ${body.booking_id}
  `;
  const bk = rows[0];
  if (!bk) return c.json({ error: 'booking_not_found' }, 404);
  if (!bk.boat_id) return c.json({ error: 'no_boat' }, 400);

  // Tekne Google Calendar'a bağlı değilse sessizce skip et — frontend `skipped` bekliyor.
  // Aksi halde getAccessTokenForBoat throw eder, 500 olur, kullanıcıya gereksiz hata gösterilir.
  if (!bk.boat_connected) {
    return c.json({ skipped: 'boat_not_connected', boat_id: bk.boat_id, boat_name: bk.boat_name });
  }

  const calId = bk.boat_cal_id || 'primary';
  let accessToken: string;
  try {
    accessToken = await getAccessTokenForBoat(bk.boat_id);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    // Credential satırı eksik veya refresh token revoke — sessizce skip / friendly mesaj.
    if (msg.includes('Google bağlantısı yok')) {
      return c.json({ skipped: 'boat_credentials_missing', boat_id: bk.boat_id, boat_name: bk.boat_name });
    }
    // OAuth expire / revoke — super_admin'lere idempotent bildirim, 200 friendly response.
    if (msg.includes('refresh failed') || msg.includes('invalid_grant')) {
      try {
        const dedupeKey = `google_oauth_expired:${bk.boat_id}`;
        await sql`
          INSERT INTO notifications (user_id, boat_id, type, title, body, link, dedupe_key)
          SELECT p.id, ${bk.boat_id}, 'google_oauth_expired',
                 ${`⚠ ${bk.boat_name || 'Tekne'} için Google bağlantısı koptu`},
                 'Refresh token revoke / expire olmuş; tekne ayarlarından yeniden bağlanmanız gerekiyor.',
                 '/settings',
                 ${dedupeKey}
          FROM profiles p
          WHERE p.role = 'super_admin' AND p.active = true
            AND NOT EXISTS (
              SELECT 1 FROM notifications n2
              WHERE n2.user_id = p.id AND n2.dedupe_key = ${dedupeKey}
            )
        `;
      } catch (notifErr: any) {
        console.error('[handleCalendarPush] OAuth-expired notify error:', notifErr?.message);
      }
      return c.json({ skipped: 'boat_oauth_expired', boat_id: bk.boat_id, boat_name: bk.boat_name });
    }
    throw err;
  }

  if (body.action === 'delete') {
    if (bk.google_event_id) {
      await deleteCalendarEvent({ accessToken, calendarId: calId, eventId: bk.google_event_id });
      await sql`UPDATE bookings SET google_event_id = NULL, google_calendar_id = NULL, google_synced_at = NULL WHERE id = ${body.booking_id}`;
    }
    // Frontend `action: 'deleted'` field'ı bekliyor — yoksa "unexpected response" 'failed' döner
    // ve Bookings sayfasındaki delete mutation DB delete'i atmaz (orphan-prevention guard).
    return c.json({ ok: true, action: 'deleted' });
  }

  // Build event — bk.date Date objesi de olabilir, ISO timestamp string de.
  // Postgres `date` -> postgres-js Date; view'lar string ("2026-05-23T00:00:00.000Z") dönebilir.
  // Her iki durumda da yyyy-MM-dd al.
  const datePart = (bk.date instanceof Date)
    ? bk.date.toISOString().slice(0, 10)
    : String(bk.date).slice(0, 10);
  const timePart = (bk.start_time && String(bk.start_time).slice(0, 8)) || '12:00:00';
  const start = new Date(`${datePart}T${timePart}`);
  if (Number.isNaN(start.getTime())) {
    return c.json({ error: 'invalid_date', date: String(bk.date), start_time: String(bk.start_time) }, 400);
  }
  const dur = Number(bk.duration_hours || 2);
  const end = new Date(start.getTime() + dur * 3600_000);
  const adult = Number(bk.adult || 0), child = Number(bk.child || 0), infant = Number(bk.infant || 0);
  const channelPrefix = bk.channel_name ? `[${bk.channel_name}] ` : '';
  const event = {
    summary: `${channelPrefix}${bk.guest_name || '(misafir)'}`,
    description: [
      `Misafir: ${bk.guest_name || ''}`,
      bk.contact ? `İletişim: ${bk.contact}` : '',
      `Kişi: ${adult}A/${child}C/${infant}I`,
      bk.notes ? `Not: ${bk.notes}` : '',
    ].filter(Boolean).join('\n'),
    start: { dateTime: start.toISOString(), timeZone: 'Europe/Istanbul' },
    end:   { dateTime: end.toISOString(),   timeZone: 'Europe/Istanbul' },
  };

  if (body.action === 'create' || !bk.google_event_id) {
    const { id, htmlLink } = await createCalendarEvent({ accessToken, calendarId: calId, event });
    await sql`
      UPDATE bookings SET google_event_id = ${id}, google_calendar_id = ${calId}, google_synced_at = now(), google_sync_source = 'pushed'
      WHERE id = ${body.booking_id}
    `;
    return c.json({ ok: true, action: 'created', id, htmlLink });
  }

  await updateCalendarEvent({ accessToken, calendarId: calId, eventId: bk.google_event_id, event });
  await sql`UPDATE bookings SET google_synced_at = now() WHERE id = ${body.booking_id}`;
  return c.json({ ok: true, action: 'updated', id: bk.google_event_id, updated: true });
}
