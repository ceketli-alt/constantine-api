/**
 * digest-render.ts — Operations digest renderer (role-aware + variant-aware)
 *
 * Roller × variantlar:
 *   - super_admin × morning  → "Patron paneli — bugün özet + acil + mali snapshot"
 *   - super_admin × evening  → "Yarın hazırlık + bekleyen onaylar"
 *   - partner    × morning   → "Atandığım tekneler · mali snapshot · yedi gün doluluk"
 *   - partner    × evening   → "Yarın bookings + bekleyen ödemeler"
 *   - captain    × morning   → "Bugünün gemisi · turlar · arızalar · görevler"
 *   - captain    × evening   → "Yarın provizyon + tur planı"
 *   - crew       × morning   → "Bugün ne yapacağım"
 *   - crew       × evening   → "Yarın için hazırlık + provizyon listesi"
 *
 * Hava durumu (Open-Meteo) küçük bir chip olarak header'da görünür.
 *
 * Pure render — DB sorgusu yok, sadece data input + format.
 */
import {
  formatWeatherHtml,
  formatWeatherText,
  isWeatherWarning,
  type WeatherSnapshot,
  type DayForecast,
} from './weather.js';

// =========================================================
// Public types
// =========================================================

export type DigestVariant = 'morning' | 'evening';

export interface DigestUser {
  id: string;
  full_name: string | null;
  email: string;
  role: 'super_admin' | 'partner' | 'accountant' | 'captain' | 'crew';
}

export interface DigestBoat {
  id: string;
  name: string;
}

export interface DigestBookingRow {
  id: string;
  boat_id: string;
  start_time: string | null;
  guest_name: string;
  adult: number;
  child: number;
  infant: number;
  total_price: number;
  total_price_try: number;
  currency: string;
  payment_status: 'paid' | 'deposit' | 'pending';
  deposit_amount: number;
  contact: string | null;
  notes: string | null;
  duration_hours: number | null;
  channel_name: string | null;
  channel_type: string | null;
  package_name: string | null;
  date: string;
  approval_status?: string | null;
  assigned_captain_id?: string | null;
  assigned_crew_ids?: string[] | null;
}

export interface DigestTaskRow {
  id: string;
  title: string;
  boat_id: string | null;
  due_date: string | null;
  assigned_to?: string | null;
}

export interface DigestBreakdownRow {
  id: string;
  boat_id: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  reported_at: string;
  photo_count: number;
}

export interface DigestMaintenanceRow {
  id: string;
  boat_id: string;
  title: string;
  next_due_at: string;
}

export interface WeekStats {
  bookingsThisWeek: number;
  bookingsLastWeek: number;
  revenueTryThisWeek: number;
  revenueTryLastWeek: number;
  newLeadsThisWeek?: number; // sales tarafından
}

export interface MonthlyFinancials {
  revenueTryMTD: number;       // month-to-date
  expenseTryMTD: number;
  grossProfitTryMTD: number;
  topExpenseCategories: Array<{ category: string; amount_try: number }>;
}

export interface BoatOccupancy {
  boat_id: string;
  bookingCount: number;
  occupancyPct: number; // 0-100, kabaca booking_count/7
}

export interface DigestData {
  user: DigestUser;
  boatsById: Record<string, DigestBoat>;

  // Core (her zaman doldurulur)
  todayBookings: DigestBookingRow[];
  todayTasks: DigestTaskRow[];
  overdueTasks: DigestTaskRow[];
  openBreakdowns: DigestBreakdownRow[];
  upcomingMaintenance: DigestMaintenanceRow[];
  overdueUnpaidBookings: DigestBookingRow[];

  // Role / variant specific (optional)
  tomorrowBookings?: DigestBookingRow[];
  pendingApprovals?: DigestBookingRow[];
  weekStats?: WeekStats;
  monthlyFinancials?: MonthlyFinancials;
  weeklyOccupancy?: BoatOccupancy[];
}

export interface RenderInput {
  data: DigestData;
  weather: WeatherSnapshot | null;
  dateIso: string;          // bugünün TR tarihi (YYYY-MM-DD)
  tomorrowIso?: string;     // yarının TR tarihi (variant=evening için verilir)
  variant: DigestVariant;
  appBaseUrl?: string;
}

export interface DigestRendered {
  subject: string;
  html: string;
  text: string;
  hasCritical: boolean;
}

// =========================================================
// Constants & helpers
// =========================================================
const TR_MONTHS = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
const TR_MONTHS_SHORT = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
const TR_DAYS = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];
const TR_DAYS_SHORT = ['Paz','Pzt','Sal','Çar','Per','Cum','Cmt'];

const VIP_KEYWORDS = ['vip', 'premium', 'lüks', 'lux'];
const ALERGI_KEYWORDS = ['alerji', 'allerji', 'alerjik', 'allergic', 'allergy', 'gluten', 'fıstık', 'fistik', 'yer fıstığı'];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtCurrency(amount: number, currency: string): string {
  const n = amount.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (currency === 'TRY') return `₺${n}`;
  if (currency === 'EUR') return `€${n}`;
  if (currency === 'USD') return `$${n}`;
  return `${n} ${currency}`;
}

/** Defansif: postgres-js bazen Date object döner; string'e çevir önce. */
function toIsoStr(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  if (iso instanceof Date) return iso.toISOString().slice(0, 10);
  return iso;
}

