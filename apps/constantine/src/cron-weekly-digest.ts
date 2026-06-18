/**
 * cron-weekly-digest — Haftalık satış trend maili (Pazartesi TR 09:00 / UTC 06:00)
 *
 * SADECE super_admin (Mert) alır — pipeline değeri + kazanılan/kaybedilen tutar gibi
 * FİNANSAL veri içerir, partnerlara gitmez.
 *
 * Bölümler:
 *   1. Bu hafta (son 7g won/lost + değer)
 *   2. Pipeline snapshot (açık deal'ler, aşamaya göre) — v_pipeline_summary
 *   3. Dönüşüm hunisi (lead → contacted → deal → won)
 *   4. Kampanya performansı — v_campaign_metrics
 *   5. En iyi segmentler
 *
 * Toggle: app_config['sales.weekly_digest_enabled'] (default açık)
 * Endpoint: POST /functions/v1/cron-weekly-digest (manuel trigger)
 * Schedule: cron-scheduler.ts "0 6 * * 1" UTC (= Pazartesi TR 09:00)
 */
import type { Context } from 'hono';
import { sql } from './db.js';
import { sendDigestViaResend } from './digest-sender.js';
import { escapeHtml } from './digest-compose.js';

const DIGEST_SENDER_EMAIL = process.env.DIGEST_SENDER_EMAIL ?? 'digest@send.constantineyachts.com';
const DIGEST_SENDER_NAME = process.env.DIGEST_SENDER_NAME ?? 'Constantine Sales';
const DIGEST_REPLY_TO = process.env.DIGEST_REPLY_TO ?? 'mert@constantineyachts.com';

