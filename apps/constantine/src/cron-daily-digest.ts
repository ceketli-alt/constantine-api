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
  type DigestPayload,
  type DigestHotLead,
  type DigestPlannedActivity,
  type DigestRottingDeal,
  type DigestStaleLead,
  type UserProfileLite,
  type DigestCampaignSummary,
  type DigestDeliverability,
  type DigestNewDeal,
  type DigestUnansweredReply,
  type DigestHotLeadNoDeal,
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
// Yeni KPI fetcher'ları (2026-06-17) — her biri kendi try/catch'i ile
// (biri patlasa bile rapor düşmesin, o bölüm boş geçsin)
// =========================================================

async function fetchCampaignSummary(bounds: TrDayBounds, now: Date): Promise<DigestCampaignSummary | null> {
  try {
    const since24hIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const since7dIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await sql<Array<{ name: string; sent_today: number; replies_24h: number; queued: number }>>`
      SELECT c.name,
        count(*) FILTER (WHERE ct.sent_at >= ${bounds.startUtcIso} AND ct.sent_at <= ${bounds.endUtcIso})::int AS sent_today,
        count(*) FILTER (WHERE ct.replied_at >= ${since24hIso})::int AS replies_24h,
        count(*) FILTER (WHERE ct.status = 'queued')::int AS queued
      FROM campaigns c JOIN campaign_targets ct ON ct.campaign_id = c.id
      WHERE c.status = 'running'
      GROUP BY c.id, c.name
      ORDER BY c.name
    `;
    const rate = await sql<Array<{ sent7d: number; rep7d: number }>>`
      SELECT
        count(*) FILTER (WHERE ct.sent_at >= ${since7dIso})::int AS sent7d,
        count(*) FILTER (WHERE ct.replied_at >= ${since7dIso})::int AS rep7d
      FROM campaigns c JOIN campaign_targets ct ON ct.campaign_id = c.id
      WHERE c.status = 'running'
    `;
    const hw = await sql<Array<{ n: number }>>`
      SELECT count(DISTINCT ct.lead_id)::int AS n
      FROM campaign_targets ct JOIN leads l ON l.id = ct.lead_id
      WHERE ct.replied_at >= ${since24hIso} AND l.temperature IN ('hot', 'warm')
    `;
    const campaigns = rows.map((r) => ({
      name: r.name,
      sentToday: Number(r.sent_today) || 0,
      repliesLast24h: Number(r.replies_24h) || 0,
      queued: Number(r.queued) || 0,
    }));
    if (campaigns.length === 0) return null;
    const sentToday = campaigns.reduce((a, c) => a + c.sentToday, 0);
    const repliesLast24h = campaigns.reduce((a, c) => a + c.repliesLast24h, 0);
    const queuedTotal = campaigns.reduce((a, c) => a + c.queued, 0);
    const s7 = Number(rate[0]?.sent7d) || 0;
    const r7 = Number(rate[0]?.rep7d) || 0;
    return {
      campaigns,
      sentToday,
      repliesLast24h,
      newHotWarm24h: Number(hw[0]?.n) || 0,
      replyRate7dPct: s7 > 0 ? (r7 / s7) * 100 : null,
      queuedTotal,
    };
  } catch (e: any) {
    console.warn('[cron-daily-digest] fetchCampaignSummary failed:', e?.message);
    return null;
  }
}

