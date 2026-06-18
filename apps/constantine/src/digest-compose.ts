/**
 * Sales daily digest pure composer (port of supabase/functions/_shared/digest.ts)
 *
 * - composeDigestPayload(input): { subject, html, text }
 * - selectDigestRecipients(profiles): aktif + opt-in olanlar
 *
 * Browser ↔ Node ↔ Deno arası ortak — değişmediği sürece Sales UI'daki
 * `src/sales/lib/digestCompose.ts` ile aynı içerikte tutulmalı.
 */

// =========================================================
// Type definitions
// =========================================================
export interface DigestPlannedActivity {
  id: string;
  kind: 'manual_call' | 'meeting' | 'note' | string;
  leadName: string;
  leadId: string;
  dueAtIso: string;
  note?: string | null;
}

export interface DigestHotLead {
  id: string;
  name: string;
  score: number;
  segmentLabel?: string | null;
  scoreComputedAt?: string | null;
}

export interface DigestRottingDeal {
  id: string;
  title: string;
  stageName: string;
  daysStale: number;
  rottingThreshold: number;
  valueTry?: number | null;
}

export interface DigestStaleLead {
  id: string;
  name: string;
  daysSinceContact: number;
}

// ── Yeni KPI blokları (2026-06-17) ──
export interface DigestCampaignRow {
  name: string;
  sentToday: number;
  repliesLast24h: number;
  queued: number;
}
export interface DigestCampaignSummary {
  campaigns: DigestCampaignRow[];
  sentToday: number;
  repliesLast24h: number;
  newHotWarm24h: number;
  replyRate7dPct: number | null; // null = yeterli veri yok
  queuedTotal: number;
}
export interface DigestDeliverability {
  bouncedToday: number;
  complainedToday: number;
  bounced7d: number;
  complained7d: number;
  delivered7d: number;
  bounceRate7dPct: number | null;
  queueRunwayDays: number | null;
  status: 'healthy' | 'watch' | 'alert';
}
export interface DigestNewDeal {
  id: string;
  title: string;
  valueTry: number | null;
  auto: boolean;
}
export interface DigestUnansweredReply {
  leadId: string;
  leadName: string;
  daysWaiting: number;
}
export interface DigestHotLeadNoDeal {
  id: string;
  name: string;
  score: number | null;
}

export interface DigestInput {
  recipientName: string;
  todayLabel: string;
  // çekirdek (mevcut)
  planned: DigestPlannedActivity[];
  hotLeads: DigestHotLead[];
  rottingDeals: DigestRottingDeal[];
  staleLeads: DigestStaleLead[];
  // yeni bloklar (opsiyonel — yoksa render atlanır)
  campaignSummary?: DigestCampaignSummary | null;
  deliverability?: DigestDeliverability | null;
  newDeals?: DigestNewDeal[];
  unansweredReplies?: DigestUnansweredReply[];
  overdueFollowups?: DigestPlannedActivity[];
  hotLeadsNoDeal?: DigestHotLeadNoDeal[];
  appBaseUrl?: string;
}

export interface DigestPayload {
  subject: string;
  html: string;
  text: string;
}

export interface UserProfileLite {
  id: string;
  email: string | null;
  full_name?: string | null;
  role: string;
  active?: boolean | null;
  daily_digest_enabled?: boolean | null;
}

// =========================================================
// HTML escape
// =========================================================
export function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimeFromIso(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--';
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '--:--';
  }
}

function kindLabel(kind: string): { tr: string; icon: string } {
  switch (kind) {
    case 'manual_call':
      return { tr: 'Telefon', icon: '📞' };
    case 'meeting':
      return { tr: 'Toplantı', icon: '📅' };
    case 'note':
      return { tr: 'Not', icon: '📝' };
    default:
      return { tr: 'Aktivite', icon: '•' };
  }
}