function fmtDateLong(iso: string | Date | null | undefined): string {
  const s = toIsoStr(iso);
  if (!s) return '';
  const parts = s.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return s;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${d} ${TR_MONTHS[m - 1]} ${TR_DAYS[dt.getUTCDay()]}`;
}

function fmtDateShort(iso: string | Date | null | undefined): string {
  const s = toIsoStr(iso);
  if (!s) return '';
  const parts = s.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return s;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${d} ${TR_MONTHS_SHORT[m - 1]} ${TR_DAYS_SHORT[dt.getUTCDay()]}`;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + 'T00:00:00Z').getTime();
  const b = new Date(toIso + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

function payEmoji(s: 'paid' | 'deposit' | 'pending'): string {
  return s === 'paid' ? '✅' : s === 'deposit' ? '🟡' : '🔴';
}

function payLabel(s: 'paid' | 'deposit' | 'pending'): string {
  return s === 'paid' ? 'Ödendi' : s === 'deposit' ? 'Kaparolu' : 'Ödenmedi';
}

function severityEmoji(s: 'low' | 'medium' | 'high' | 'critical'): string {
  return s === 'critical' ? '🔴' : s === 'high' ? '🟠' : s === 'medium' ? '🟡' : '⚪';
}

function severityLabel(s: 'low' | 'medium' | 'high' | 'critical'): string {
  return s === 'critical' ? 'KRİTİK' : s === 'high' ? 'YÜKSEK' : s === 'medium' ? 'ORTA' : 'DÜŞÜK';
}

function severityOrder(s: 'low' | 'medium' | 'high' | 'critical'): number {
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return order[s] ?? 4;
}

function isVip(notes: string | null): boolean {
  if (!notes) return false;
  const lower = notes.toLowerCase();
  return VIP_KEYWORDS.some((k) => lower.includes(k));
}

function hasAllergy(notes: string | null): boolean {
  if (!notes) return false;
  const lower = notes.toLowerCase();
  return ALERGI_KEYWORDS.some((k) => lower.includes(k));
}

function trendArrow(curr: number, prev: number): string {
  if (prev === 0) return '—';
  const pct = ((curr - prev) / prev) * 100;
  if (pct > 5) return `📈 +${pct.toFixed(0)}%`;
  if (pct < -5) return `📉 ${pct.toFixed(0)}%`;
  return `➡️ ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
}

// =========================================================
// HTML shell (her render için ortak)
// =========================================================
function htmlShell(opts: {
  titleEmoji: string;
  titleText: string;
  subtitle: string;
  sections: string;
  weatherChip: string;
  appBaseUrl: string;
  footer?: string;
}): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;background:#f8f5f0;color:#0a2540;padding:16px;margin:0;">
<div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e0d8ce;border-radius:12px;padding:24px;">
<h1 style="margin:0 0 4px;font-size:18px;color:#0a2540;">${opts.titleEmoji} ${escapeHtml(opts.titleText)}</h1>
<div style="font-size:12px;color:#4B4A6B;margin-bottom:8px;">${escapeHtml(opts.subtitle)}</div>
${opts.weatherChip}
${opts.sections}
<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e0d8ce;font-size:12px;color:#4B4A6B;">
<a href="${opts.appBaseUrl}/manifest" style="color:#0a2540;text-decoration:none;font-weight:600;">Sistemi Aç →</a>
&nbsp;&nbsp;
<a href="${opts.appBaseUrl}/ayarlar/bildirimler" style="color:#4B4A6B;text-decoration:none;">Mail Tercihleri</a>
${opts.footer ?? ''}
</div>
</div></body></html>`;
}

// =========================================================
// Section builders (reusable)
// =========================================================

function bookingItemHtml(bk: DigestBookingRow, boats: Record<string, DigestBoat>): string {
  const boat = boats[bk.boat_id];
  const time = bk.start_time?.slice(0, 5) ?? '--:--';
  const pax = bk.adult + bk.child + bk.infant;
  const dur = bk.duration_hours ? `${bk.duration_hours}sa` : '';
  const acente = bk.channel_type === 'agency' && bk.channel_name ? `[${escapeHtml(bk.channel_name)}] ` : '';
  const remaining = bk.payment_status === 'deposit' ? Math.max(bk.total_price - bk.deposit_amount, 0) : 0;
  const vipBadge = isVip(bk.notes) ? ' <span style="background:#d4af37;color:#fff;padding:1px 5px;border-radius:3px;font-size:11px;">VIP</span>' : '';
  const allergyBadge = hasAllergy(bk.notes) ? ' <span style="background:#dc2626;color:#fff;padding:1px 5px;border-radius:3px;font-size:11px;">⚠ ALERJİ</span>' : '';
  return `<div style="border-left:3px solid #d4af37;padding:8px 12px;margin:4px 0;background:#faf7f2;">
<div style="font-weight:600;color:#0a2540;">${time} · ${escapeHtml(boat?.name ?? '?')} · ${acente}${escapeHtml(bk.guest_name)} (${pax} kişi)${vipBadge}${allergyBadge}</div>
<div style="color:#4B4A6B;font-size:12px;margin-top:2px;">
${escapeHtml(bk.package_name ?? '—')} · ${dur} · ${payEmoji(bk.payment_status)} ${payLabel(bk.payment_status)}
</div>
<div style="color:#4B4A6B;font-size:12px;margin-top:2px;">
${bk.contact ? '📞 ' + escapeHtml(bk.contact) + ' · ' : ''}${fmtCurrency(bk.total_price, bk.currency)}${remaining > 0 ? ' (kalan ' + fmtCurrency(remaining, bk.currency) + ')' : ''}
</div>
${bk.notes ? '<div style="color:#4B4A6B;font-size:12px;font-style:italic;margin-top:2px;">📝 ' + escapeHtml(bk.notes.slice(0, 120)) + (bk.notes.length > 120 ? '…' : '') + '</div>' : ''}
</div>`;
}

function bookingItemText(bk: DigestBookingRow, boats: Record<string, DigestBoat>): string {
  const boat = boats[bk.boat_id];
  const time = bk.start_time?.slice(0, 5) ?? '--:--';
  const pax = bk.adult + bk.child + bk.infant;
  const remaining = bk.payment_status === 'deposit' ? Math.max(bk.total_price - bk.deposit_amount, 0) : 0;
  const vip = isVip(bk.notes) ? ' [VIP]' : '';
  const allergy = hasAllergy(bk.notes) ? ' [ALERJI!]' : '';
  let s = `  ${time}  ${boat?.name ?? '?'}  ${bk.guest_name} (${pax} kisi)${vip}${allergy}\n`;
  s += `         ${bk.package_name ?? '—'} · ${payLabel(bk.payment_status)}\n`;
  s += `         ${bk.contact ?? ''} · ${fmtCurrency(bk.total_price, bk.currency)}${remaining > 0 ? ' (kalan ' + fmtCurrency(remaining, bk.currency) + ')' : ''}`;
  if (bk.notes) s += `\n         Not: ${bk.notes.slice(0, 120)}`;
  return s;
}

function sectionHeader(title: string, accent = '#d4af37'): string {
  return `<h2 style="font-size:14px;color:#0a2540;border-bottom:2px solid ${accent};padding-bottom:6px;margin:24px 0 8px;">${title}</h2>`;
}

function sectionHeaderDanger(title: string): string {
  return `<h2 style="font-size:14px;color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:6px;margin:24px 0 8px;">${title}</h2>`;
}

function buildBreakdownsSection(items: DigestBreakdownRow[], boats: Record<string, DigestBoat>, dateIso: string, onlyHighCritical = false): { html: string; text: string } {
  const filtered = onlyHighCritical ? items.filter(b => b.severity === 'critical' || b.severity === 'high') : items;
  if (filtered.length === 0) return { html: '', text: '' };
  const sorted = [...filtered].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));
  const title = onlyHighCritical ? `🚨 ACİL ARIZALAR (${filtered.length})` : `🚨 TEKNE SAĞLIĞI — Arızalar (${filtered.length})`;
  let html = onlyHighCritical ? sectionHeaderDanger(title) : sectionHeader(title);
  html += `<ul style="margin:0;padding-left:20px;color:#0a2540;font-size:13px;">`;
  let text = `\n--- ${title} ---\n`;
  for (const br of sorted) {
    const boat = boats[br.boat_id];
    const days = daysBetween(br.reported_at.slice(0, 10), dateIso);
    html += `<li>${severityEmoji(br.severity)} <strong>${severityLabel(br.severity)}</strong> ${escapeHtml(boat?.name ?? '?')} — ${escapeHtml(br.title)} <span style="color:#4B4A6B;">(${days} gündür açık${br.photo_count > 0 ? ' · 📷 ' + br.photo_count + ' foto' : ''})</span></li>`;
    text += `  ${severityLabel(br.severity)} ${boat?.name ?? '?'} — ${br.title} (${days} gun)\n`;
  }
  html += `</ul>`;
  return { html, text };
}

