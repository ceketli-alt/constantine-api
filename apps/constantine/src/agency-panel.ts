/**
 * /functions/v1/agency-panel — Acente token-bazlı public view (login yok)
 *
 * Endpoints (?action=...):
 *   GET  ?action=boats                                  → aktif tekne listesi
 *   GET  ?action=boat-detail&boat_id=<>                 → tek tekne + galeri
 *   GET  ?action=availability&boat_id=<>&from=<>&to=<>  → busy_blocks (rezervasyonlar)
 *   GET  ?action=search&date=<>&start_time=<>&duration_hours=<>  → uygun tekneler (exact/near/none)
 *   POST ?action=concierge   { q, lang, today }         → doğal dil arama (Haiku parse → search → narrate)
 *   POST ?action=request                                → rezervasyon isteği yarat
 *
 * Auth: ?token=<32-char URL-safe>. Hiçbir kullanıcı login yok.
 * Headers: X-Robots-Tag: noindex
 */
import type { Context } from 'hono';
import { sql } from './db.js';
import { sendEmail } from './resend-send.js';
import {
  conciergeConfigured,
  parseConciergeQuery,
  narrateConciergeResults,
} from './agency-concierge.js';

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
  // Accept: full 30-36 char hash tokens OR short alphabetic slugs (e.g. "genel")
  const isHash = token.length >= 30 && token.length <= 36 && /^[A-Za-z0-9_-]+$/.test(token);
  const isSlug = token.length >= 3 && token.length <= 20 && /^[a-z0-9-]+$/.test(token);
  if (!isHash && !isSlug) return null;

  const rows = await sql`
    SELECT t.id AS token_id, t.token, t.expires_at,
           a.id AS agency_id, a.name AS agency_name,
           a.contact_name, a.phone
    FROM agency_tokens t
    INNER JOIN agencies a ON a.id = t.agency_id
    WHERE (t.token = ${token} OR t.slug = ${token})
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

function endMinutesUnwrapped(timeStr: string, hours: number): number {
  return timeToMinutes(timeStr) + Math.round(hours * 60);
}

function rangesOverlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// Sıralı + çakışan/bitişik blokları birleştir (handleAvailability + handleSearch ortak).
function mergeRanges(blocks: Array<{ s: number; e: number }>): Array<{ s: number; e: number }> {
  const sorted = [...blocks].sort((a, b) => a.s - b.s);
  const merged: Array<{ s: number; e: number }> = [];
  for (const blk of sorted) {
    const last = merged[merged.length - 1];
    if (last && blk.s <= last.e) last.e = Math.max(last.e, blk.e);
    else merged.push({ ...blk });
  }
  return merged;
}

// [dayStart, dayEnd] içinde dolu (merged, sıralı non-overlap) blokların tümleyeni = boş pencereler.
function computeFreeWindows(
  merged: Array<{ s: number; e: number }>,
  dayStart: number,
  dayEnd: number,
): Array<{ s: number; e: number }> {
  const free: Array<{ s: number; e: number }> = [];
  let cursor = dayStart;
  for (const b of merged) {
    if (b.e <= dayStart) continue;
    if (b.s >= dayEnd) break;
    const bs = Math.max(b.s, dayStart);
    if (bs > cursor) free.push({ s: cursor, e: bs });
    cursor = Math.max(cursor, Math.min(b.e, dayEnd));
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) free.push({ s: cursor, e: dayEnd });
  return free;
}

// ============================================================
// Handlers
// ============================================================

async function handleBoats(ctx: AgencyContext) {
  // min_price: en düşük aktif fiyat satırı (kartta "€X'den başlayan").
  // White-label: owner/agency_only alanları acenteye DÖNMEZ.
  const data = await sql`
    SELECT b.id, b.name, b.image_url, b.capacity, b.short_description,
           b.short_description_translations, b.default_duration_hours,
           p.price AS min_price, p.currency AS min_price_currency
    FROM boats b
    LEFT JOIN LATERAL (
      SELECT price, currency FROM boat_pricing_rows
      WHERE boat_id = b.id AND active = true
      ORDER BY price ASC LIMIT 1
    ) p ON true
    WHERE b.active = true
    ORDER BY b.search_priority DESC, b.created_at ASC NULLS LAST, b.name
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
  const pricing = await sql`
    SELECT id, label, label_translations, duration_hours, price, currency, unit
    FROM boat_pricing_rows
    WHERE boat_id = ${boatId} AND active = true
    ORDER BY sort_order ASC, price ASC
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
        pricing: pricing.map((p: any) => ({ ...p, label_translations: p.label_translations ?? {} })),
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

  // Dakika-bazlı bloklar (unwrapped — gece yarısını aşan tur >1440 olabilir,
  // çıkışta minutesToHHMM wrap'ler; mevcut response shape korunur).
  const byDate: Record<string, Array<{ s: number; e: number }>> = {};
  for (const b of bookings) {
    if (!b.date) continue;
    const dateKey = String(b.date).slice(0, 10);
    let s: number;
    let e: number;
    if (b.start_time) {
      s = timeToMinutes(String(b.start_time).slice(0, 5));
      e = s + Math.round((Number(b.duration_hours) || 4) * 60);
    } else {
      s = 0;
      e = 1439;
    }
    (byDate[dateKey] ??= []).push({ s, e });
  }

  // Partner tekneler: Google freeBusy'den senkronlanan dolu saatler (boat_busy_slots cache)
  const slots = await sql`
    SELECT date::text AS date, start_time::text AS start_time, end_time::text AS end_time
    FROM boat_busy_slots
    WHERE boat_id = ${boatId}
      AND date >= ${fromStr}::date
      AND date <= ${toStr}::date
  `;
  for (const sRow of slots) {
    const dateKey = String(sRow.date).slice(0, 10);
    const s = timeToMinutes(String(sRow.start_time).slice(0, 5));
    let e = timeToMinutes(String(sRow.end_time).slice(0, 5));
    if (e <= s) e = 1439; // defensive — sync'in midnight-split konvansiyonu bunu üretmez
    (byDate[dateKey] ??= []).push({ s, e });
  }

  // Tarih başına sırala + çakışan/bitişik blokları birleştir
  const availability = Object.keys(byDate)
    .sort()
    .map((date) => {
      const merged = mergeRanges(byDate[date]!);
      return {
        date,
        busy_blocks: merged.map((m) => ({ start_time: minutesToHHMM(m.s), end_time: minutesToHHMM(m.e) })),
      };
    });

  return { status: 200, body: { availability } };
}

// ============================================================
// Hızlı arama — tüm filodan tarih+saat+süreye uygun tekneler (v3.2)
// ============================================================
// Kapasite filtresi YOK (her tekne çıkar). Müsaitlik deterministik: o tarihin
// bookings ∪ boat_busy_slots → boş pencereler → exact/near/none. Sıralama:
// exact → near → none, her grupta search_priority DESC (CONSTANTINE öne çıkar).
const SEARCH_DAY_START = 360; // 06:00
const SEARCH_DAY_END = 1440; // 24:00

async function handleSearch(date: string, startTime: string, durationStr: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { status: 400, body: { error: 'invalid date (YYYY-MM-DD)' } };
  }
  const reqDate = new Date(date + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (isNaN(reqDate.getTime()) || reqDate.getTime() < today.getTime()) {
    return { status: 400, body: { error: 'date in past' } };
  }
  if ((reqDate.getTime() - today.getTime()) / 86400000 > 60) {
    return { status: 400, body: { error: 'date too far (max 60 days)' } };
  }
  if (!/^\d{2}:\d{2}$/.test(startTime)) {
    return { status: 400, body: { error: 'invalid start_time (HH:MM)' } };
  }
  const startH = Number(startTime.split(':')[0]);
  if (startH < 6 || startH > 23) {
    return { status: 400, body: { error: 'start_time must be 06:00-23:00' } };
  }
  const dur = Number(durationStr);
  if (!Number.isFinite(dur) || dur < 0.5 || dur > 12) {
    return { status: 400, body: { error: 'duration_hours must be 0.5-12' } };
  }

  const reqStart = timeToMinutes(startTime);
  const durM = Math.round(dur * 60);
  const reqEnd = reqStart + durM;

  // A: tüm aktif tekneler + min fiyat + öncelik (kapasite filtresi YOK; white-label alanlar dönmez)
  const boats = await sql`
    SELECT b.id, b.name, b.image_url, b.capacity, b.short_description,
           b.short_description_translations, b.default_duration_hours, b.search_priority,
           p.price AS min_price, p.currency AS min_price_currency
    FROM boats b
    LEFT JOIN LATERAL (
      SELECT price, currency FROM boat_pricing_rows
      WHERE boat_id = b.id AND active = true
      ORDER BY price ASC LIMIT 1
    ) p ON true
    WHERE b.active = true
  `;

  // B+C: o tarihin dolu kaynakları (tüm tekneler tek sorguda — tekne-başı döngü yok)
  const bookings = await sql`
    SELECT boat_id, start_time::text AS start_time, duration_hours
    FROM bookings
    WHERE date = ${date}::date AND status != 'cancelled'
  `;
  const slots = await sql`
    SELECT boat_id, start_time::text AS start_time, end_time::text AS end_time
    FROM boat_busy_slots
    WHERE date = ${date}::date
  `;

  const byBoat: Record<string, Array<{ s: number; e: number }>> = {};
  for (const b of bookings) {
    let s: number;
    let e: number;
    if (b.start_time) {
      s = timeToMinutes(String(b.start_time).slice(0, 5));
      e = s + Math.round((Number(b.duration_hours) || 4) * 60);
    } else {
      s = 0;
      e = 1439;
    }
    (byBoat[b.boat_id] ??= []).push({ s, e });
  }
  for (const sRow of slots) {
    const s = timeToMinutes(String(sRow.start_time).slice(0, 5));
    let e = timeToMinutes(String(sRow.end_time).slice(0, 5));
    if (e <= s) e = 1439;
    (byBoat[sRow.boat_id] ??= []).push({ s, e });
  }

  const enriched = boats.map((boat: any) => {
    const merged = mergeRanges(byBoat[boat.id] ?? []);
    const free = computeFreeWindows(merged, SEARCH_DAY_START, SEARCH_DAY_END);
    const exact = free.some((w) => w.s <= reqStart && reqEnd <= w.e);
    let match: 'exact' | 'near' | 'none' = 'none';
    let suggested_start: string | null = null;
    let suggested_end: string | null = null;
    if (exact) {
      match = 'exact';
    } else {
      const fit = free.filter((w) => w.e - w.s >= durM);
      if (fit.length > 0) {
        let bestStart = -1;
        let bestDist = Infinity;
        for (const w of fit) {
          const slotStart = Math.max(w.s, Math.min(reqStart, w.e - durM));
          const d = Math.abs(slotStart - reqStart);
          if (d < bestDist) {
            bestDist = d;
            bestStart = slotStart;
          }
        }
        match = 'near';
        suggested_start = minutesToHHMM(bestStart);
        suggested_end = minutesToHHMM(bestStart + durM);
      }
    }
    return {
      row: {
        id: boat.id,
        name: boat.name,
        image_url: boat.image_url,
        capacity: boat.capacity,
        short_description: boat.short_description,
        short_description_translations: boat.short_description_translations ?? {},
        default_duration_hours: boat.default_duration_hours,
        min_price: boat.min_price,
        min_price_currency: boat.min_price_currency,
        match,
        busy_blocks: merged.map((m) => ({ start_time: minutesToHHMM(m.s), end_time: minutesToHHMM(m.e) })),
        suggested_start,
        suggested_end,
      },
      matchOrder: match === 'exact' ? 0 : match === 'near' ? 1 : 2,
      priority: Number(boat.search_priority ?? 0),
      name: String(boat.name ?? ''),
    };
  });

  enriched.sort((a, b) => {
    if (a.matchOrder !== b.matchOrder) return a.matchOrder - b.matchOrder;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.name.localeCompare(b.name);
  });

  return {
    status: 200,
    body: { query: { date, start_time: startTime, duration_hours: dur }, results: enriched.map((e) => e.row) },
  };
}

// ============================================================
// Concierge — doğal dil arama (v3.3)
// ============================================================
// Akış: Haiku parse (serbest metin → params) → handleSearch (DETERMİNİSTİK) →
// Haiku narrate (gerçek sonucu cümleyle anlat, best-effort). Müsaitlik asla LLM
// tarafından uydurulmaz; kart listesi handleSearch çıktısıdır. Hiçbir şey YAZMAZ.
async function handleConcierge(qRaw: unknown, langRaw: unknown, todayRaw: unknown) {
  if (!conciergeConfigured()) {
    return { status: 503, body: { error: 'concierge_unconfigured' } };
  }
  if (typeof qRaw !== 'string' || !qRaw.trim()) {
    return { status: 400, body: { error: 'q (query text) required' } };
  }
  const q = qRaw.trim().slice(0, 280);
  const lang = typeof langRaw === 'string' && /^[a-z]{2}$/.test(langRaw) ? langRaw : 'en';
  const today =
    typeof todayRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(todayRaw)
      ? todayRaw
      : new Date().toISOString().slice(0, 10);

  // 1) Parse (LLM) — hata olursa "unclear" döner, frontend manuel forma düşer
  let parse;
  try {
    parse = await parseConciergeQuery(q, today, lang);
  } catch (e: any) {
    console.warn('[agency-panel] concierge parse failed:', e?.message);
    return {
      status: 200,
      body: { intent: 'unclear', parsed: null, results: [], message: null, assumptions: null },
    };
  }

  if (parse.intent !== 'search' || !parse.parsed.date) {
    return {
      status: 200,
      body: {
        intent: 'unclear',
        parsed: parse.parsed,
        results: [],
        message: parse.message,
        assumptions: null,
      },
    };
  }

  // 2) Search (DETERMİNİSTİK) — normalizeParse default'ları uyguladı
  const startTime = parse.parsed.start_time ?? '14:00';
  const dur = parse.parsed.duration_hours ?? 4;
  const search = await handleSearch(parse.parsed.date, startTime, String(dur));
  if (search.status !== 200) {
    return {
      status: 200,
      body: {
        intent: 'unclear',
        parsed: parse.parsed,
        results: [],
        message: parse.message,
        assumptions: null,
      },
    };
  }
  const results = ((search.body as any).results ?? []) as Array<any>;

  // 3) Narrate (LLM, best-effort) — yalnız gerçek sonuçları anlatır
  const exact = results.filter((r) => r.match === 'exact');
  const near = results.filter((r) => r.match === 'near');
  const noneCount = results.filter((r) => r.match === 'none').length;
  // results matchOrder→priority sıralı; grup başı = en öncelikli (CONSTANTINE öne çıkar)
  const featured = exact[0]?.name ?? near[0]?.name ?? null;
  const message = await narrateConciergeResults({
    lang,
    query: { date: parse.parsed.date, start_time: startTime, duration_hours: dur, guests: parse.parsed.guests },
    exact: exact.map((r) => String(r.name)),
    near: near.map((r) => ({ name: String(r.name), from: r.suggested_start ?? '', to: r.suggested_end ?? '' })),
    noneCount,
    featured,
  });

  return {
    status: 200,
    body: {
      intent: 'search',
      parsed: { date: parse.parsed.date, start_time: startTime, duration_hours: dur, guests: parse.parsed.guests },
      query: (search.body as any).query,
      results,
      message,                     // narration (null olabilir → frontend template)
      assumptions: parse.message,  // parse notu ("akşam=19:00") — null olabilir
    },
  };
}

interface RequestBody {
  boat_id?: unknown;
  date?: unknown;
  start_time?: unknown;
  duration_hours?: unknown;
  guest_count?: unknown;
  contact_name?: unknown;
  contact_info?: unknown;
  guest_name?: unknown;
  notes?: unknown;
  source_reseller?: unknown;
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
  const contactName = typeof b.contact_name === 'string' ? b.contact_name.trim().slice(0, 200) : null;
  if (!contactName) {
    return { status: 400, body: { error: 'contact_name is required' } };
  }
  const contactInfo = typeof b.contact_info === 'string' ? b.contact_info.trim().slice(0, 200) : null;
  if (!contactInfo) {
    return { status: 400, body: { error: 'contact_info is required' } };
  }
  const guestName = typeof b.guest_name === 'string' ? b.guest_name.trim().slice(0, 200) : null;
  const notes = typeof b.notes === 'string' ? b.notes.trim().slice(0, 1000) : null;
  // CC white-label atıfı — talebi yönlendiren otel/reseller görünen adı (untrusted display text).
  const sourceReseller = typeof b.source_reseller === 'string' && b.source_reseller.trim()
    ? b.source_reseller.trim().slice(0, 120)
    : null;

  const boatRows = await sql`
    SELECT id, name, capacity, active FROM boats WHERE id = ${b.boat_id}
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
      duration_hours, guest_count, contact_name, contact_info, guest_name, notes,
      source_reseller
    ) VALUES (
      ${ctx.agency.id}::uuid, ${ctx.token.id}::uuid, ${b.boat_id}::uuid,
      ${b.date}::date, ${startTime}::time,
      ${dur}, ${guests}, ${contactName}, ${contactInfo}, ${guestName}, ${notes},
      ${sourceReseller}
    )
    RETURNING id
  `;
  const insertedId = insertRows[0]?.id;
  if (!insertedId) {
    return { status: 500, body: { error: 'failed to create request' } };
  }

  // Overlap detection (yeni eklediğimiz hariç)
  const overlap = await checkOverlap(b.boat_id, b.date, startMin, endMin, insertedId);

  // Bildirimler — non-fatal: talep kaydedildi, bildirim hatası response'u bozmasın.
  const summary = `${ctx.agency.name}${sourceReseller ? ` · 🏨 ${sourceReseller}` : ''} · ${b.date} ${startTime} · ${dur} saat · ${guests} kişi${overlap ? ' · ÇAKIŞMA VAR' : ''}`;
  try {
    const dedupeKey = `agency_request_new:${insertedId}`;
    await sql`
      INSERT INTO notifications (user_id, boat_id, type, title, body, link, dedupe_key)
      SELECT p.id, ${b.boat_id}::uuid, 'agency_request_new',
             ${`Yeni acente isteği — ${boat.name}`},
             ${summary},
             '/acente-istekler',
             ${dedupeKey}
      FROM profiles p
      WHERE p.role = 'super_admin' AND p.active = true
        AND NOT EXISTS (
          SELECT 1 FROM notifications n2
          WHERE n2.user_id = p.id AND n2.dedupe_key = ${dedupeKey}
        )
    `;
  } catch (e: any) {
    console.warn('[agency-panel] request notify (in-app) skipped:', e?.message);
  }
  // Mail — fire-and-forget
  sql`
    SELECT u.email FROM auth.users u
    JOIN profiles p ON p.id = u.id
    WHERE p.role = 'super_admin' AND p.active = true AND u.email IS NOT NULL
  `
    .then((rows) => {
      const emails = rows.map((r: any) => r.email).filter(Boolean);
      if (emails.length === 0) return;
      return sendEmail({
        to: emails,
        subject: `Yeni acente isteği — ${boat.name} · ${b.date} ${startTime}`,
        text: `${summary}\nİletişim: ${contactName} (${contactInfo})${guestName ? `\nMisafir: ${guestName}` : ''}${notes ? `\nNot: ${notes}` : ''}\n\nİncele: https://crm.constantineyachts.com/acente-istekler`,
      });
    })
    .catch((e: any) => console.warn('[agency-panel] request notify (mail) skipped:', e?.message));

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

  // Partner tekneler: Google takvimden senkronlanan dolu saatler
  const slots = await sql`
    SELECT start_time::text AS start_time, end_time::text AS end_time
    FROM boat_busy_slots
    WHERE boat_id = ${boatId}::uuid AND date = ${date}::date
  `;
  for (const s of slots) {
    const sMin = timeToMinutes(String(s.start_time).slice(0, 5));
    let eMin = timeToMinutes(String(s.end_time).slice(0, 5));
    if (eMin <= sMin) eMin = 1439;
    if (rangesOverlapMinutes(startMin, endMin, sMin, eMin)) return true;
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
      case 'search': {
        const date = c.req.query('date') ?? '';
        const startTime = c.req.query('start_time') ?? '';
        const duration = c.req.query('duration_hours') ?? '';
        const result = await handleSearch(date, startTime, duration);
        return c.json(result.body, result.status as any);
      }
      case 'concierge': {
        if (c.req.method !== 'POST') {
          return c.json({ error: 'concierge action requires POST' }, 405);
        }
        let body: any;
        try { body = await c.req.json(); }
        catch { return c.json({ error: 'invalid JSON' }, 400); }
        const result = await handleConcierge(body?.q, body?.lang, body?.today);
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