function buildSubject(input: DigestInput): string {
  const d = input.deliverability;
  if (d && d.status === 'alert') return '⚠ Gönderim uyarısı — günlük satış özeti';
  const cs = input.campaignSummary;
  const unanswered = input.unansweredReplies?.length ?? 0;
  if (cs && cs.repliesLast24h > 0) {
    return `${cs.repliesLast24h} yeni yanıt${unanswered > 0 ? ` · ${unanswered} bekliyor` : ''} — günlük özet`;
  }
  if (unanswered > 0) return `${unanswered} yanıt bekliyor — günlük özet`;
  if (cs && cs.sentToday > 0) return `${cs.sentToday} mail gönderildi — günlük özet`;
  const total =
    input.planned.length + input.hotLeads.length + input.rottingDeals.length + input.staleLeads.length;
  if (total === 0) return 'Bugün sakin bir gün — satış özeti';
  if (input.planned.length > 0) return `${input.planned.length} aktivite planlı — bugünün özeti`;
  if (input.hotLeads.length > 0) return `${input.hotLeads.length} yeni sıcak lead — bugünün özeti`;
  if (input.rottingDeals.length > 0) return `${input.rottingDeals.length} çürüyen deal — bugünün özeti`;
  return `${input.staleLeads.length} stale lead — bugünün özeti`;
}

function htmlHeader(title: string): string {
  const t = escapeHtml(title);
  return `<h2 style="font-size:16px;color:#5b21b6;margin:24px 0 8px 0;padding-bottom:6px;border-bottom:1px solid #ede9fe;">${t}</h2>`;
}

function htmlPlannedSection(items: DigestPlannedActivity[]): string {
  if (items.length === 0) return '';
  const rows = items
    .map((a) => {
      const time = escapeHtml(formatTimeFromIso(a.dueAtIso));
      const lead = escapeHtml(a.leadName);
      const kl = kindLabel(a.kind);
      const kindTr = escapeHtml(kl.tr);
      const icon = kl.icon;
      const note = a.note ? `<div style="color:#6b7280;font-size:12px;margin-top:2px;">${escapeHtml(a.note)}</div>` : '';
      return `<li style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
  <div><strong>${time}</strong> ${icon} ${kindTr} · <span style="color:#374151;">${lead}</span></div>
  ${note}
</li>`;
    })
    .join('');
  return `${htmlHeader('Bugünün planlanmış aktiviteleri')}
<ul style="list-style:none;padding:0;margin:0;">
${rows}
</ul>`;
}

function htmlHotLeadsSection(items: DigestHotLead[]): string {
  if (items.length === 0) return '';
  const rows = items
    .map((l) => {
      const name = escapeHtml(l.name);
      const seg = l.segmentLabel ? ` · <span style="color:#6b7280;">${escapeHtml(l.segmentLabel)}</span>` : '';
      return `<li style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
  <div><span style="background:#f59e0b;color:#fff;padding:2px 6px;border-radius:4px;font-size:12px;font-weight:600;">${l.score}</span> <strong>${name}</strong>${seg}</div>
</li>`;
    })
    .join('');
  return `${htmlHeader('Son 24 saatte sıcaklananlar')}
<ul style="list-style:none;padding:0;margin:0;">
${rows}
</ul>`;
}

function htmlRottingSection(items: DigestRottingDeal[]): string {
  if (items.length === 0) return '';
  const rows = items
    .map((d) => {
      const title = escapeHtml(d.title);
      const stage = escapeHtml(d.stageName);
      return `<li style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
  <div>🔥 <strong>${title}</strong> · <span style="color:#6b7280;">${stage}</span></div>
  <div style="color:#dc2626;font-size:12px;margin-top:2px;">${d.daysStale} gündür hareket yok (eşik: ${d.rottingThreshold} gün)</div>
</li>`;
    })
    .join('');
  return `${htmlHeader("Çürüyen deal'lar")}
<ul style="list-style:none;padding:0;margin:0;">
${rows}
</ul>`;
}