function buildTasksSection(items: DigestTaskRow[], boats: Record<string, DigestBoat>, title: string, isOverdue = false, dateIso?: string): { html: string; text: string } {
  if (items.length === 0) return { html: '', text: '' };
  let html = isOverdue ? sectionHeaderDanger(title) : sectionHeader(title);
  html += `<ul style="margin:0;padding-left:20px;color:#0a2540;font-size:13px;">`;
  let text = `\n--- ${title} ---\n`;
  for (const t of items) {
    const boat = t.boat_id ? boats[t.boat_id] : null;
    if (isOverdue && t.due_date && dateIso) {
      const days = daysBetween(t.due_date, dateIso);
      html += `<li>${escapeHtml(t.title)} <span style="color:#dc2626;">(${days} gün gecikti)</span>${boat ? ' — <span style="color:#4B4A6B;">' + escapeHtml(boat.name) + '</span>' : ''}</li>`;
      text += `  • ${t.title} (${days} gun gecikti)${boat ? ' — ' + boat.name : ''}\n`;
    } else {
      html += `<li>${escapeHtml(t.title)}${boat ? ' — <span style="color:#4B4A6B;">' + escapeHtml(boat.name) + '</span>' : ''}</li>`;
      text += `  • ${t.title}${boat ? ' — ' + boat.name : ''}\n`;
    }
  }
  html += `</ul>`;
  return { html, text };
}

function buildMaintenanceSection(items: DigestMaintenanceRow[], boats: Record<string, DigestBoat>, dateIso: string): { html: string; text: string } {
  if (items.length === 0) return { html: '', text: '' };
  let html = sectionHeader(`🔧 Yaklaşan Bakım (${items.length})`);
  html += `<ul style="margin:0;padding-left:20px;color:#0a2540;font-size:13px;">`;
  let text = `\n--- YAKLASAN BAKIM ---\n`;
  for (const mt of items) {
    const boat = boats[mt.boat_id];
    const days = daysBetween(dateIso, mt.next_due_at);
    const tag = days < 0 ? `${-days} gün gecikti` : days === 0 ? 'bugün' : `${days} gün kaldı`;
    const danger = days < 0 ? '#dc2626' : '#4B4A6B';
    html += `<li>🟡 ${escapeHtml(boat?.name ?? '?')} — ${escapeHtml(mt.title)} <span style="color:${danger};">(${tag})</span></li>`;
    text += `  BAKIM ${boat?.name ?? '?'} — ${mt.title} (${tag})\n`;
  }
  html += `</ul>`;
  return { html, text };
}

function buildOverdueUnpaidSection(items: DigestBookingRow[], boats: Record<string, DigestBoat>, dateIso: string): { html: string; text: string } {
  if (items.length === 0) return { html: '', text: '' };
  const total = items.reduce((s, b) => s + (b.total_price_try || 0) - (b.payment_status === 'deposit' ? b.deposit_amount : 0), 0);
  let html = sectionHeaderDanger(`💸 GEÇMİŞ ÖDENMEMİŞ (${items.length})`);
  html += `<ul style="margin:0;padding-left:20px;color:#0a2540;font-size:13px;">`;
  let text = `\n--- GECMIS ODENMEMIS (${items.length}) ---\n`;
  const top = items.slice(0, 10);
  for (const bk of top) {
    const boat = boats[bk.boat_id];
    const days = daysBetween(bk.date, dateIso);
    const remaining = bk.payment_status === 'deposit' ? bk.total_price - bk.deposit_amount : bk.total_price;
    html += `<li>${fmtDateShort(bk.date)} · ${escapeHtml(boat?.name ?? '?')} · ${escapeHtml(bk.guest_name)} · ${fmtCurrency(remaining, bk.currency)} <span style="color:#4B4A6B;">(${days} gün)</span></li>`;
    text += `  ${fmtDateShort(bk.date)} · ${boat?.name ?? '?'} · ${bk.guest_name} · ${fmtCurrency(remaining, bk.currency)} (${days} gun)\n`;
  }
  if (items.length > 10) {
    html += `<li style="color:#4B4A6B;font-style:italic;">ve ${items.length - 10} tane daha →</li>`;
    text += `  ...ve ${items.length - 10} tane daha\n`;
  }
  html += `</ul><div style="font-size:13px;color:#dc2626;font-weight:600;margin-top:8px;">Toplam: ${fmtCurrency(total, 'TRY')}</div>`;
  text += `  TOPLAM: ${fmtCurrency(total, 'TRY')}\n`;
  return { html, text };
}

