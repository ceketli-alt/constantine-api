/**
 * cron-daily-digest — Sales daily digest mail (TR 08:00 / UTC 05:00)
 *
 * Akış:
 * 1. app_config.sales.daily_digest_enabled toggle kontrol
 * 2. Eligible recipients (super_admin/partner + email + active + opt-in)
 * 3. Per recipient ortak data fetch:
 *    a. Bugün planlı aktiviteler (activity_events.metadata.due_at TR 00:00-23:59)
 *    b. Son 24 saatte sıcaklanmış lead'ler (score >= 60 + score_computed_at > now-24h)
 *    c. Çürüyen deal'lar (rotting eşiğini aşmış, won/lost değil)
 *    d. Stale lead'ler (last_contacted_at > 30 gün önce)
 * 4. composeDigestPayload → HTML + text + subject
 * 5. Resend ile gönder (from: digest@send.constantineyachts.com)
 * 6. activity_events log + return summary
 *
 * Endpoint: POST /functions/v1/cron-daily-digest (manuel trigger)
 * Schedule: cron-scheduler.ts içinde "0 5 * * *" UTC (= TR 08:00)
 */
import type { Context } from 'hono';
import { sql } from './db.js';
import { sendDigestViaResend } from './digest-sender.js';
import {
  composeDigestPayload,
  selectDigestRecipients,
  type DigestHotLead,
  type DigestPlannedActivity,
  type DigestRottingDeal,
  type DigestStaleLead,
  type UserProfileLite,
} from './digest-compose.js';

const DIGEST_SENDER_EMAIL = process.env.DIGEST_SENDER_EMAIL ?? 'digest@send.constantineyachts.com';
const DIGEST_SENDER_NAME = process.env.DIGEST_SENDER_NAME ?? 'Constantine Sales';
const DIGEST_REPLY_TO = process.env.DIGEST_REPLY_TO ?? 'mert@constantineyachts.com';

// =========================================================
// TR timezone helpers (UTC+3 sabit)
// =========================================================
const TR_OFFSET_MS = 3 * 60 * 60 * 1000;

interface TrDayBounds {
  startUtcIso: string;
  endUtcIso: string;
  dateLabel: string;
}

function getTrDayBounds(now: Date): TrDayBounds {
  const trNowMs = now.getTime() + TR_OFFSET_MS;
  const trNow = new Date(trNowMs);
  const trYear = trNow.getUTCFullYear();
  const trMonth = trNow.getUTCMonth();
  const trDay = trNow.getUTCDate();
  const startUtcMs = Date.UTC(trYear, trMonth, trDay, 0, 0, 0, 0) - TR_OFFSET_MS;
  const endUtcMs = Date.UTC(trYear, trMonth, trDay, 23, 59, 59, 999) - TR_OFFSET_MS;
  const months = [
    'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
    'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
  ];
  const dateLabel = `${trDay} ${months[trMonth]} ${trYear}`;
  return {
    startUtcIso: new Date(startUtcMs).toISOString(),
    endUtcIso: new Date(endUtcMs).toISOString(),
    dateLabel,
  };
}

// (Resend send artık paylaşılan helper: digest-sender.ts → sendDigestViaResend)

// =========================================================
// Segment label (FE ile aynı map)
// =========================================================
const SEGMENT_LABEL: Record<string, string> = {
  '5star_chain': '5★ Zincir Otel',
  '5star_boutique': '5★ Butik Otel',
  '4star_premium': '4★ Premium Otel',
  'agroup_agency': 'A-Grup Acente',
  'bgroup_agency': 'B-Grup Acente',
  'dmc': 'DMC',
  'wedding_planner': 'Düğün Planlamacı',
  'corporate_event': 'Kurumsal Etkinlik',
  'ota': 'OTA',
  'yacht_platform': 'Yat Platformu',
  'other': 'Diğer',
};

// =========================================================
// Data fetchers (Supabase JS → postgres-js port)
// =========================================================