function htmlStaleSection(items: DigestStaleLead[]): string {
  if (items.length === 0) return '';
  const rows = items
    .map((l) => {
      const name = escapeHtml(l.name);
      return `<li style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
  <div><strong>${name}</strong> <span style="color:#6b7280;">— ${l.daysSinceContact} gündür temas yok</span></div>
</li>`;
    })
    .join('');
  return `${htmlHeader('Uzun süredir temasta olmadıklarımız')}
<ul style="list-style:none;padding:0;margin:0;">
${rows}
</ul>`;
}

function fmtTry(v: number | null | undefined): string {
  if (v == null) return '—';
  try {
    return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 0 }).format(v);
  } catch {
    return `${Math.round(v)} TL`;
  }
}

// ── Deliverability güvenlik şeridi (spam guardrail) ──
function htmlDeliverabilitySection(d: DigestDeliverability | null | undefined): string {
  if (!d) return '';
  const color = d.status === 'alert' ? '#dc2626' : d.status === 'watch' ? '#d97706' : '#16a34a';
  const bg = d.status === 'alert' ? '#fef2f2' : d.status === 'watch' ? '#fffbeb' : '#f0fdf4';
  const label =
    d.status === 'alert' ? '⚠ DİKKAT — gönderimi yavaşlat'
    : d.status === 'watch' ? 'İzlemede' : '✓ Sağlıklı';
  const rate = d.bounceRate7dPct == null ? '—' : `%${d.bounceRate7dPct.toFixed(1)}`;
  const runway = d.queueRunwayDays == null ? '—' : `~${d.queueRunwayDays} gün`;
  return `${htmlHeader('📤 Gönderim sağlığı')}
<div style="background:${bg};border:1px solid ${color}33;border-radius:8px;padding:12px 14px;">
  <div style="font-weight:600;color:${color};font-size:14px;margin-bottom:6px;">${label}</div>
  <div style="color:#374151;font-size:13px;line-height:1.7;">
    Bugün: <strong>${d.bouncedToday}</strong> bounce · <strong>${d.complainedToday}</strong> spam şikayeti<br>
    7 gün: ${d.bounced7d} bounce / ${d.delivered7d} teslim · bounce oranı <strong>${rate}</strong> · spam ${d.complained7d}<br>
    Kuyrukta ${d.queueRunwayDays == null ? '0' : ''}<strong>${runway}</strong> tükenir (mevcut hızla)
  </div>
</div>`;
}

// ── Kampanya özeti (cold outreach nabzı) ──
function htmlCampaignSection(s: DigestCampaignSummary | null | undefined): string {
  if (!s || s.campaigns.length === 0) return '';
  const rate = s.replyRate7dPct == null ? '—' : `%${s.replyRate7dPct.toFixed(1)}`;
  const cards = `<table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:10px;"><tr>
    <td style="width:25%;text-align:center;padding:8px;background:#f5f3ff;border-radius:6px;"><div style="font-size:22px;font-weight:700;color:#5b21b6;">${s.sentToday}</div><div style="font-size:11px;color:#6b7280;">bugün gönderim</div></td>
    <td style="width:2%;"></td>
    <td style="width:23%;text-align:center;padding:8px;background:#f5f3ff;border-radius:6px;"><div style="font-size:22px;font-weight:700;color:#5b21b6;">${s.repliesLast24h}</div><div style="font-size:11px;color:#6b7280;">son 24s yanıt</div></td>
    <td style="width:2%;"></td>
    <td style="width:23%;text-align:center;padding:8px;background:#f5f3ff;border-radius:6px;"><div style="font-size:22px;font-weight:700;color:#5b21b6;">${s.newHotWarm24h}</div><div style="font-size:11px;color:#6b7280;">yeni sıcak</div></td>
    <td style="width:2%;"></td>
    <td style="width:23%;text-align:center;padding:8px;background:#f5f3ff;border-radius:6px;"><div style="font-size:22px;font-weight:700;color:#5b21b6;">${rate}</div><div style="font-size:11px;color:#6b7280;">yanıt oranı (7g)</div></td>
  </tr></table>`;
  const rows = s.campaigns
    .map((c) => {
      const name = escapeHtml(c.name);
      return `<li style="padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px;">
  <strong>${name}</strong><br>
  <span style="color:#16a34a;">${c.sentToday} gönderim</span> · ${c.repliesLast24h} yanıt · <span style="color:#6b7280;">${c.queued} kuyrukta</span>
</li>`;
    })
    .join('');
  return `${htmlHeader('📨 Kampanya özeti')}
${cards}
<ul style="list-style:none;padding:0;margin:0;">${rows}</ul>`;
}