async function fetchDeliverability(bounds: TrDayBounds, now: Date): Promise<DigestDeliverability | null> {
  try {
    const since7dIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const ev = await sql<Array<{ bt: number; ct: number; b7: number; c7: number; d7: number }>>`
      SELECT
        count(*) FILTER (WHERE event_type='bounced'    AND occurred_at >= ${bounds.startUtcIso})::int AS bt,
        count(*) FILTER (WHERE event_type='complained' AND occurred_at >= ${bounds.startUtcIso})::int AS ct,
        count(*) FILTER (WHERE event_type='bounced'    AND occurred_at >= ${since7dIso})::int AS b7,
        count(*) FILTER (WHERE event_type='complained' AND occurred_at >= ${since7dIso})::int AS c7,
        count(*) FILTER (WHERE event_type='delivered'  AND occurred_at >= ${since7dIso})::int AS d7
      FROM email_events
    `;
    const row = ev[0] ?? { bt: 0, ct: 0, b7: 0, c7: 0, d7: 0 };
    const bt = Number(row.bt) || 0;
    const b7 = Number(row.b7) || 0;
    const c7 = Number(row.c7) || 0;
    const d7 = Number(row.d7) || 0;
    const denom = d7 + b7;
    const bounceRate7dPct = denom > 0 ? (b7 / denom) * 100 : null;
    const q = await sql<Array<{ cap: number; queued: number }>>`
      SELECT
        coalesce(sum(daily_cap), 0)::int AS cap,
        (SELECT count(*) FROM campaign_targets ct JOIN campaigns c2 ON c2.id = ct.campaign_id
          WHERE c2.status = 'running' AND ct.status = 'queued')::int AS queued
      FROM campaigns WHERE status = 'running'
    `;
    const cap = Number(q[0]?.cap) || 0;
    const queued = Number(q[0]?.queued) || 0;
    const queueRunwayDays = cap > 0 ? Math.ceil(queued / cap) : null;
    let status: 'healthy' | 'watch' | 'alert' = 'healthy';
    if (c7 > 0 || (bounceRate7dPct != null && bounceRate7dPct >= 5)) status = 'alert';
    else if (bt > 0 || (bounceRate7dPct != null && bounceRate7dPct >= 2)) status = 'watch';
    return {
      bouncedToday: bt,
      complainedToday: Number(row.ct) || 0,
      bounced7d: b7,
      complained7d: c7,
      delivered7d: d7,
      bounceRate7dPct,
      queueRunwayDays,
      status,
    };
  } catch (e: any) {
    console.warn('[cron-daily-digest] fetchDeliverability failed:', e?.message);
    return null;
  }
}

async function fetchNewDeals(now: Date): Promise<DigestNewDeal[]> {
  try {
    const since24hIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await sql<Array<{ id: string; title: string; value_try: number | null; notes: string | null }>>`
      SELECT id, title, value_try, notes FROM deals
      WHERE created_at >= ${since24hIso}
      ORDER BY created_at DESC LIMIT 15
    `;
    return rows.map((d) => ({
      id: d.id,
      title: d.title,
      valueTry: d.value_try,
      auto: typeof d.notes === 'string' && d.notes.startsWith('Otomatik:'),
    }));
  } catch (e: any) {
    console.warn('[cron-daily-digest] fetchNewDeals failed:', e?.message);
    return [];
  }
}

async function fetchUnansweredReplies(now: Date): Promise<DigestUnansweredReply[]> {
  try {
    const rows = await sql<Array<{ lead_id: string; company_name: string | null; son_in: string }>>`
      SELECT t.lead_id, l.company_name, m.son_in
      FROM email_threads t
      JOIN leads l ON l.id = t.lead_id
      JOIN LATERAL (
        SELECT
          max(COALESCE(received_at, created_at)) FILTER (WHERE direction = 'inbound')  AS son_in,
          max(COALESCE(sent_at, created_at))      FILTER (WHERE direction = 'outbound') AS son_out
        FROM email_messages WHERE thread_id = t.id
      ) m ON true
      WHERE t.lead_id IS NOT NULL
        AND m.son_in IS NOT NULL
        AND (m.son_out IS NULL OR m.son_in > m.son_out)
      ORDER BY m.son_in ASC
      LIMIT 30
    `;
    const DAY = 86_400_000;
    // lead bazında dedup (fragmente thread'lerde aynı lead 2x çıkmasın → en uzun bekleyeni tut)
    const byLead = new Map<string, DigestUnansweredReply>();
    for (const r of rows) {
      const days = Math.max(0, Math.floor((now.getTime() - new Date(r.son_in).getTime()) / DAY));
      const existing = byLead.get(r.lead_id);
      if (!existing || days > existing.daysWaiting) {
        byLead.set(r.lead_id, { leadId: r.lead_id, leadName: r.company_name ?? '(isimsiz)', daysWaiting: days });
      }
    }
    return Array.from(byLead.values()).sort((a, b) => b.daysWaiting - a.daysWaiting).slice(0, 15);
  } catch (e: any) {
    console.warn('[cron-daily-digest] fetchUnansweredReplies failed:', e?.message);
    return [];
  }
}