async function fetchPlannedToday(bounds: TrDayBounds): Promise<DigestPlannedActivity[]> {
  // metadata->>due_at btree index var (Sprint 4a A3)
  const rows = await sql<Array<{
    id: string;
    target_id: string;
    event_type: string;
    metadata: any;
  }>>`
    SELECT id, target_id, event_type, metadata
    FROM activity_events
    WHERE target_type = 'lead'
      AND event_type IN ('manual_call', 'meeting', 'note')
      AND metadata->>'due_at' >= ${bounds.startUtcIso}
      AND metadata->>'due_at' <= ${bounds.endUtcIso}
    ORDER BY metadata->>'due_at' ASC
    LIMIT 200
  `;
  if (rows.length === 0) return [];

  const leadIds = Array.from(new Set(rows.map((r) => r.target_id).filter(Boolean)));
  const leadMap = new Map<string, string>();
  if (leadIds.length > 0) {
    const leads = await sql<Array<{ id: string; company_name: string }>>`
      SELECT id, company_name FROM leads WHERE id IN ${sql(leadIds)}
    `;
    for (const l of leads) leadMap.set(l.id, l.company_name);
  }

  const out: DigestPlannedActivity[] = [];
  for (const row of rows) {
    const md = (row.metadata ?? {}) as Record<string, unknown>;
    const dueAt = typeof md['due_at'] === 'string' ? (md['due_at'] as string) : null;
    if (!dueAt) continue;
    out.push({
      id: row.id,
      kind: row.event_type,
      leadId: row.target_id,
      leadName: leadMap.get(row.target_id) ?? '(lead silinmiş)',
      dueAtIso: dueAt,
      note: typeof md['note'] === 'string' ? (md['note'] as string) : null,
    });
  }
  return out;
}

async function fetchHotLeads(now: Date): Promise<DigestHotLead[]> {
  const since24hIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await sql<Array<{
    id: string;
    company_name: string;
    score: number | null;
    segment: string | null;
    score_computed_at: string | null;
  }>>`
    SELECT id, company_name, score, segment, score_computed_at
    FROM leads
    WHERE score >= 60
      AND score_computed_at > ${since24hIso}
    ORDER BY score DESC
    LIMIT 20
  `;
  return rows.map((l) => ({
    id: l.id,
    name: l.company_name,
    score: l.score ?? 0,
    segmentLabel: l.segment ? (SEGMENT_LABEL[l.segment] ?? l.segment) : null,
    scoreComputedAt: l.score_computed_at,
  }));
}

async function fetchRottingDeals(now: Date): Promise<DigestRottingDeal[]> {
  // SQL'de doğrudan join + interval filter — Supabase JS'in client-side filter'ından çok daha verimli
  const rows = await sql<Array<{
    id: string;
    title: string;
    value_try: number | null;
    updated_at: string;
    stage_name_tr: string;
    rotting_days: number | null;
    days_stale: number;
  }>>`
    SELECT
      d.id,
      d.title,
      d.value_try,
      d.updated_at,
      s.name_tr AS stage_name_tr,
      s.rotting_days,
      EXTRACT(EPOCH FROM (NOW() - d.updated_at)) / 86400 AS days_stale
    FROM deals d
    INNER JOIN deal_stages s ON s.id = d.stage_id
    WHERE s.is_won = FALSE
      AND s.is_lost = FALSE
      AND s.rotting_days > 0
      AND d.updated_at < (NOW() - (s.rotting_days || ' days')::interval)
    ORDER BY (EXTRACT(EPOCH FROM (NOW() - d.updated_at)) / NULLIF(s.rotting_days, 0)) DESC NULLS LAST
    LIMIT 10
  `;
  return rows.map((d) => ({
    id: d.id,
    title: d.title,
    stageName: d.stage_name_tr ?? 'Bilinmeyen stage',
    daysStale: Math.floor(Number(d.days_stale) || 0),
    rottingThreshold: d.rotting_days ?? 14,
    valueTry: d.value_try,
  }));
}

async function fetchStaleLeads(now: Date): Promise<DigestStaleLead[]> {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await sql<Array<{
    id: string;
    company_name: string;
    last_contacted_at: string | null;
  }>>`
    SELECT id, company_name, last_contacted_at
    FROM leads
    WHERE last_contacted_at < ${cutoff}
      AND status NOT IN ('won', 'lost', 'opted_out')
    ORDER BY last_contacted_at ASC
    LIMIT 10
  `;
  const DAY_MS = 86_400_000;
  return rows.map((l) => {
    const ts = l.last_contacted_at ? new Date(l.last_contacted_at).getTime() : now.getTime();
    const days = Math.floor((now.getTime() - ts) / DAY_MS);
    return {
      id: l.id,
      name: l.company_name,
      daysSinceContact: days,
    };
  });
}

// =========================================================
// Core runner (Hono handler + cron-scheduler ortak çağırır)
// =========================================================

export interface DigestRunResult {
  ok: true;
  sent: number;
  skipped: number;
  errors: Array<{ email: string; error: string }>;
  counts: {
    planned: number;
    hot: number;
    rotting: number;
    stale: number;
  };
  date: string;
  reason?: string;
}