function buildBookingsListSection(bookings: DigestBookingRow[], boats: Record<string, DigestBoat>, title: string): { html: string; text: string } {
  if (bookings.length === 0) return { html: '', text: '' };
  const sorted = [...bookings].sort((a, b) => (a.start_time ?? '99').localeCompare(b.start_time ?? '99'));
  const totalPax = bookings.reduce((s, b) => s + b.adult + b.child + b.infant, 0);
  const totalRevenueTry = bookings.reduce((s, b) => s + (b.total_price_try || 0), 0);
  let html = sectionHeader(`${title} (${bookings.length})`);
  html += `<div style="font-size:12px;color:#4B4A6B;margin-bottom:12px;">${totalPax} misafir · ${fmtCurrency(totalRevenueTry, 'TRY')} tahmini ciro</div>`;
  let text = `\n--- ${title} (${bookings.length}, ${totalPax} misafir, ${fmtCurrency(totalRevenueTry, 'TRY')}) ---\n`;
  for (const bk of sorted) {
    html += bookingItemHtml(bk, boats);
    text += bookingItemText(bk, boats) + '\n';
  }
  return { html, text };
}

function buildPendingApprovalsSection(items: DigestBookingRow[], boats: Record<string, DigestBoat>): { html: string; text: string } {
  if (!items || items.length === 0) return { html: '', text: '' };
  let html = sectionHeaderDanger(`🆕 ONAY BEKLEYEN REZERVASYONLAR (${items.length})`);
  html += `<ul style="margin:0;padding-left:20px;color:#0a2540;font-size:13px;">`;
  let text = `\n--- ONAY BEKLEYEN (${items.length}) ---\n`;
  for (const bk of items) {
    const boat = boats[bk.boat_id];
    html += `<li>${fmtDateShort(bk.date)} · ${escapeHtml(boat?.name ?? '?')} · ${escapeHtml(bk.guest_name)} · ${fmtCurrency(bk.total_price, bk.currency)}</li>`;
    text += `  ${fmtDateShort(bk.date)} · ${boat?.name ?? '?'} · ${bk.guest_name} · ${fmtCurrency(bk.total_price, bk.currency)}\n`;
  }
  html += `</ul>`;
  return { html, text };
}

function buildWeekStatsSection(s: WeekStats | undefined): { html: string; text: string } {
  if (!s) return { html: '', text: '' };
  const bArrow = trendArrow(s.bookingsThisWeek, s.bookingsLastWeek);
  const rArrow = trendArrow(s.revenueTryThisWeek, s.revenueTryLastWeek);
  let html = sectionHeader(`📊 Bu Hafta vs Geçen Hafta`);
  html += `<table style="width:100%;font-size:13px;color:#0a2540;border-collapse:collapse;">
<tr><td style="padding:4px 0;">Rezervasyonlar</td><td style="text-align:right;font-weight:600;">${s.bookingsThisWeek} ${bArrow}</td></tr>
<tr><td style="padding:4px 0;">Ciro (TRY)</td><td style="text-align:right;font-weight:600;">${fmtCurrency(s.revenueTryThisWeek, 'TRY')} ${rArrow}</td></tr>
${s.newLeadsThisWeek !== undefined ? `<tr><td style="padding:4px 0;">Yeni Sales Lead</td><td style="text-align:right;font-weight:600;">${s.newLeadsThisWeek}</td></tr>` : ''}
</table>`;
  let text = `\n--- BU HAFTA vs GECEN HAFTA ---\n  Bookings: ${s.bookingsThisWeek} (${bArrow})\n  Ciro: ${fmtCurrency(s.revenueTryThisWeek, 'TRY')} (${rArrow})\n${s.newLeadsThisWeek !== undefined ? `  Yeni leads: ${s.newLeadsThisWeek}\n` : ''}`;
  return { html, text };
}

function buildMonthlyFinancialsSection(f: MonthlyFinancials | undefined): { html: string; text: string } {
  if (!f) return { html: '', text: '' };
  let html = sectionHeader(`💰 Ay Başından Bugüne`);
  html += `<table style="width:100%;font-size:13px;color:#0a2540;border-collapse:collapse;margin-bottom:8px;">
<tr><td style="padding:4px 0;">Ciro</td><td style="text-align:right;font-weight:600;">${fmtCurrency(f.revenueTryMTD, 'TRY')}</td></tr>
<tr><td style="padding:4px 0;">Masraf</td><td style="text-align:right;font-weight:600;color:#dc2626;">${fmtCurrency(f.expenseTryMTD, 'TRY')}</td></tr>
<tr><td style="padding:4px 0;border-top:1px solid #e0d8ce;"><strong>Brüt kar</strong></td><td style="text-align:right;font-weight:700;color:${f.grossProfitTryMTD >= 0 ? '#059669' : '#dc2626'};border-top:1px solid #e0d8ce;">${fmtCurrency(f.grossProfitTryMTD, 'TRY')}</td></tr>
</table>`;
  if (f.topExpenseCategories.length > 0) {
    html += `<div style="font-size:12px;color:#4B4A6B;">En çok harcanan: ${f.topExpenseCategories.slice(0, 3).map(c => `${escapeHtml(c.category)} (${fmtCurrency(c.amount_try, 'TRY')})`).join(' · ')}</div>`;
  }
  let text = `\n--- AY BASINDAN BUGUNE ---\n  Ciro: ${fmtCurrency(f.revenueTryMTD, 'TRY')}\n  Masraf: ${fmtCurrency(f.expenseTryMTD, 'TRY')}\n  Brut kar: ${fmtCurrency(f.grossProfitTryMTD, 'TRY')}\n`;
  if (f.topExpenseCategories.length > 0) {
    text += `  En cok harcanan: ${f.topExpenseCategories.slice(0, 3).map(c => `${c.category} (${fmtCurrency(c.amount_try, 'TRY')})`).join(', ')}\n`;
  }
  return { html, text };
}