// ── Aksiyon bloku: yanıtlanmamış yanıtlar ──
function htmlUnansweredSection(items: DigestUnansweredReply[] | undefined): string {
  if (!items || items.length === 0) return '';
  const rows = items
    .map((u) => `<li style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
  <div>💬 <strong>${escapeHtml(u.leadName)}</strong> <span style="color:#dc2626;font-size:12px;">— ${u.daysWaiting} gündür yanıt bekliyor</span></div>
</li>`)
    .join('');
  return `${htmlHeader('⚠️ Yanıtlanmamış yanıtlar')}
<ul style="list-style:none;padding:0;margin:0;">${rows}</ul>`;
}

// ── Aksiyon bloku: gecikmiş takipler ──
function htmlOverdueSection(items: DigestPlannedActivity[] | undefined): string {
  if (!items || items.length === 0) return '';
  const rows = items
    .map((a) => {
      const kl = kindLabel(a.kind);
      return `<li style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
  <div>${kl.icon} ${escapeHtml(kl.tr)} · <strong>${escapeHtml(a.leadName)}</strong></div>
</li>`;
    })
    .join('');
  return `${htmlHeader('⏰ Gecikmiş takipler')}
<ul style="list-style:none;padding:0;margin:0;">${rows}</ul>`;
}

// ── Aksiyon bloku: deal'i olmayan sıcak lead'ler ──
function htmlHotNoDealSection(items: DigestHotLeadNoDeal[] | undefined): string {
  if (!items || items.length === 0) return '';
  const rows = items
    .map((l) => `<li style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
  <div>🔥 <strong>${escapeHtml(l.name)}</strong>${l.score != null ? ` <span style="color:#6b7280;font-size:12px;">(${l.score})</span>` : ''} <span style="color:#6b7280;font-size:12px;">— deal açılmamış</span></div>
</li>`)
    .join('');
  return `${htmlHeader('🔥 Sıcak ama deal yok')}
<ul style="list-style:none;padding:0;margin:0;">${rows}</ul>`;
}

// ── Yeni deal momentumı ──
function htmlNewDealsSection(items: DigestNewDeal[] | undefined): string {
  if (!items || items.length === 0) return '';
  const rows = items
    .map((d) => `<li style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
  <div>${d.auto ? '⚡ ' : ''}<strong>${escapeHtml(d.title)}</strong> <span style="color:#6b7280;font-size:12px;">${d.valueTry != null ? fmtTry(d.valueTry) : 'değer girilmemiş'}${d.auto ? ' · otomatik' : ''}</span></div>
</li>`)
    .join('');
  return `${htmlHeader('🆕 Yeni deal (son 24s)')}
<ul style="list-style:none;padding:0;margin:0;">${rows}</ul>`;
}

// Sakin gün hijyen çöküşü: planlı+çürüyen+stale hepsi boşsa tek satır
function htmlQuietHygieneLine(input: DigestInput): string {
  const empty = input.planned.length === 0 && input.rottingDeals.length === 0 && input.staleLeads.length === 0;
  if (!empty) return '';
  return `<div style="background:#f9fafb;border-radius:6px;padding:10px 12px;color:#6b7280;font-size:13px;margin-top:8px;">✓ Bugün sakin — planlı aktivite, çürüyen deal ve stale lead yok.</div>`;
}

