/**
 * Constantine çift-yön takvim senkronu (Simon entegrasyonu).
 *
 * Gizliliği korumak için GERÇEK ops takvimi (primary) DEĞİL, ayrı bir "Booking Sync"
 * takvimi kullanılır (boats.sync_calendar_id). Simon'la edit yetkisiyle paylaşılır.
 *
 *   PUSH (CRM → sync takvimi): non-cancelled CRM rezervasyonları → detaysız "Dolu"
 *     all-day blok. Blok extendedProperties.private.cy_sync='crm' ile işaretlenir
 *     (pull tarafı bunu bizim blok olarak tanıyıp atlar). PII içermez.
 *   PULL (sync takvimi → CRM): Simon'ın yazdığı (cy_sync işareti OLMAYAN) event'ler
 *     → status='draft' + approval_status='pending' booking (sync_origin='partner').
 *     Mevcut /approvals ekranında görünür; Mert onaylar/reddeder.
 *   RECONCILE: Mert reddedince (approval_status='rejected') → Simon'ın event'ini sil
 *     + status='cancelled' (müsaitlik boşalsın; reject_booking status'a dokunmaz).
 *     Simon kendi event'ini silerse (withdraw) → pending booking'i iptal et.
 *
 * Tekne-bazlı: sync_enabled=true olan her boat işlenir (şimdilik yalnız CONSTANTINE).
 * Cron her 10 dk (cron-scheduler.ts). Manuel tetik + provision endpoint'leri server.ts.
 */
import type { Context } from 'hono';
import { sql } from './db.js';
import { requireAuth } from './middleware.js';
import {
  getAccessTokenForBoat,
  listCalendarEventsAll,
  getCalendarEvent,
  createCalendarEvent,
  deleteCalendarEvent,
  createCalendar,
  shareCalendar,
  type CalendarEvent,
  type NewCalendarEvent,
} from './google.js';
import { isoToLocalParts } from './google-calendar.js';

export const CONSTANTINE_BOAT_ID = '222a10f8-6d66-41ec-9162-198d26d84cde';
const TZ = 'Europe/Istanbul';
const HORIZON_DAYS = 180;
const CRM_MARKER_KEY = 'cy_sync';
const CRM_MARKER_VAL = 'crm';
const BLOCK_SUMMARY = 'Dolu';
const SYNC_LOCK_KEY = 982451; // pg advisory lock anahtarı — eş-zamanlı sync koşusunu engeller

// ───────────────────────── Saf yardımcılar (test edilebilir) ─────────────────────────

/** Lokal tarihe gün ekle — öğlen çapasıyla (DST-tarzı sınır bug'larından kaçınır). */
export function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Event bizim pushladığımız CRM "Dolu" bloğu mu? (pull tarafında atlanır) */
export function isCrmBlock(ev: CalendarEvent): boolean {
  return ev.extendedProperties?.private?.[CRM_MARKER_KEY] === CRM_MARKER_VAL;
}

/** Bir CRM bookingi için detaysız all-day "Dolu" blok gövdesi. */
export function buildCrmBlockEvent(dateStr: string, bookingId: string): NewCalendarEvent {
  return {
    summary: BLOCK_SUMMARY,
    start: { date: dateStr },
    end: { date: addDaysToDateStr(dateStr, 1) }, // all-day end exclusive
    transparency: 'opaque',
    extendedProperties: { private: { [CRM_MARKER_KEY]: CRM_MARKER_VAL, booking_id: bookingId } },
  };
}

export interface IncomingDay { date: string; start_time: string | null; duration_hours: number | null; }

/**
 * Simon'ın bir event'ini CRM booking gün(ler)ine çevir.
 *   - saatli event: tek gün, start_time + duration_hours (Istanbul lokal).
 *   - all-day event: [start.date, end.date) aralığındaki HER gün için bir satır
 *     (end exclusive — Google all-day konvansiyonu). Çok günlük charter → gün başına booking.
 */