async function fetchOverdueFollowups(bounds: TrDayBounds, now: Date): Promise<DigestPlannedActivity[]> {
  try {
    const cutoffIso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await sql<Array<{ id: string; target_id: string; event_type: string; metadata: any }>>`
      SELECT id, target_id, event_type, metadata
      FROM activity_events
      WHERE target_type = 'lead'
        AND event_type IN ('manual_call', 'meeting', 'note')
        AND metadata->>'due_at' < ${bounds.startUtcIso}
        AND metadata->>'due_at' >= ${cutoffIso}
      ORDER BY metadata->>'due_at' ASC
      LIMIT 15
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
  } catch (e: any) {
    console.warn('[cron-daily-digest] fetchOverdueFollowups failed:', e?.message);
    return [];
  }
}

async function fetchHotLeadsNoDeal(): Promise<DigestHotLeadNoDeal[]> {
  try {
    const rows = await sql<Array<{ id: string; company_name: string; score: number | null }>>`
      SELECT id, company_name, score FROM leads
      WHERE temperature = 'hot' AND deal_id IS NULL
        AND status NOT IN ('won', 'lost', 'opted_out')
      ORDER BY score DESC NULLS LAST
      LIMIT 15
    `;
    return rows.map((l) => ({ id: l.id, name: l.company_name, score: l.score }));
  } catch (e: any) {
    console.warn('[cron-daily-digest] fetchHotLeadsNoDeal failed:', e?.message);
    return [];
  }
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

  const [
    planned, hotLeads, rotting, stale,
    campaignSummary, deliverability, newDeals, unansweredReplies, overdueFollowups, hotLeadsNoDeal,
  ] = await Promise.all([
    fetchPlannedToday(bounds),
    fetchHotLeads(now),
    fetchRottingDeals(now),
    fetchStaleLeads(now),
    fetchCampaignSummary(bounds, now),
    fetchDeliverability(bounds, now),
    fetchNewDeals(now),
    fetchUnansweredReplies(now),
    fetchOverdueFollowups(bounds, now),
    fetchHotLeadsNoDeal(),
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
      campaignSummary,
      deliverability,
      newDeals,
      unansweredReplies,
      overdueFollowups,
      hotLeadsNoDeal,
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
// Önizleme (no-send) — gerçek veriyle compose, GÖNDERMEZ
// =========================================================
export async function previewSalesDigest(recipientName = 'Mert', now = new Date()): Promise<DigestPayload> {
  const bounds = getTrDayBounds(now);
  const [
    planned, hotLeads, rotting, stale,
    campaignSummary, deliverability, newDeals, unansweredReplies, overdueFollowups, hotLeadsNoDeal,
  ] = await Promise.all([
    fetchPlannedToday(bounds),
    fetchHotLeads(now),
    fetchRottingDeals(now),
    fetchStaleLeads(now),
    fetchCampaignSummary(bounds, now),
    fetchDeliverability(bounds, now),
    fetchNewDeals(now),
    fetchUnansweredReplies(now),
    fetchOverdueFollowups(bounds, now),
    fetchHotLeadsNoDeal(),
  ]);
  return composeDigestPayload({
    recipientName,
    todayLabel: bounds.dateLabel,
    planned, hotLeads, rottingDeals: rotting, staleLeads: stale,
    campaignSummary, deliverability, newDeals, unansweredReplies, overdueFollowups, hotLeadsNoDeal,
  });
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