function buildHtml(input: DigestInput): string {
  const today = escapeHtml(input.todayLabel);
  const name = escapeHtml(input.recipientName);
  const intro = `<p style="color:#374151;">İşte bugünün özeti — önce gönderim sağlığı ve fırsatlar, sonra yapılacaklar:</p>`;
  const sections = [
    htmlDeliverabilitySection(input.deliverability),
    htmlCampaignSection(input.campaignSummary),
    htmlNewDealsSection(input.newDeals),
    htmlUnansweredSection(input.unansweredReplies),
    htmlOverdueSection(input.overdueFollowups),
    htmlHotNoDealSection(input.hotLeadsNoDeal),
    htmlHotLeadsSection(input.hotLeads),
    htmlPlannedSection(input.planned),
    htmlRottingSection(input.rottingDeals),
    htmlStaleSection(input.staleLeads),
    htmlQuietHygieneLine(input),
  ]
    .filter(Boolean)
    .join('\n');

  const footer = `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px 0;">
<p style="color:#9ca3af;font-size:12px;">
  Bu mail Constantine Sales otomatik özetidir. Aboneliği yönetmek için Ayarlar &gt; Bildirimler sekmesini kullan.<br>
  ETK 6563 kapsamında ticari elektronik ileti değil — kendi hesabına gönderilen operasyonel mail.
</p>`;

  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <title>Günlük Özet — ${today}</title>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;padding:24px;margin:0;">
  <div style="max-width:600px;margin:0 auto;background:#fff;padding:24px;border-radius:8px;border:1px solid #e5e7eb;">
    <h1 style="font-size:20px;color:#5b21b6;margin:0 0 4px 0;">Günlük Özet</h1>
    <div style="color:#6b7280;font-size:13px;margin-bottom:16px;">${today} · Merhaba ${name}</div>
    ${intro}
    ${sections}
    ${footer}
  </div>
</body>
</html>`;
}

function textHeader(title: string): string {
  return `\n# ${title}\n`;
}

function textPlanned(items: DigestPlannedActivity[]): string {
  if (items.length === 0) return '';
  const rows = items
    .map((a) => {
      const time = formatTimeFromIso(a.dueAtIso);
      const kl = kindLabel(a.kind);
      const base = `- ${time} ${kl.icon} ${kl.tr} · ${a.leadName}`;
      return a.note ? `${base}\n  ${a.note}` : base;
    })
    .join('\n');
  return `${textHeader("Bugünün planlanmış aktiviteleri")}${rows}\n`;
}

function textHot(items: DigestHotLead[]): string {
  if (items.length === 0) return '';
  const rows = items
    .map((l) => {
      const seg = l.segmentLabel ? ` · ${l.segmentLabel}` : '';
      return `- [${l.score}] ${l.name}${seg}`;
    })
    .join('\n');
  return `${textHeader('Son 24 saatte sıcaklananlar')}${rows}\n`;
}

function textRotting(items: DigestRottingDeal[]): string {
  if (items.length === 0) return '';
  const rows = items
    .map((d) => `- ${d.title} · ${d.stageName} — ${d.daysStale} gündür hareket yok (eşik: ${d.rottingThreshold})`)
    .join('\n');
  return `${textHeader("Çürüyen deal'lar")}${rows}\n`;
}

function textStale(items: DigestStaleLead[]): string {
  if (items.length === 0) return '';
  const rows = items.map((l) => `- ${l.name} — ${l.daysSinceContact} gündür temas yok`).join('\n');
  return `${textHeader('Uzun süredir temasta olmadıklarımız')}${rows}\n`;
}