export async function runSalesDailyDigest(): Promise<DigestRunResult> {
  // 1. Toggle check
  const toggleRows = await sql<Array<{ value: any }>>`
    SELECT value FROM app_config WHERE key = 'sales.daily_digest_enabled'
  `;
  const toggleValue = toggleRows[0]?.value;
  const disabled =
    toggleValue === false ||
    toggleValue === 'false' ||
    (typeof toggleValue === 'object' && toggleValue !== null && toggleValue.enabled === false);
  if (disabled) {
    return {
      ok: true,
      sent: 0,
      skipped: 0,
      errors: [],
      counts: { planned: 0, hot: 0, rotting: 0, stale: 0 },
      date: getTrDayBounds(new Date()).dateLabel,
      reason: 'daily_digest_disabled',
    };
  }

  // 2. Recipients
  const profiles = await sql<Array<UserProfileLite & { id: string }>>`
    SELECT id, email, full_name, role::text AS role, active, daily_digest_enabled
    FROM profiles
    WHERE role IN ('super_admin', 'partner')
  `;
  const recipients = selectDigestRecipients(profiles);
  if (recipients.length === 0) {
    return {
      ok: true,
      sent: 0,
      skipped: 0,
      errors: [],
      counts: { planned: 0, hot: 0, rotting: 0, stale: 0 },
      date: getTrDayBounds(new Date()).dateLabel,
      reason: 'no_recipients',
    };
  }

  // 3. Ortak data fetch (Sprint 4a sadelik — per-user owner filter Sprint 5'te)
  const now = new Date();
  const bounds = getTrDayBounds(now);

  const [planned, hotLeads, rotting, stale] = await Promise.all([
    fetchPlannedToday(bounds),
    fetchHotLeads(now),
    fetchRottingDeals(now),
    fetchStaleLeads(now),
  ]);

  // 4. Compose + send per recipient (Resend 5 req/s rate limit'i koru)
  let sent = 0;
  let skipped = 0;
  const errors: Array<{ email: string; error: string }> = [];
  const SEND_GAP_MS = Number(process.env.DIGEST_SEND_GAP_MS ?? '220');
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

  let idx = 0;
  for (const r of recipients) {
    if (idx > 0) await sleep(SEND_GAP_MS);
    idx++;
    if (!r.email) {
      skipped++;
      continue;
    }
    const recipientName = (r.full_name ?? '').trim() || (r.email.split('@')[0] ?? r.email);
    const payload = composeDigestPayload({
      recipientName,
      todayLabel: bounds.dateLabel,
      planned,
      hotLeads,
      rottingDeals: rotting,
      staleLeads: stale,
    });

    const result = await sendDigestViaResend({
      to: r.email,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      senderEmail: DIGEST_SENDER_EMAIL,
      senderName: DIGEST_SENDER_NAME,
      replyTo: DIGEST_REPLY_TO,
      tags: [{ name: 'kind', value: 'sales-daily-digest' }],
    });
    if (result.ok) {
      sent++;
      // activity_events log (best-effort) — user_id + category NOT NULL constraint var
      try {
        await sql`
          INSERT INTO activity_events (
            user_id, event_type, category, points, target_type, target_id, metadata
          ) VALUES (
            ${r.id},
            'sales_digest_sent',
            'standard',
            0,
            'profile',
            ${r.id},
            ${sql.json({
              recipient_email: r.email,
              subject: payload.subject,
              planned_count: planned.length,
              hot_count: hotLeads.length,
              rotting_count: rotting.length,
              stale_count: stale.length,
              resend_message_id: result.messageId ?? null,
            })}
          )
        `;
      } catch (e: any) {
        // log fails shouldn't abort
        console.warn('[cron-daily-digest] activity_events insert failed:', e?.message);
      }
    } else {
      errors.push({ email: r.email, error: result.error ?? 'unknown' });
    }
  }

  return {
    ok: true,
    sent,
    skipped,
    errors,
    counts: {
      planned: planned.length,
      hot: hotLeads.length,
      rotting: rotting.length,
      stale: stale.length,
    },
    date: bounds.dateLabel,
  };
}

// =========================================================
// Hono handler
// =========================================================
export async function handleCronDailyDigest(c: Context): Promise<Response> {
  try {
    const result = await runSalesDailyDigest();
    return c.json(result);
  } catch (e: any) {
    console.error('[cron-daily-digest] fatal:', e?.message);
    return c.json({ error: 'internal', detail: e?.message ?? 'unknown' }, 500);
  }
}