function buildWeeklyOccupancySection(occ: BoatOccupancy[] | undefined, boats: Record<string, DigestBoat>): { html: string; text: string } {
  if (!occ || occ.length === 0) return { html: '', text: '' };
  let html = sectionHeader(`🔮 Önümüzdeki 7 Gün Doluluk`);
  html += `<ul style="margin:0;padding-left:20px;color:#0a2540;font-size:13px;">`;
  let text = `\n--- 7 GUN DOLULUK ---\n`;
  for (const o of occ) {
    const boat = boats[o.boat_id];
    const color = o.occupancyPct >= 70 ? '#059669' : o.occupancyPct >= 40 ? '#d4af37' : '#dc2626';
    html += `<li>${escapeHtml(boat?.name ?? '?')} — <span style="color:${color};font-weight:600;">${o.occupancyPct}%</span> (${o.bookingCount}/7)</li>`;
    text += `  ${boat?.name ?? '?'} — %${o.occupancyPct} (${o.bookingCount}/7)\n`;
  }
  html += `</ul>`;
  return { html, text };
}

// =========================================================
// Role-specific renderers
// =========================================================

function renderSuperAdmin(input: RenderInput): DigestRendered {
  const { data, weather, dateIso, tomorrowIso, variant } = input;
  const appBaseUrl = input.appBaseUrl ?? 'https://crm.constantineyachts.com';
  const today = weather?.today ?? null;
  const tomorrow = weather?.tomorrow ?? null;

  if (variant === 'evening') {
    // Akşam: yarın hazırlığı + bekleyen onaylar
    const tomorrowBookings = data.tomorrowBookings ?? [];
    const pendingApprovals = data.pendingApprovals ?? [];
    const totalPax = tomorrowBookings.reduce((s, b) => s + b.adult + b.child + b.infant, 0);
    const totalRev = tomorrowBookings.reduce((s, b) => s + (b.total_price_try || 0), 0);

    let subject = `🌙 Yarın hazırlık · ${tomorrowBookings.length} tur, ${totalPax} misafir`;
    if (pendingApprovals.length > 0) subject += ` · ${pendingApprovals.length} onay 🆕`;
    if (tomorrow && isWeatherWarning(tomorrow)) subject += ` · ⚠ hava`;

    const sections: string[] = [];
    const textParts: string[] = [];

    const bks = buildBookingsListSection(tomorrowBookings, data.boatsById, '🛥 YARINKI TURLAR');
    sections.push(bks.html); textParts.push(bks.text);

    const pa = buildPendingApprovalsSection(pendingApprovals, data.boatsById);
    sections.push(pa.html); textParts.push(pa.text);

    const br = buildBreakdownsSection(data.openBreakdowns, data.boatsById, dateIso, true);
    sections.push(br.html); textParts.push(br.text);

    const mt = buildMaintenanceSection(data.upcomingMaintenance, data.boatsById, dateIso);
    sections.push(mt.html); textParts.push(mt.text);

    return {
      subject,
      html: htmlShell({
        titleEmoji: '🌙',
        titleText: 'Yarın için Hazırlık',
        subtitle: `${fmtDateLong(tomorrowIso ?? dateIso)} · Constantine Yachts`,
        weatherChip: formatWeatherHtml(tomorrow, 'Yarın'),
        sections: sections.filter(Boolean).join('\n'),
        appBaseUrl,
      }),
      text: `Yarin Hazirlik — ${fmtDateLong(tomorrowIso ?? dateIso)}\n${formatWeatherText(tomorrow, 'Yarin')}\n${textParts.filter(Boolean).join('')}`,
      hasCritical: pendingApprovals.length > 0 || data.openBreakdowns.some(b => b.severity === 'critical'),
    };
  }

  // MORNING — patron paneli
  const todayBookings = data.todayBookings;
  const totalPax = todayBookings.reduce((s, b) => s + b.adult + b.child + b.infant, 0);
  const totalRev = todayBookings.reduce((s, b) => s + (b.total_price_try || 0), 0);
  const criticalCount = data.openBreakdowns.filter(b => b.severity === 'critical' || b.severity === 'high').length;
  const pendingCount = (data.pendingApprovals ?? []).length;

  let subject = `🌅 Constantine — ${fmtDateShort(dateIso)} · ${todayBookings.length} tur, ${fmtCurrency(totalRev, 'TRY')} ciro`;
  if (criticalCount > 0) subject += ` · ${criticalCount} acil 🚨`;
  if (pendingCount > 0) subject += ` · ${pendingCount} onay`;

  const sections: string[] = [];
  const textParts: string[] = [];

  const bks = buildBookingsListSection(todayBookings, data.boatsById, '🛥 BUGÜNKÜ TURLAR');
  sections.push(bks.html); textParts.push(bks.text);

  const br = buildBreakdownsSection(data.openBreakdowns, data.boatsById, dateIso, true);
  sections.push(br.html); textParts.push(br.text);

  const mt = buildMaintenanceSection(data.upcomingMaintenance, data.boatsById, dateIso);
  sections.push(mt.html); textParts.push(mt.text);

  const ou = buildOverdueUnpaidSection(data.overdueUnpaidBookings, data.boatsById, dateIso);
  sections.push(ou.html); textParts.push(ou.text);

  const ws = buildWeekStatsSection(data.weekStats);
  sections.push(ws.html); textParts.push(ws.text);

  const ot = buildTasksSection(data.overdueTasks, data.boatsById, `⏰ GECİKEN GÖREVLER (${data.overdueTasks.length})`, true, dateIso);
  sections.push(ot.html); textParts.push(ot.text);

  const pa = buildPendingApprovalsSection(data.pendingApprovals ?? [], data.boatsById);
  sections.push(pa.html); textParts.push(pa.text);

  return {
    subject,
    html: htmlShell({
      titleEmoji: '🌅',
      titleText: 'Patron Paneli — Bugün',
      subtitle: `${fmtDateLong(dateIso)} · Constantine Yachts`,
      weatherChip: formatWeatherHtml(today, 'Bugün'),
      sections: sections.filter(Boolean).join('\n'),
      appBaseUrl,
    }),
    text: `Patron Paneli — ${fmtDateLong(dateIso)}\n${formatWeatherText(today, 'Bugun')}\n${textParts.filter(Boolean).join('')}`,
    hasCritical: criticalCount > 0,
  };
}

