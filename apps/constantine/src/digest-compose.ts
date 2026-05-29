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

export interface DigestInput {
  recipientName: string;
  todayLabel: string;
  planned: DigestPlannedActivity[];
  hotLeads: DigestHotLead[];
  rottingDeals: DigestRottingDeal[];
  staleLeads: DigestStaleLead[];
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
  const total =
    input.planned.length + input.hotLeads.length + input.rottingDeals.length + input.staleLeads.length;
  if (total === 0) return 'Bugün sakin bir gün — özet';
  const parts: string[] = [];
  if (input.planned.length > 0) {
    parts.push(`${input.planned.length} aktivite planlı`);
  } else if (input.hotLeads.length > 0) {
    parts.push(`${input.hotLeads.length} yeni sıcak lead`);
  } else if (input.rottingDeals.length > 0) {
    parts.push(`${input.rottingDeals.length} çürüyen deal`);
  } else if (input.staleLeads.length > 0) {
    parts.push(`${input.staleLeads.length} stale lead`);
  }
  return `${parts[0]} — bugünün özeti`;
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

function buildHtml(input: DigestInput): string {
  const today = escapeHtml(input.todayLabel);
  const name = escapeHtml(input.recipientName);
  const total =
    input.planned.length + input.hotLeads.length + input.rottingDeals.length + input.staleLeads.length;
  const intro =
    total === 0
      ? '<p style="color:#374151;">Bugün için planlanmış aktivite, sıcak lead veya çürüyen deal yok. Sakin bir gün — yeni outreach atmaya iyi zaman.</p>'
      : `<p style="color:#374151;">İşte bugünün özeti — yapılacaklar ve dikkat etmen gerekenler:</p>`;
  const sections = [
    htmlPlannedSection(input.planned),
    htmlHotLeadsSection(input.hotLeads),
    htmlRottingSection(input.rottingDeals),
    htmlStaleSection(input.staleLeads),
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

function buildText(input: DigestInput): string {
  const total =
    input.planned.length + input.hotLeads.length + input.rottingDeals.length + input.staleLeads.length;
  const intro =
    total === 0
      ? 'Bugün için planlanmış aktivite, sıcak lead veya çürüyen deal yok. Sakin bir gün.'
      : 'İşte bugünün özeti:';
  const sections = [
    textPlanned(input.planned),
    textHot(input.hotLeads),
    textRotting(input.rottingDeals),
    textStale(input.staleLeads),
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