function textDeliverability(d: DigestDeliverability | null | undefined): string {
  if (!d) return '';
  const label = d.status === 'alert' ? 'DİKKAT — yavaşla' : d.status === 'watch' ? 'İzlemede' : 'Sağlıklı';
  const rate = d.bounceRate7dPct == null ? '—' : `%${d.bounceRate7dPct.toFixed(1)}`;
  const runway = d.queueRunwayDays == null ? '—' : `~${d.queueRunwayDays} gün`;
  return `${textHeader('Gönderim sağlığı')}- Durum: ${label}\n- Bugün: ${d.bouncedToday} bounce, ${d.complainedToday} spam şikayeti\n- 7 gün: ${d.bounced7d} bounce / ${d.delivered7d} teslim · oran ${rate} · spam ${d.complained7d}\n- Kuyruk: ${runway} tükenir\n`;
}
function textCampaign(s: DigestCampaignSummary | null | undefined): string {
  if (!s || s.campaigns.length === 0) return '';
  const rate = s.replyRate7dPct == null ? '—' : `%${s.replyRate7dPct.toFixed(1)}`;
  const head = `- Bugün ${s.sentToday} gönderim · son 24s ${s.repliesLast24h} yanıt · ${s.newHotWarm24h} yeni sıcak · yanıt oranı ${rate}\n`;
  const rows = s.campaigns
    .map((c) => `  · ${c.name}: ${c.sentToday} gönderim, ${c.repliesLast24h} yanıt, ${c.queued} kuyrukta`)
    .join('\n');
  return `${textHeader('Kampanya özeti')}${head}${rows}\n`;
}
function textUnanswered(items: DigestUnansweredReply[] | undefined): string {
  if (!items || items.length === 0) return '';
  return `${textHeader('Yanıtlanmamış yanıtlar')}${items.map((u) => `- ${u.leadName} — ${u.daysWaiting} gündür bekliyor`).join('\n')}\n`;
}
function textOverdue(items: DigestPlannedActivity[] | undefined): string {
  if (!items || items.length === 0) return '';
  return `${textHeader('Gecikmiş takipler')}${items.map((a) => `- ${kindLabel(a.kind).tr} · ${a.leadName}`).join('\n')}\n`;
}
function textHotNoDeal(items: DigestHotLeadNoDeal[] | undefined): string {
  if (!items || items.length === 0) return '';
  return `${textHeader('Sıcak ama deal yok')}${items.map((l) => `- ${l.name}${l.score != null ? ` (${l.score})` : ''}`).join('\n')}\n`;
}
function textNewDeals(items: DigestNewDeal[] | undefined): string {
  if (!items || items.length === 0) return '';
  return `${textHeader('Yeni deal (son 24s)')}${items.map((d) => `- ${d.auto ? '[oto] ' : ''}${d.title} — ${d.valueTry != null ? fmtTry(d.valueTry) : 'değer girilmemiş'}`).join('\n')}\n`;
}

function buildText(input: DigestInput): string {
  const hygieneEmpty =
    input.planned.length === 0 && input.rottingDeals.length === 0 && input.staleLeads.length === 0;
  const intro = 'İşte bugünün özeti:';
  const sections = [
    textDeliverability(input.deliverability),
    textCampaign(input.campaignSummary),
    textNewDeals(input.newDeals),
    textUnanswered(input.unansweredReplies),
    textOverdue(input.overdueFollowups),
    textHotNoDeal(input.hotLeadsNoDeal),
    textHot(input.hotLeads),
    textPlanned(input.planned),
    textRotting(input.rottingDeals),
    textStale(input.staleLeads),
    hygieneEmpty ? '\nBugün sakin — planlı aktivite, çürüyen deal ve stale lead yok.\n' : '',
  ]
    .filter(Boolean)
    .join('');
  const footer =
    '\n---\nConstantine Sales otomatik özeti. ETK 6563 kapsamında ticari elektronik ileti değil — operasyonel.';
  return `Günlük Özet — ${input.todayLabel}\nMerhaba ${input.recipientName}\n\n${intro}\n${sections}${footer}`;
}

export function composeDigestPayload(input: DigestInput): DigestPayload {
  return {
    subject: buildSubject(input),
    html: buildHtml(input),
    text: buildText(input),
  };
}

export function selectDigestRecipients<T extends UserProfileLite>(profiles: T[]): T[] {
  return profiles.filter((p) => {
    if (p.role !== 'super_admin' && p.role !== 'partner') return false;
    if (!p.email) return false;
    if (p.active === false) return false;
    if (p.daily_digest_enabled === false) return false;
    return true;
  });
}