function renderPartner(input: RenderInput): DigestRendered {
  const { data, weather, dateIso, tomorrowIso, variant } = input;
  const appBaseUrl = input.appBaseUrl ?? 'https://crm.constantineyachts.com';
  const today = weather?.today ?? null;
  const tomorrow = weather?.tomorrow ?? null;

  if (variant === 'evening') {
    const tomorrowBookings = data.tomorrowBookings ?? [];
    const totalRev = tomorrowBookings.reduce((s, b) => s + (b.total_price_try || 0), 0);
    let subject = `🌙 Yarın · ${tomorrowBookings.length} tur, ${fmtCurrency(totalRev, 'TRY')} · ortak özet`;
    if (tomorrow && isWeatherWarning(tomorrow)) subject += ` · ⚠ hava`;

    const sections: string[] = [];
    const textParts: string[] = [];

    const bks = buildBookingsListSection(tomorrowBookings, data.boatsById, '🛥 YARIN — Teknelerim');
    sections.push(bks.html); textParts.push(bks.text);

    const ou = buildOverdueUnpaidSection(data.overdueUnpaidBookings, data.boatsById, dateIso);
    sections.push(ou.html); textParts.push(ou.text);

    const br = buildBreakdownsSection(data.openBreakdowns, data.boatsById, dateIso, true);
    sections.push(br.html); textParts.push(br.text);

    return {
      subject,
      html: htmlShell({
        titleEmoji: '🌙',
        titleText: 'Yarın · Ortak Özet',
        subtitle: `${fmtDateLong(tomorrowIso ?? dateIso)} · Constantine Yachts`,
        weatherChip: formatWeatherHtml(tomorrow, 'Yarın'),
        sections: sections.filter(Boolean).join('\n'),
        appBaseUrl,
      }),
      text: `Yarin Ozeti — ${fmtDateLong(tomorrowIso ?? dateIso)}\n${formatWeatherText(tomorrow, 'Yarin')}\n${textParts.filter(Boolean).join('')}`,
      hasCritical: data.openBreakdowns.some(b => b.severity === 'critical'),
    };
  }

  // MORNING — ortak görünümü
  const todayBookings = data.todayBookings;
  const totalRev = todayBookings.reduce((s, b) => s + (b.total_price_try || 0), 0);
  let subject = `📈 ${fmtDateShort(dateIso)} · ${todayBookings.length} tur, ${fmtCurrency(totalRev, 'TRY')} · ortak özet`;
  if (data.openBreakdowns.some(b => b.severity === 'critical' || b.severity === 'high')) subject += ` · arıza var`;

  const sections: string[] = [];
  const textParts: string[] = [];

  const bks = buildBookingsListSection(todayBookings, data.boatsById, '🛥 BUGÜN — Teknelerim');
  sections.push(bks.html); textParts.push(bks.text);

  const mf = buildMonthlyFinancialsSection(data.monthlyFinancials);
  sections.push(mf.html); textParts.push(mf.text);

  const ou = buildOverdueUnpaidSection(data.overdueUnpaidBookings, data.boatsById, dateIso);
  sections.push(ou.html); textParts.push(ou.text);

  const br = buildBreakdownsSection(data.openBreakdowns, data.boatsById, dateIso, true);
  sections.push(br.html); textParts.push(br.text);

  const wo = buildWeeklyOccupancySection(data.weeklyOccupancy, data.boatsById);
  sections.push(wo.html); textParts.push(wo.text);

  return {
    subject,
    html: htmlShell({
      titleEmoji: '📈',
      titleText: 'Ortak Özeti — Bugün',
      subtitle: `${fmtDateLong(dateIso)} · Constantine Yachts`,
      weatherChip: formatWeatherHtml(today, 'Bugün'),
      sections: sections.filter(Boolean).join('\n'),
      appBaseUrl,
    }),
    text: `Ortak Ozeti — ${fmtDateLong(dateIso)}\n${formatWeatherText(today, 'Bugun')}\n${textParts.filter(Boolean).join('')}`,
    hasCritical: data.openBreakdowns.some(b => b.severity === 'critical'),
  };
}