export function eventToIncomingDays(ev: CalendarEvent, tz: string = TZ): IncomingDay[] {
  if (ev.start.dateTime) {
    const startIso = ev.start.dateTime;
    const endIso = ev.end?.dateTime ?? startIso;
    const sp = isoToLocalParts(startIso, ev.start.timeZone ?? tz);
    const durationMs = new Date(endIso).getTime() - new Date(startIso).getTime();
    const durationHours = durationMs > 0 ? Math.round((durationMs / 3_600_000) * 100) / 100 : null;
    return [{ date: sp.date, start_time: sp.time, duration_hours: durationHours }];
  }
  const startDate = ev.start.date;
  if (!startDate) return [];
  const endExclusive = ev.end?.date ?? addDaysToDateStr(startDate, 1);
  const rows: IncomingDay[] = [];
  let cur = startDate;
  let guard = 0;
  while (cur < endExclusive && guard < 366) {
    rows.push({ date: cur, start_time: null, duration_hours: null });
    cur = addDaysToDateStr(cur, 1);
    guard++;
  }
  if (rows.length === 0) rows.push({ date: startDate, start_time: null, duration_hours: null });
  return rows;
}

/** İstenen (event'teki) günler ile mevcut booking günleri farkı. drift/eksik-onarım için. */
export function diffDays(desired: string[], existing: string[]): { toAdd: string[]; toCancel: string[] } {
  const d = new Set(desired);
  const e = new Set(existing);
  return {
    toAdd: desired.filter((x) => !e.has(x)),
    toCancel: existing.filter((x) => !d.has(x)),
  };
}

/**
 * Günleri sync ufkuna ([from, to] dahil) kırp. Sync takvimi dış partnerle (Simon) writer
 * paylaşıldığı için event içeriği GÜVENİLMEZ girdidir: ufuk-dışı/geçmiş günler insert edilmemeli
 * (aksi halde reconcile/withdraw ufuk-kapsamlı olduğundan o satırlar orphan kalıp müsaitliği kirletir).
 */
export function clipDaysToWindow<T extends { date: string }>(rows: T[], from: string, to: string): T[] {
  return rows.filter((r) => r.date >= from && r.date <= to);
}

// ───────────────────────── Sync motoru ─────────────────────────

export interface ConstantineSyncResult {
  boats: number;
  pushed: number;          // CRM → takvim oluşturulan "Dolu" blok
  blocksDeleted: number;   // iptal/red olan CRM bloğu silindi
  ingestedEvents: number;  // içeri alınan yeni Simon event sayısı
  ingestedRows: number;    // oluşturulan pending booking satırı (çok günlük → >1)
  driftCancelled: number;  // Simon tarihi değiştirince eski (pending) gün iptal edildi
  rejectedCleaned: number; // Mert reddetti → Simon event'i silindi + tüm günler cancelled
  withdrawn: number;       // Simon kendi event'ini sildi (events.get teyitli) → pending iptal
  flagged: number;         // edge: onaylı booking'in event'i kaybolmuş/taşınmış → super_admin'e bildirim
  truncatedBoats: number;  // event listesi page-cap'e takıldı → withdraw o tekne için atlandı
  errors: Array<{ boat_id: string; boat_name: string; error: string }>;
}

interface SyncBoat { id: string; name: string; sync_calendar_id: string }

export async function runConstantineSync(boatIds?: string[]): Promise<ConstantineSyncResult> {
  const result: ConstantineSyncResult = {
    boats: 0, pushed: 0, blocksDeleted: 0, ingestedEvents: 0,
    ingestedRows: 0, driftCancelled: 0, rejectedCleaned: 0, withdrawn: 0,
    flagged: 0, truncatedBoats: 0, errors: [],
  };

  // Eş-zamanlı koşu engeli (cron + manuel tetik + script çakışması) — DB advisory lock.
  // Reserve edilmiş tek bağlantıda tutulur (postgres-js pool'unda lock/unlock aynı conn'da olmalı).
  const conn = await sql.reserve();
  let locked = false;
  try {
    const lk = await conn`SELECT pg_try_advisory_lock(${SYNC_LOCK_KEY}) AS locked`;
    locked = !!(lk[0] as any)?.locked;
    if (!locked) {
      console.warn('[constantine-sync] başka koşu kilidi tutuyor — atlandı');
      return result;
    }
    await runConstantineSyncLocked(result, boatIds);
    return result;
  } finally {
    if (locked) { try { await conn`SELECT pg_advisory_unlock(${SYNC_LOCK_KEY})`; } catch { /* ignore */ } }
    conn.release();
  }
}