const TR_OFFSET_MS = 3 * 60 * 60 * 1000;
const TR_MONTHS = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];
function trDateLabel(now: Date): string {
  const t = new Date(now.getTime() + TR_OFFSET_MS);
  return `${t.getUTCDate()} ${TR_MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

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

function fmtTry(v: number | null | undefined): string {
  if (v == null) return '—';
  try {
    return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 0 }).format(v);
  } catch {
    return `${Math.round(v)} TL`;
  }
}

// =========================================================
// Types
// =========================================================
interface WonLost { wonCount: number; wonValue: number; lostCount: number; lostValue: number; }
interface PipelineStage { stageName: string; dealCount: number; totalValue: number; weightedValue: number; }
interface Funnel { totalLeads: number; contacted: number; withDeal: number; won: number; }
interface CampaignPerf { name: string; status: string; sent: number; replied: number; replyRatePct: number | null; autoDeals: number; }
interface SegmentPerf { label: string; total: number; progressed: number; pct: number; }
interface WeeklyData {
  wonLost: WonLost;
  pipeline: PipelineStage[];
  pipelineTotalValue: number;
  funnel: Funnel;
  campaigns: CampaignPerf[];
  segments: SegmentPerf[];
}

// =========================================================
// Fetchers (her biri kendi try/catch'i ile)
// =========================================================
async function fetchWonLost7d(): Promise<WonLost> {
  try {
    const rows = await sql<Array<{ won_count: number; won_value: number; lost_count: number; lost_value: number }>>`
      SELECT
        count(*) FILTER (WHERE won_at >= now() - interval '7 days')::int AS won_count,
        coalesce(sum(value_try) FILTER (WHERE won_at >= now() - interval '7 days'), 0)::numeric AS won_value,
        count(*) FILTER (WHERE lost_at >= now() - interval '7 days')::int AS lost_count,
        coalesce(sum(value_try) FILTER (WHERE lost_at >= now() - interval '7 days'), 0)::numeric AS lost_value
      FROM deals
    `;
    const r = rows[0];
    return {
      wonCount: Number(r?.won_count) || 0,
      wonValue: Number(r?.won_value) || 0,
      lostCount: Number(r?.lost_count) || 0,
      lostValue: Number(r?.lost_value) || 0,
    };
  } catch (e: any) {
    console.warn('[cron-weekly-digest] fetchWonLost7d failed:', e?.message);
    return { wonCount: 0, wonValue: 0, lostCount: 0, lostValue: 0 };
  }
}

async function fetchPipelineSnapshot(): Promise<{ stages: PipelineStage[]; total: number }> {
  try {
    const rows = await sql<Array<{ stage_name: string; deal_count: number; total_value: number; weighted_value: number }>>`
      SELECT stage_name,
        deal_count::int AS deal_count,
        total_value_try::numeric AS total_value,
        weighted_value_try::numeric AS weighted_value
      FROM v_pipeline_summary
      WHERE NOT is_won AND NOT is_lost AND deal_count > 0
      ORDER BY display_order
    `;
    const stages = rows.map((r) => ({
      stageName: r.stage_name,
      dealCount: Number(r.deal_count) || 0,
      totalValue: Number(r.total_value) || 0,
      weightedValue: Number(r.weighted_value) || 0,
    }));
    const total = stages.reduce((a, s) => a + s.totalValue, 0);
    return { stages, total };
  } catch (e: any) {
    console.warn('[cron-weekly-digest] fetchPipelineSnapshot failed:', e?.message);
    return { stages: [], total: 0 };
  }
}

async function fetchFunnel(): Promise<Funnel> {
  try {
    const rows = await sql<Array<{ total_leads: number; contacted: number; with_deal: number; won: number }>>`
      SELECT
        (SELECT count(*) FROM leads)::int AS total_leads,
        (SELECT count(*) FROM leads WHERE status IN ('contacted','qualified','in_dialogue','meeting_scheduled','won','lost'))::int AS contacted,
        (SELECT count(*) FROM leads WHERE deal_id IS NOT NULL)::int AS with_deal,
        (SELECT count(*) FROM deals WHERE won_at IS NOT NULL)::int AS won
    `;
    const r = rows[0];
    return {
      totalLeads: Number(r?.total_leads) || 0,
      contacted: Number(r?.contacted) || 0,
      withDeal: Number(r?.with_deal) || 0,
      won: Number(r?.won) || 0,
    };
  } catch (e: any) {
    console.warn('[cron-weekly-digest] fetchFunnel failed:', e?.message);
    return { totalLeads: 0, contacted: 0, withDeal: 0, won: 0 };
  }
}

async function fetchCampaignPerf(): Promise<CampaignPerf[]> {
  try {
    const rows = await sql<Array<{ name: string; status: string; sent: number; replied: number; auto_deals: number }>>`
      SELECT name, status,
        sent_count::int AS sent,
        replied_count::int AS replied,
        auto_deals_count::int AS auto_deals
      FROM v_campaign_metrics
      WHERE status IN ('running', 'completed')
      ORDER BY COALESCE(started_at, created_at) DESC
      LIMIT 8
    `;
    return rows.map((r) => {
      const sent = Number(r.sent) || 0;
      const replied = Number(r.replied) || 0;
      return {
        name: r.name,
        status: r.status,
        sent,
        replied,
        replyRatePct: sent > 0 ? (replied / sent) * 100 : null,
        autoDeals: Number(r.auto_deals) || 0,
      };
    });
  } catch (e: any) {
    console.warn('[cron-weekly-digest] fetchCampaignPerf failed:', e?.message);
    return [];
  }
}

async function fetchTopSegments(): Promise<SegmentPerf[]> {
  try {
    const rows = await sql<Array<{ segment: string; total: number; progressed: number }>>`
      SELECT segment,
        count(*)::int AS total,
        count(*) FILTER (WHERE status IN ('contacted','qualified','in_dialogue','meeting_scheduled','won','lost'))::int AS progressed
      FROM leads
      WHERE segment IS NOT NULL
      GROUP BY segment
      ORDER BY progressed DESC, total DESC
      LIMIT 5
    `;
    return rows.map((r) => {
      const total = Number(r.total) || 0;
      const progressed = Number(r.progressed) || 0;
      return {
        label: SEGMENT_LABEL[r.segment] ?? r.segment,
        total,
        progressed,
        pct: total > 0 ? (progressed / total) * 100 : 0,
      };
    });
  } catch (e: any) {
    console.warn('[cron-weekly-digest] fetchTopSegments failed:', e?.message);
    return [];
  }
}

async function gatherWeeklyData(): Promise<WeeklyData> {
  const [wonLost, pipe, funnel, campaigns, segments] = await Promise.all([
    fetchWonLost7d(),
    fetchPipelineSnapshot(),
    fetchFunnel(),
    fetchCampaignPerf(),
    fetchTopSegments(),
  ]);
  return {
    wonLost,
    pipeline: pipe.stages,
    pipelineTotalValue: pipe.total,
    funnel,
    campaigns,
    segments,
  };
}

// =========================================================
// Compose
// =========================================================
function h2(title: string): string {
  return `<h2 style="font-size:16px;color:#5b21b6;margin:24px 0 8px 0;padding-bottom:6px;border-bottom:1px solid #ede9fe;">${escapeHtml(title)}</h2>`;
}

function buildWeeklySubject(d: WeeklyData): string {
  if (d.wonLost.wonCount > 0) return `Bu hafta ${d.wonLost.wonCount} kazanım — haftalık trend`;
  return 'Haftalık satış trendi';
}

function buildWeeklyHtml(d: WeeklyData, label: string, name: string): string {
  const wl = d.wonLost;
  const wonLostHtml = `${h2('📊 Bu hafta (son 7 gün)')}
<table role="presentation" style="width:100%;border-collapse:collapse;"><tr>
  <td style="width:49%;text-align:center;padding:12px;background:#f0fdf4;border-radius:8px;">
    <div style="font-size:22px;font-weight:700;color:#16a34a;">${wl.wonCount}</div>
    <div style="font-size:12px;color:#6b7280;">kazanılan · ${fmtTry(wl.wonValue)}</div>
  </td>
  <td style="width:2%;"></td>
  <td style="width:49%;text-align:center;padding:12px;background:#fef2f2;border-radius:8px;">
    <div style="font-size:22px;font-weight:700;color:#dc2626;">${wl.lostCount}</div>
    <div style="font-size:12px;color:#6b7280;">kaybedilen · ${fmtTry(wl.lostValue)}</div>
  </td>
</tr></table>`;

  const pipeRows = d.pipeline
    .map((s) => `<li style="padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px;">
  <strong>${escapeHtml(s.stageName)}</strong> · ${s.dealCount} deal <span style="color:#6b7280;">— ${fmtTry(s.totalValue)} (ağırlıklı ${fmtTry(s.weightedValue)})</span>
</li>`)
    .join('');
  const pipeHtml = d.pipeline.length === 0
    ? `${h2('🪜 Pipeline')}<p style="color:#6b7280;font-size:13px;">Açık pipeline boş.</p>`
    : `${h2('🪜 Pipeline (açık deal\'ler)')}
<ul style="list-style:none;padding:0;margin:0;">${pipeRows}</ul>
<div style="font-size:13px;color:#374151;margin-top:6px;">Toplam açık pipeline: <strong>${fmtTry(d.pipelineTotalValue)}</strong></div>`;

  const f = d.funnel;
  const pct = (a: number, b: number) => (b > 0 ? `%${((a / b) * 100).toFixed(1)}` : '—');
  const funnelHtml = `${h2('🔻 Dönüşüm hunisi')}
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px;">
  <tr><td style="padding:5px 0;">Toplam lead</td><td style="text-align:right;font-weight:600;">${f.totalLeads.toLocaleString('tr-TR')}</td></tr>
  <tr><td style="padding:5px 0;border-top:1px solid #f3f4f6;">İletişim kurulan</td><td style="text-align:right;border-top:1px solid #f3f4f6;"><strong>${f.contacted}</strong> <span style="color:#6b7280;">(${pct(f.contacted, f.totalLeads)})</span></td></tr>
  <tr><td style="padding:5px 0;border-top:1px solid #f3f4f6;">Deal açılan</td><td style="text-align:right;border-top:1px solid #f3f4f6;"><strong>${f.withDeal}</strong> <span style="color:#6b7280;">(contacted→deal ${pct(f.withDeal, f.contacted)})</span></td></tr>
  <tr><td style="padding:5px 0;border-top:1px solid #f3f4f6;">Kazanılan</td><td style="text-align:right;border-top:1px solid #f3f4f6;"><strong>${f.won}</strong> <span style="color:#6b7280;">(deal→won ${pct(f.won, f.withDeal)})</span></td></tr>
</table>`;

  const campRows = d.campaigns
    .map((c) => `<li style="padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px;">
  <strong>${escapeHtml(c.name)}</strong> <span style="color:#6b7280;">(${escapeHtml(c.status)})</span><br>
  ${c.sent} gönderim · ${c.replied} yanıt · yanıt oranı ${c.replyRatePct == null ? '—' : `%${c.replyRatePct.toFixed(1)}`}${c.autoDeals > 0 ? ` · ⚡ ${c.autoDeals} auto-deal` : ''}
</li>`)
    .join('');
  const campHtml = d.campaigns.length === 0 ? '' : `${h2('📨 Kampanya performansı')}
<ul style="list-style:none;padding:0;margin:0;">${campRows}</ul>`;

  const segRows = d.segments
    .map((s) => `<li style="padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px;">
  <strong>${escapeHtml(s.label)}</strong> · ${s.progressed}/${s.total} ilerledi <span style="color:#6b7280;">(%${s.pct.toFixed(1)})</span>
</li>`)
    .join('');
  const segHtml = d.segments.length === 0 ? '' : `${h2('🎯 En aktif segmentler')}
<ul style="list-style:none;padding:0;margin:0;">${segRows}</ul>`;

  const footer = `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px 0;">
<p style="color:#9ca3af;font-size:12px;">
  Constantine Sales haftalık trend özeti (yalnızca yönetici). Aboneliği yönetmek için Ayarlar &gt; Bildirimler.<br>
  ETK 6563 kapsamında ticari elektronik ileti değil — kendi hesabına gönderilen operasyonel mail.
</p>`;

  return `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><title>Haftalık Trend — ${escapeHtml(label)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;padding:24px;margin:0;">
  <div style="max-width:600px;margin:0 auto;background:#fff;padding:24px;border-radius:8px;border:1px solid #e5e7eb;">
    <h1 style="font-size:20px;color:#5b21b6;margin:0 0 4px 0;">Haftalık Satış Trendi</h1>
    <div style="color:#6b7280;font-size:13px;margin-bottom:16px;">${escapeHtml(label)} · Merhaba ${escapeHtml(name)}</div>
    ${wonLostHtml}
    ${pipeHtml}
    ${funnelHtml}
    ${campHtml}
    ${segHtml}
    ${footer}
  </div>
</body>
</html>`;
}

function buildWeeklyText(d: WeeklyData, label: string, name: string): string {
  const lines: string[] = [];
  lines.push(`Haftalık Satış Trendi — ${label}`);
  lines.push(`Merhaba ${name}`);
  lines.push('');
  lines.push('# Bu hafta (son 7 gün)');
  lines.push(`- Kazanılan: ${d.wonLost.wonCount} · ${fmtTry(d.wonLost.wonValue)}`);
  lines.push(`- Kaybedilen: ${d.wonLost.lostCount} · ${fmtTry(d.wonLost.lostValue)}`);
  lines.push('');
  lines.push('# Pipeline (açık deal\'ler)');
  if (d.pipeline.length === 0) lines.push('- Açık pipeline boş.');
  else {
    for (const s of d.pipeline) lines.push(`- ${s.stageName}: ${s.dealCount} deal — ${fmtTry(s.totalValue)} (ağırlıklı ${fmtTry(s.weightedValue)})`);
    lines.push(`- Toplam açık pipeline: ${fmtTry(d.pipelineTotalValue)}`);
  }
  lines.push('');
  lines.push('# Dönüşüm hunisi');
  lines.push(`- Toplam lead: ${d.funnel.totalLeads}`);
  lines.push(`- İletişim kurulan: ${d.funnel.contacted}`);
  lines.push(`- Deal açılan: ${d.funnel.withDeal}`);
  lines.push(`- Kazanılan: ${d.funnel.won}`);
  if (d.campaigns.length > 0) {
    lines.push('');
    lines.push('# Kampanya performansı');
    for (const c of d.campaigns) {
      lines.push(`- ${c.name} (${c.status}): ${c.sent} gönderim, ${c.replied} yanıt, oran ${c.replyRatePct == null ? '—' : `%${c.replyRatePct.toFixed(1)}`}${c.autoDeals > 0 ? `, ${c.autoDeals} auto-deal` : ''}`);
    }
  }
  if (d.segments.length > 0) {
    lines.push('');
    lines.push('# En aktif segmentler');
    for (const s of d.segments) lines.push(`- ${s.label}: ${s.progressed}/${s.total} (%${s.pct.toFixed(1)})`);
  }
  lines.push('');
  lines.push('---');
  lines.push('Constantine Sales haftalık trend özeti (yalnızca yönetici).');
  return lines.join('\n');
}

function composeWeekly(d: WeeklyData, recipientName: string, label: string): { subject: string; html: string; text: string } {
  return {
    subject: buildWeeklySubject(d),
    html: buildWeeklyHtml(d, label, recipientName),
    text: buildWeeklyText(d, label, recipientName),
  };
}

// =========================================================
// Recipients — SADECE super_admin
// =========================================================
interface WeeklyRecipient { id: string; email: string; full_name: string | null; }
async function selectWeeklyRecipients(): Promise<WeeklyRecipient[]> {
  const rows = await sql<Array<{ id: string; email: string | null; full_name: string | null }>>`
    SELECT id, email, full_name FROM profiles
    WHERE role = 'super_admin' AND active IS NOT FALSE AND email IS NOT NULL AND email <> ''
  `;
  return rows.filter((r): r is WeeklyRecipient => !!r.email);
}

// =========================================================
// Runner
// =========================================================
export interface WeeklyRunResult {
  ok: true;
  sent: number;
  skipped: number;
  errors: Array<{ email: string; error: string }>;
  date: string;
  reason?: string;
}

export async function runWeeklyTrendDigest(): Promise<WeeklyRunResult> {
  const now = new Date();
  const label = trDateLabel(now);

  // Toggle
  const toggleRows = await sql<Array<{ value: any }>>`
    SELECT value FROM app_config WHERE key = 'sales.weekly_digest_enabled'
  `;
  const tv = toggleRows[0]?.value;
  const disabled =
    tv === false || tv === 'false' ||
    (typeof tv === 'object' && tv !== null && tv.enabled === false);
  if (disabled) {
    return { ok: true, sent: 0, skipped: 0, errors: [], date: label, reason: 'weekly_digest_disabled' };
  }

  const recipients = await selectWeeklyRecipients();
  if (recipients.length === 0) {
    return { ok: true, sent: 0, skipped: 0, errors: [], date: label, reason: 'no_recipients' };
  }

  const data = await gatherWeeklyData();

  let sent = 0;
  let skipped = 0;
  const errors: Array<{ email: string; error: string }> = [];
  const SEND_GAP_MS = Number(process.env.DIGEST_SEND_GAP_MS ?? '220');
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

  let idx = 0;
  for (const r of recipients) {
    if (idx > 0) await sleep(SEND_GAP_MS);
    idx++;
    const recipientName = (r.full_name ?? '').trim() || (r.email.split('@')[0] ?? r.email);
    const payload = composeWeekly(data, recipientName, label);
    const result = await sendDigestViaResend({
      to: r.email,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      senderEmail: DIGEST_SENDER_EMAIL,
      senderName: DIGEST_SENDER_NAME,
      replyTo: DIGEST_REPLY_TO,
      tags: [{ name: 'kind', value: 'sales-weekly-trend' }],
    });
    if (result.ok) {
      sent++;
      try {
        await sql`
          INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
          VALUES (${r.id}, 'sales_weekly_digest_sent', 'standard', 0, 'profile', ${r.id},
            ${sql.json({
              recipient_email: r.email,
              subject: payload.subject,
              won_count: data.wonLost.wonCount,
              pipeline_total: data.pipelineTotalValue,
              resend_message_id: result.messageId ?? null,
            })})
        `;
      } catch (e: any) {
        console.warn('[cron-weekly-digest] activity_events insert failed:', e?.message);
      }
    } else {
      errors.push({ email: r.email, error: result.error ?? 'unknown' });
    }
  }

  return { ok: true, sent, skipped, errors, date: label };
}

// No-send önizleme (gerçek veriyle compose, GÖNDERMEZ)
export async function previewWeeklyTrend(recipientName = 'Mert'): Promise<{ subject: string; html: string; text: string }> {
  const data = await gatherWeeklyData();
  return composeWeekly(data, recipientName, trDateLabel(new Date()));
}

// Hono handler — manuel trigger
export async function handleCronWeeklyDigest(c: Context): Promise<Response> {
  try {
    const result = await runWeeklyTrendDigest();
    return c.json(result);
  } catch (e: any) {
    console.error('[cron-weekly-digest] fatal:', e?.message);
    return c.json({ error: 'internal', detail: e?.message ?? 'unknown' }, 500);
  }
}