function renderCaptain(input: RenderInput): DigestRendered {
  const { data, weather, dateIso, tomorrowIso, variant } = input;
  const appBaseUrl = input.appBaseUrl ?? 'https://crm.constantineyachts.com';
  const today = weather?.today ?? null;
  const tomorrow = weather?.tomorrow ?? null;

  if (variant === 'evening') {
    const tomorrowBookings = data.tomorrowBookings ?? [];
    const totalPax = tomorrowBookings.reduce((s, b) => s + b.adult + b.child + b.infant, 0);
    let subject = `🌙 Yarın hazırlık · ${tomorrowBookings.length} tur, ${totalPax} misafir`;
    if (tomorrow && isWeatherWarning(tomorrow)) subject += ` · ⚠ hava`;

    const sections: string[] = [];
    const textParts: string[] = [];

    const bks = buildBookingsListSection(tomorrowBookings, data.boatsById, '⛵ YARIN — Turlarım');
    sections.push(bks.html); textParts.push(bks.text);

    // Yarın için bana atanmış görevler
    if (data.todayTasks.length > 0) {
      // todayTasks aslında tomorrow için fetch edilmiş olmalı (evening variant). Adı semantik.
      const tt = buildTasksSection(data.todayTasks, data.boatsById, `✓ YARIN İÇİN GÖREVLERİM (${data.todayTasks.length})`);
      sections.push(tt.html); textParts.push(tt.text);
    }

    const br = buildBreakdownsSection(data.openBreakdowns, data.boatsById, dateIso, false);
    sections.push(br.html); textParts.push(br.text);

    return {
      subject,
      html: htmlShell({
        titleEmoji: '🌙',
        titleText: 'Yarın için Hazırlık',
        subtitle: `${fmtDateLong(tomorrowIso ?? dateIso)} · Kaptan Brief`,
        weatherChip: formatWeatherHtml(tomorrow, 'Yarın'),
        sections: sections.filter(Boolean).join('\n'),
        appBaseUrl,
      }),
      text: `Yarin Hazirlik — ${fmtDateLong(tomorrowIso ?? dateIso)}\n${formatWeatherText(tomorrow, 'Yarin')}\n${textParts.filter(Boolean).join('')}`,
      hasCritical: data.openBreakdowns.some(b => b.severity === 'critical'),
    };
  }

  // MORNING — kaptan briefingi
  const todayBookings = data.todayBookings;
  const totalPax = todayBookings.reduce((s, b) => s + b.adult + b.child + b.infant, 0);
  let subject = `⛵ ${fmtDateShort(dateIso)} · ${todayBookings.length} tur, ${totalPax} misafir`;
  if (today && isWeatherWarning(today)) subject += ` · ⚠ hava`;

  const sections: string[] = [];
  const textParts: string[] = [];

  const bks = buildBookingsListSection(todayBookings, data.boatsById, '⛵ BUGÜNKÜ TURLARIM');
  sections.push(bks.html); textParts.push(bks.text);

  const br = buildBreakdownsSection(data.openBreakdowns, data.boatsById, dateIso, false);
  sections.push(br.html); textParts.push(br.text);

  const mt = buildMaintenanceSection(data.upcomingMaintenance, data.boatsById, dateIso);
  sections.push(mt.html); textParts.push(mt.text);

  const tt = buildTasksSection(data.todayTasks, data.boatsById, `✓ BUGÜNÜN GÖREVLERİ (${data.todayTasks.length})`);
  sections.push(tt.html); textParts.push(tt.text);

  const ot = buildTasksSection(data.overdueTasks, data.boatsById, `⏰ GECİKEN GÖREVLERİM (${data.overdueTasks.length})`, true, dateIso);
  sections.push(ot.html); textParts.push(ot.text);

  // Yarın preview (sabah maili crew/captain için)
  if (data.tomorrowBookings && data.tomorrowBookings.length > 0) {
    let html = sectionHeader(`📅 Yarın Önizleme (${data.tomorrowBookings.length} tur)`);
    html += '<ul style="margin:0;padding-left:20px;color:#0a2540;font-size:13px;">';
    let text = `\n--- YARIN ONIZLEME (${data.tomorrowBookings.length}) ---\n`;
    for (const bk of data.tomorrowBookings.slice(0, 5)) {
      const boat = data.boatsById[bk.boat_id];
      const time = bk.start_time?.slice(0, 5) ?? '--:--';
      const pax = bk.adult + bk.child + bk.infant;
      html += `<li>${time} · ${escapeHtml(boat?.name ?? '?')} · ${pax} kişi · ${escapeHtml(bk.package_name ?? '—')}</li>`;
      text += `  ${time} · ${boat?.name ?? '?'} · ${pax} kisi · ${bk.package_name ?? '—'}\n`;
    }
    html += '</ul>';
    sections.push(html); textParts.push(text);
  }

  return {
    subject,
    html: htmlShell({
      titleEmoji: '⛵',
      titleText: 'Kaptan Brief — Bugün',
      subtitle: `${fmtDateLong(dateIso)} · Constantine Yachts`,
      weatherChip: formatWeatherHtml(today, 'Bugün'),
      sections: sections.filter(Boolean).join('\n'),
      appBaseUrl,
    }),
    text: `Kaptan Brief — ${fmtDateLong(dateIso)}\n${formatWeatherText(today, 'Bugun')}\n${textParts.filter(Boolean).join('')}`,
    hasCritical: data.openBreakdowns.some(b => b.severity === 'critical'),
  };
}