async function runConstantineSyncLocked(result: ConstantineSyncResult, boatIds?: string[]): Promise<void> {
  const boats = (boatIds && boatIds.length > 0
    ? await sql`
        SELECT id, name, sync_calendar_id FROM boats
        WHERE sync_enabled = true AND sync_calendar_id IS NOT NULL
          AND google_calendar_connected = true AND active = true
          AND id = ANY(${boatIds}::uuid[])
      `
    : await sql`
        SELECT id, name, sync_calendar_id FROM boats
        WHERE sync_enabled = true AND sync_calendar_id IS NOT NULL
          AND google_calendar_connected = true AND active = true
      `) as unknown as SyncBoat[];
  result.boats = boats.length;

  const todayIst = isoToLocalParts(new Date().toISOString(), TZ).date;
  const horizonEnd = addDaysToDateStr(todayIst, HORIZON_DAYS);
  const timeMin = new Date(`${todayIst}T00:00:00+03:00`).toISOString();
  const timeMax = new Date(Date.now() + HORIZON_DAYS * 86400_000).toISOString();

  for (const boat of boats) {
    const calId = boat.sync_calendar_id;
    try {
      const accessToken = await getAccessTokenForBoat(boat.id);

      // ── A: yeni CRM bookingleri için "Dolu" blok push et ──
      const toPush = (await sql`
        SELECT id, date::text AS date FROM bookings
        WHERE boat_id = ${boat.id}
          AND date >= CURRENT_DATE AND date <= CURRENT_DATE + ${HORIZON_DAYS}::int
          AND status != 'cancelled' AND approval_status != 'rejected'
          AND (sync_origin IS NULL OR sync_origin = 'crm')
          AND sync_calendar_event_id IS NULL
      `) as unknown as Array<{ id: string; date: string }>;
      for (const bk of toPush) {
        try {
          const { id: evId } = await createCalendarEvent({
            accessToken, calendarId: calId,
            event: buildCrmBlockEvent(bk.date.slice(0, 10), bk.id),
          });
          await sql`
            UPDATE bookings SET sync_calendar_event_id = ${evId}, sync_origin = 'crm'
            WHERE id = ${bk.id}
          `;
          result.pushed++;
        } catch (e: any) {
          console.error(`[constantine-sync] push block failed (booking ${bk.id}):`, e?.message);
        }
      }

      // ── B: iptal/red olan CRM bloklarını sil ──
      const toDelete = (await sql`
        SELECT id, sync_calendar_event_id AS ev FROM bookings
        WHERE boat_id = ${boat.id} AND sync_origin = 'crm'
          AND sync_calendar_event_id IS NOT NULL
          AND (status = 'cancelled' OR approval_status = 'rejected')
      `) as unknown as Array<{ id: string; ev: string }>;
      for (const bk of toDelete) {
        try {
          await deleteCalendarEvent({ accessToken, calendarId: calId, eventId: bk.ev });
          await sql`UPDATE bookings SET sync_calendar_event_id = NULL WHERE id = ${bk.id}`;
          result.blocksDeleted++;
        } catch (e: any) {
          console.error(`[constantine-sync] delete block failed (booking ${bk.id}):`, e?.message);
        }
      }

      // ── C: Mert'in reddettiği/iptal ettiği Simon rezervasyonları → EVENT BAZINDA temizle ──
      // reject_booking yalnız approval_status='rejected' yapar (status'a dokunmaz). Bir charter
      // tek takvim event'i olduğu için herhangi bir günü reddedilirse TÜM event reddedilir:
      // Simon'ın event'ini sil + o event'in tüm günlerini cancelled + event_id NULL.
      // deletedThisTick: bu tick sildiğimiz event'ler — pull tarafı bunları phantom re-ingest etmesin.
      const rejectedEvents = (await sql`
        SELECT DISTINCT sync_calendar_event_id AS ev FROM bookings
        WHERE boat_id = ${boat.id} AND sync_origin = 'partner'
          AND sync_calendar_event_id IS NOT NULL
          AND (approval_status = 'rejected' OR status = 'cancelled')
      `) as unknown as Array<{ ev: string }>;
      const deletedThisTick = new Set<string>();
      for (const { ev } of rejectedEvents) {
        try {
          await deleteCalendarEvent({ accessToken, calendarId: calId, eventId: ev });
          deletedThisTick.add(ev);
          await sql`
            UPDATE bookings SET status = 'cancelled', sync_calendar_event_id = NULL
            WHERE boat_id = ${boat.id} AND sync_origin = 'partner' AND sync_calendar_event_id = ${ev}
          `;
          result.rejectedCleaned++;
        } catch (e: any) {
          console.error(`[constantine-sync] reject cleanup failed (event ${ev}):`, e?.message);
        }
      }

      // ── Sync takvimini TAM oku (sayfalı). truncated → withdraw bu tekne için ATLANIR. ──
      const { events, truncated } = await listCalendarEventsAll({ accessToken, calendarId: calId, timeMin, timeMax });
      if (truncated) result.truncatedBoats++;

      // Simon'ın canlı (cy_sync işaretsiz, non-cancelled) event'leri: id → event
      const simonEvents = new Map<string, CalendarEvent>();
      for (const ev of events) {
        if (isCrmBlock(ev)) continue;          // bizim "Dolu" bloğumuz
        if (ev.status === 'cancelled') continue;
        simonEvents.set(ev.id, ev);
      }

      // Mevcut aktif partner satırları (snapshot): event_id → [{id, date, approval_status}]
      const activeRows = (await sql`
        SELECT id, sync_calendar_event_id AS ev, date::text AS date, approval_status
        FROM bookings
        WHERE boat_id = ${boat.id} AND sync_origin = 'partner'
          AND status != 'cancelled' AND sync_calendar_event_id IS NOT NULL
      `) as unknown as Array<{ id: string; ev: string; date: string; approval_status: string }>;
      const byEvent = new Map<string, Array<{ id: string; date: string; approval_status: string }>>();
      for (const r of activeRows) {
        const arr = byEvent.get(r.ev) ?? [];
        arr.push({ id: r.id, date: r.date.slice(0, 10), approval_status: r.approval_status });
        byEvent.set(r.ev, arr);
      }

      // ── D: ingest + reconcile (yeni event / date-drift / eksik gün onarımı) — declarative ──
      for (const [evId, ev] of simonEvents) {
        if (deletedThisTick.has(evId)) continue; // bu tick biz sildik (propagasyon gecikmesi → phantom önle)
        // Güvenlik: dış-yazar event'inin günlerini sync ufkuna kırp (ufuk-dışı orphan satır olmasın).
        const desired = clipDaysToWindow(eventToIncomingDays(ev, TZ), todayIst, horizonEnd);
        if (desired.length === 0) continue;
        const existing = byEvent.get(evId) ?? [];
        const { toAdd, toCancel } = diffDays(desired.map((d) => d.date), existing.map((r) => r.date));

        // yeni gün(ler) → event başına ATOMİK insert. Biri patlarsa tümü rollback → event known
        // olmaz, sonraki tick tekrar denenir (kısmi multi-day ingest bug'ı engellenir).
        if (toAdd.length > 0) {
          const guestName = (ev.summary?.trim()) || 'Simon rezervasyonu';
          const notes = ['Otomatik: Simon takvim senkronu', ev.description ?? '', ev.htmlLink ?? '']
            .filter(Boolean).join('\n');
          const addRows = desired.filter((d) => toAdd.includes(d.date));
          const isNewEvent = existing.length === 0;
          try {
            await sql.begin(async (tx) => {
              for (const d of addRows) {
                await tx`
                  INSERT INTO bookings (date, guest_name, boat_id, start_time, duration_hours,
                                        status, approval_status, notes, sync_calendar_event_id, sync_origin)
                  VALUES (${d.date}::date, ${guestName}, ${boat.id}, ${d.start_time}, ${d.duration_hours},
                          'draft', 'pending', ${notes}, ${evId}, 'partner')
                `;
              }
            });
            result.ingestedRows += addRows.length;
            if (isNewEvent) {
              result.ingestedEvents++;
              await notifyAdmins(boat.id, 'simon_booking_pending',
                `Simon'dan rezervasyon — ${boat.name}`,
                `${guestName} · ${desired[0]!.date} · onay bekliyor`,
                '/approvals', `simon_booking:${evId}`);
            }
          } catch (e: any) {
            console.error(`[constantine-sync] ingest failed (event ${evId}):`, e?.message);
          }
        }

        // event'te artık olmayan eski gün(ler) = Simon tarihi değiştirdi (drift).
        // pending → iptal + event_id NULL (Section C bunu canlı event'e dokunmak için seçmesin);
        // onaylı → otomatik iptal etme, super_admin'e bildir.
        for (const row of existing) {
          if (!toCancel.includes(row.date)) continue;
          if (row.approval_status === 'pending') {
            try {
              await sql`UPDATE bookings SET status = 'cancelled', sync_calendar_event_id = NULL,
                          notes = COALESCE(notes, '') || E'\nSimon tarihi değiştirdi — bu gün düştü.'
                        WHERE id = ${row.id} AND status != 'cancelled'`;
              result.driftCancelled++;
            } catch (e: any) { console.error(`[constantine-sync] drift cancel failed (booking ${row.id}):`, e?.message); }
          } else {
            await notifyAdmins(boat.id, 'simon_booking_drift',
              `⚠ Onaylı rezervasyon tarihi değişti — ${boat.name}`,
              `${row.date} günü Simon takvimden kaldırdı ama booking onaylıydı. Manuel kontrol et.`,
              '/approvals', `simon_drift:${evId}:${row.date}`);
            result.flagged++;
          }
        }
      }

      // ── E: Simon kendi event'ini sildi (withdraw) → events.get ile TEYİT et, sonra iptal et ──
      // truncated okuma → ATLA (eksik liste yanlış toplu iptal yapmasın). Sadece pending'i iptal eder;
      // onaylı booking'in event'i kaybolmuşsa otomatik iptal YOK, super_admin'e bildirim (#7).
      if (!truncated) {
        const goneCache = new Map<string, boolean>();
        for (const [evId, rows] of byEvent) {
          if (simonEvents.has(evId)) continue;     // hâlâ canlı listede
          if (deletedThisTick.has(evId)) continue; // biz sildik (C zaten cancelled yaptı)
          let gone = goneCache.get(evId);
          if (gone === undefined) {
            // events.get ile teyit: eventual-consistency / geçici eksik listeden yanlış iptali önler.
            try { gone = !(await getCalendarEvent({ accessToken, calendarId: calId, eventId: evId })).exists; }
            catch { gone = false; } // teyit edemedik → güvenli taraf: iptal etme
            goneCache.set(evId, gone);
          }
          if (!gone) continue;
          for (const row of rows) {
            if (row.approval_status === 'pending') {
              try {
                await sql`UPDATE bookings SET status = 'cancelled', sync_calendar_event_id = NULL,
                            notes = COALESCE(notes, '') || E'\nSimon takvimden iptal etti.'
                          WHERE id = ${row.id} AND status != 'cancelled'`;
                result.withdrawn++;
              } catch (e: any) { console.error(`[constantine-sync] withdraw failed (booking ${row.id}):`, e?.message); }
            } else {
              await notifyAdmins(boat.id, 'simon_booking_vanished',
                `⚠ Onaylı rezervasyonun takvim event'i silindi — ${boat.name}`,
                `${row.date} · Simon event'i sildi ama booking onaylıydı. Manuel kontrol et.`,
                '/approvals', `simon_vanished:${evId}`);
              result.flagged++;
            }
          }
        }
      }

      await sql`UPDATE boats SET sync_last_run_at = now() WHERE id = ${boat.id}`;
    } catch (err: any) {
      console.error(`[constantine-sync] ${boat.name} failed:`, err?.message);
      result.errors.push({ boat_id: boat.id, boat_name: boat.name, error: err?.message ?? String(err) });
    }
  }

  try {
    await sql`
      INSERT INTO app_config (key, value)
      VALUES ('constantine.cron.sync', ${sql.json({
        boats: result.boats, pushed: result.pushed, blocks_deleted: result.blocksDeleted,
        ingested_events: result.ingestedEvents, ingested_rows: result.ingestedRows,
        drift_cancelled: result.driftCancelled, rejected_cleaned: result.rejectedCleaned,
        withdrawn: result.withdrawn, flagged: result.flagged, truncated_boats: result.truncatedBoats,
        errors: result.errors.length, at: new Date().toISOString(),
      })})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  } catch (e: any) {
    console.warn('[constantine-sync] last_run write skipped:', e?.message);
  }
}

/** super_admin'lere idempotent bildirim (dedupe_key ile tekrar etmez). Tüm değerler parametreli. */
async function notifyAdmins(boatId: string, type: string, title: string, body: string, link: string, dedupeKey: string): Promise<void> {
  try {
    await sql`
      INSERT INTO notifications (user_id, boat_id, type, title, body, link, dedupe_key)
      SELECT p.id, ${boatId}::uuid, ${type}, ${title}, ${body}, ${link}, ${dedupeKey}
      FROM profiles p
      WHERE p.role = 'super_admin' AND p.active = true
        AND NOT EXISTS (
          SELECT 1 FROM notifications n2 WHERE n2.user_id = p.id AND n2.dedupe_key = ${dedupeKey}
        )
    `;
  } catch (e: any) {
    console.warn('[constantine-sync] notify skipped:', e?.message);
  }
}

// ───────────────────────── Provision (takvim oluştur + paylaş) ─────────────────────────

export interface ProvisionResult {
  boat_id: string;
  boat_name: string;
  calendar_id: string;
  created_calendar: boolean;
  shared_with: string | null;
  sync_enabled: boolean;
}

/**
 * Defense-in-depth: bir takvim ID'sinin partnerla paylaşılması GÜVENLİ mi?
 * Sync takvimi ASLA primary ops takvimi olamaz — ops takvimi (google_calendar_id,
 * OAuth callback'te 'primary' literal'i) misafir PII'si içerir; partnere açılırsa
 * tüm müşteri verisi dış tarafa sızar. Bu yüzden 'primary' veya ops takvim ID'si
 * sync_calendar_id olarak kullanılamaz / paylaşılamaz. Hiçbir mevcut kod yolu bunu
 * yapmaz; bu gelecekteki yanlış-yapılandırmaya karşı emniyet kemeridir.
 */
function assertSafeSyncCalendarId(calendarId: string, opsCalendarId: string | null): void {
  if (calendarId === 'primary') {
    throw new Error('güvenlik: sync_calendar_id "primary" olamaz — primary ops takvimi misafir PII içerir, partnerla paylaşılamaz');
  }
  if (opsCalendarId && calendarId === opsCalendarId) {
    throw new Error('güvenlik: sync_calendar_id, primary ops takvimiyle (google_calendar_id) aynı olamaz — misafir PII partnere sızar');
  }
}

export async function provisionSyncCalendar(boatId: string, partnerEmail?: string): Promise<ProvisionResult> {
  const rows = await sql`
    SELECT id, name, google_calendar_connected, google_calendar_id, sync_calendar_id
    FROM boats WHERE id = ${boatId}
  `;
  const boat = rows[0] as any;
  if (!boat) throw new Error('boat not found');
  if (!boat.google_calendar_connected) throw new Error('boat Google bağlantısı yok — önce OAuth bağla');

  const accessToken = await getAccessTokenForBoat(boatId);

  let calendarId: string = boat.sync_calendar_id;
  let createdCalendar = false;
  if (!calendarId) {
    const created = await createCalendar({
      accessToken,
      summary: `${boat.name} – Booking Sync`,
      timeZone: TZ,
      description: 'Dış partner (Simon) ile paylaşılan müsaitlik takvimi. Yalnız "Dolu" blokları; müşteri verisi yok.',
    });
    calendarId = created.id;
    createdCalendar = true;
    // Yeni oluşturulan takvim de güvenli olmalı (createCalendar 'primary' dönmemeli).
    assertSafeSyncCalendarId(calendarId, boat.google_calendar_id);
    await sql`UPDATE boats SET sync_calendar_id = ${calendarId} WHERE id = ${boatId}`;
  } else {
    // Mevcut sync_calendar_id'yi yeniden kullanmadan ÖNCE doğrula.
    assertSafeSyncCalendarId(calendarId, boat.google_calendar_id);
  }

  let sharedWith: string | null = null;
  if (partnerEmail) {
    // Paylaşımdan hemen önce son bir kez doğrula (defense-in-depth).
    assertSafeSyncCalendarId(calendarId, boat.google_calendar_id);
    await shareCalendar({ accessToken, calendarId, email: partnerEmail, role: 'writer' });
    await sql`UPDATE boats SET sync_partner_email = ${partnerEmail} WHERE id = ${boatId}`;
    sharedWith = partnerEmail;
  }

  await sql`UPDATE boats SET sync_enabled = true WHERE id = ${boatId}`;

  return {
    boat_id: boatId, boat_name: boat.name, calendar_id: calendarId,
    created_calendar: createdCalendar, shared_with: sharedWith, sync_enabled: true,
  };
}

// ───────────────────────── HTTP handler'lar ─────────────────────────

async function requireSuperAdmin(c: Context): Promise<string | null> {
  const auth = requireAuth(c);
  if (!auth) return null;
  const prof = await sql`SELECT role::text AS role FROM profiles WHERE id = ${auth.userId}`;
  return prof[0]?.role === 'super_admin' ? auth.userId : null;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** POST /functions/v1/constantine-sync-provision — takvim oluştur + (opsiyonel) paylaş. */
export async function handleConstantineSyncProvision(c: Context): Promise<Response> {
  const userId = await requireSuperAdmin(c);
  if (!userId) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => ({})) as { boat_id?: string; partner_email?: string };
  const boatId = body.boat_id ?? CONSTANTINE_BOAT_ID;
  if (typeof boatId !== 'string' || !UUID_RE.test(boatId)) return c.json({ error: 'invalid boat_id' }, 400);
  if (body.partner_email !== undefined && (typeof body.partner_email !== 'string' || !EMAIL_RE.test(body.partner_email))) {
    return c.json({ error: 'invalid partner_email' }, 400);
  }

  try {
    const res = await provisionSyncCalendar(boatId, body.partner_email);
    return c.json(res);
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 400);
  }
}

/** POST /functions/v1/constantine-sync-run — manuel tetik (super_admin). */
export async function handleConstantineSyncRun(c: Context): Promise<Response> {
  const userId = await requireSuperAdmin(c);
  if (!userId) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => ({})) as { boat_ids?: string[] };
  let boatIds: string[] | undefined;
  if (body.boat_ids !== undefined) {
    if (!Array.isArray(body.boat_ids) || body.boat_ids.some((b) => typeof b !== 'string' || !UUID_RE.test(b))) {
      return c.json({ error: 'boat_ids must be an array of uuids' }, 400);
    }
    boatIds = body.boat_ids;
  }
  const result = await runConstantineSync(boatIds);
  return c.json(result);
}