function renderCrew(input: RenderInput): DigestRendered {
  const { data, weather, dateIso, tomorrowIso, variant } = input;
  const appBaseUrl = input.appBaseUrl ?? 'https://crm.constantineyachts.com';
  const today = weather?.today ?? null;
  const tomorrow = weather?.tomorrow ?? null;

  if (variant === 'evening') {
    const tomorrowBookings = data.tomorrowBookings ?? [];
    let subject = `🌙 Yarın · ${tomorrowBookings.length} tur — hazırlık`;
    if (tomorrow && isWeatherWarning(tomorrow)) subject += ` · ⚠ hava`;

    const sections: string[] = [];
    const textParts: string[] = [];

    const bks = buildBookingsListSection(tomorrowBookings, data.boatsById, '⛵ YARIN — Görevlerim');
    sections.push(bks.html); textParts.push(bks.text);

    // Yarın için görevler (provizyon, hazırlık)
    if (data.todayTasks.length > 0) {
      const tt = buildTasksSection(data.todayTasks, data.boatsById, `🧰 YARIN HAZIRLIK GÖREVLERİ (${data.todayTasks.length})`);
      sections.push(tt.html); textParts.push(tt.text);
    }

    // Allerji / VIP uyarısı (yarınki bookingsler için)
    const warnings = tomorrowBookings.filter(b => isVip(b.notes) || hasAllergy(b.notes));
    if (warnings.length > 0) {
      let html = sectionHeaderDanger(`⚠ DİKKAT — Yarın için özel notlar`);
      html += '<ul style="margin:0;padding-left:20px;color:#0a2540;font-size:13px;">';
      let text = `\n--- DIKKAT — YARIN ICIN ---\n`;
      for (const b of warnings) {
        const boat = data.boatsById[b.boat_id];
        const labels = [isVip(b.notes) ? 'VIP' : '', hasAllergy(b.notes) ? 'ALERJİ' : ''].filter(Boolean).join(' + ');
        html += `<li><strong>${escapeHtml(labels)}</strong> · ${escapeHtml(boat?.name ?? '?')} · ${escapeHtml(b.guest_name)}${b.notes ? ' — ' + escapeHtml(b.notes.slice(0, 100)) : ''}</li>`;
        text += `  ${labels} · ${boat?.name ?? '?'} · ${b.guest_name}${b.notes ? ' — ' + b.notes.slice(0, 100) : ''}\n`;
      }
      html += '</ul>';
      sections.push(html); textParts.push(text);
    }

    return {
      subject,
      html: htmlShell({
        titleEmoji: '🌙',
        titleText: 'Yarın için Hazırlık',
        subtitle: `${fmtDateLong(tomorrowIso ?? dateIso)} · Mürettebat`,
        weatherChip: formatWeatherHtml(tomorrow, 'Yarın'),
        sections: sections.filter(Boolean).join('\n'),
        appBaseUrl,
      }),
      text: `Yarin Hazirlik — ${fmtDateLong(tomorrowIso ?? dateIso)}\n${formatWeatherText(tomorrow, 'Yarin')}\n${textParts.filter(Boolean).join('')}`,
      hasCritical: false,
    };
  }

  // MORNING — gemici
  const todayBookings = data.todayBookings;
  const totalPax = todayBookings.reduce((s, b) => s + b.adult + b.child + b.infant, 0);
  let subject = `Bugün · ${todayBookings.length} tur, ${totalPax} misafir`;
  if (today && isWeatherWarning(today)) subject += ` · ⚠ hava`;

  const sections: string[] = [];
  const textParts: string[] = [];

  const bks = buildBookingsListSection(todayBookings, data.boatsById, '⛵ BUGÜNKÜ TURLARIM');
  sections.push(bks.html); textParts.push(bks.text);

  const tt = buildTasksSection(data.todayTasks, data.boatsById, `✓ GÖREVLERİM (${data.todayTasks.length})`);
  sections.push(tt.html); textParts.push(tt.text);

  // Allerji / VIP uyarısı
  const warnings = todayBookings.filter(b => isVip(b.notes) || hasAllergy(b.notes));
  if (warnings.length > 0) {
    let html = sectionHeaderDanger(`⚠ ÖZEL NOTLAR`);
    html += '<ul style="margin:0;padding-left:20px;color:#0a2540;font-size:13px;">';
    let text = `\n--- OZEL NOTLAR ---\n`;
    for (const b of warnings) {
      const boat = data.boatsById[b.boat_id];
      const labels = [isVip(b.notes) ? 'VIP' : '', hasAllergy(b.notes) ? 'ALERJİ' : ''].filter(Boolean).join(' + ');
      html += `<li><strong>${escapeHtml(labels)}</strong> · ${escapeHtml(boat?.name ?? '?')} · ${escapeHtml(b.guest_name)}${b.notes ? ' — ' + escapeHtml(b.notes.slice(0, 100)) : ''}</li>`;
      text += `  ${labels} · ${boat?.name ?? '?'} · ${b.guest_name}${b.notes ? ' — ' + b.notes.slice(0, 100) : ''}\n`;
    }
    html += '</ul>';
    sections.push(html); textParts.push(text);
  }

  return {
    subject,
    html: htmlShell({
      titleEmoji: '⛵',
      titleText: 'Bugün',
      subtitle: `${fmtDateLong(dateIso)} · Constantine Yachts`,
      weatherChip: formatWeatherHtml(today, 'Bugün'),
      sections: sections.filter(Boolean).join('\n'),
      appBaseUrl,
    }),
    text: `Bugun — ${fmtDateLong(dateIso)}\n${formatWeatherText(today, 'Bugun')}\n${textParts.filter(Boolean).join('')}`,
    hasCritical: false,
  };
}

// =========================================================
// Empty fallback
// =========================================================
function renderEmpty(input: RenderInput): DigestRendered {
  const { data, weather, dateIso, tomorrowIso, variant } = input;
  const appBaseUrl = input.appBaseUrl ?? 'https://crm.constantineyachts.com';
  const day = variant === 'evening' ? (weather?.tomorrow ?? null) : (weather?.today ?? null);
  const dayLabel = variant === 'evening' ? 'Yarın' : 'Bugün';
  const targetIso = variant === 'evening' ? (tomorrowIso ?? dateIso) : dateIso;
  const greeting = data.user.full_name ? escapeHtml(data.user.full_name) : 'Merhaba';
  const text = variant === 'evening'
    ? `Yarin icin planli tur, gorev veya acik ariza yok. Iyi tatiller!`
    : `Bugun icin planli tur, gorev veya acik ariza yok. Iyi gunler!`;
  const html = `<p style="margin:0;color:#4B4A6B;line-height:1.6;">Selam ${greeting}, ${escapeHtml(text)}</p>`;
  return {
    subject: `${variant === 'evening' ? '🌙' : '🌅'} Constantine — ${fmtDateShort(targetIso)} · ${dayLabel} boş`,
    html: htmlShell({
      titleEmoji: variant === 'evening' ? '🌙' : '🌅',
      titleText: `${dayLabel} — Boş`,
      subtitle: `${fmtDateLong(targetIso)} · Constantine Yachts`,
      weatherChip: formatWeatherHtml(day, dayLabel),
      sections: html,
      appBaseUrl,
    }),
    text: `${dayLabel} — ${fmtDateLong(targetIso)}\n\nSelam ${data.user.full_name ?? 'Merhaba'}, ${text}\n`,
    hasCritical: false,
  };
}

// =========================================================
// Master switch — public entry point
// =========================================================
export function renderDigestByRole(input: RenderInput): DigestRendered {
  const { data, variant } = input;

  // Empty check — variant'a göre booking + task + breakdown var mı?
  const targetBookings = variant === 'evening' ? (data.tomorrowBookings ?? []) : data.todayBookings;
  const isEmpty =
    targetBookings.length === 0 &&
    data.todayTasks.length === 0 &&
    data.overdueTasks.length === 0 &&
    data.openBreakdowns.length === 0 &&
    data.upcomingMaintenance.length === 0 &&
    (data.overdueUnpaidBookings ?? []).length === 0 &&
    (data.pendingApprovals ?? []).length === 0;

  if (isEmpty) return renderEmpty(input);

  switch (data.user.role) {
    case 'super_admin':
      return renderSuperAdmin(input);
    case 'partner':
    case 'accountant':
      return renderPartner(input);
    case 'captain':
      return renderCaptain(input);
    case 'crew':
      return renderCrew(input);
    default:
      return renderCrew(input);
  }
}

// =========================================================
// Backwards compat — eski renderDigest(data, dateIso) alias'ı
// =========================================================
export function renderDigest(data: DigestData, dateIso: string): DigestRendered {
  return renderDigestByRole({ data, weather: null, dateIso, variant: 'morning' });
}
