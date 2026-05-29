/**
 * daily-digest — Operations daily digest (CRM tarafı)
 *
 * İki variant:
 *   - morning (TR 09:00 / UTC 06:00): bugün odaklı, role-spesifik
 *   - evening (TR 23:00 / UTC 20:00): yarın hazırlık + bekleyen onaylar
 *
 * Mail kanalı: **Resend** (Gmail OAuth artık YOK).
 * Sender: ops@send.constantineyachts.com (Verified domain)
 *
 * Role × variant matrix:
 *   - super_admin  m/e  Patron paneli — tam görünüm, mali snapshot, bekleyen onaylar
 *   - partner      m/e  Ortak özet — atandığı tekneler, mali, 7-gün doluluk
 *   - captain      m/e  Kaptan briefingi — bugünün gemisi, görevler, arızalar
 *   - crew         m/e  Mürettebat — minimal, görev + tur listesi + VIP/alerji uyarı
 *
 * Endpoint: POST /functions/v1/daily-digest
 *   body: { variant?: 'morning' | 'evening', test_user_id?: uuid }
 *
 * Schedule: cron-scheduler.ts içinde 2 job
 *   - "0 6 * * *" UTC → variant=morning
 *   - "0 20 * * *" UTC → variant=evening
 */
import type { Context } from 'hono';
import { sql } from './db.js';
import { sendDigestViaResend } from './digest-sender.js';
import { getDailyForecast, type WeatherSnapshot } from './weather.js';
import {
  renderDigestByRole,
  type DigestBookingRow,
  type DigestBoat,
  type DigestBreakdownRow,
  type DigestData,
  type DigestMaintenanceRow,
  type DigestTaskRow,
  type DigestUser,
  type DigestVariant,
  type WeekStats,
  type MonthlyFinancials,
  type BoatOccupancy,
} from './digest-render.js';

const OPS_SENDER_EMAIL = process.env.OPS_SENDER_EMAIL ?? 'ops@send.constantineyachts.com';
const OPS_SENDER_NAME = process.env.OPS_SENDER_NAME ?? 'Constantine Operasyon';
const OPS_REPLY_TO = process.env.OPS_REPLY_TO ?? 'mert@constantineyachts.com';

// =========================================================
// TR timezone — UTC+3 sabit
// =========================================================
const TR_OFFSET_MS = 3 * 3600 * 1000;

function todayInIstanbul(): string {
  const now = new Date();
  const tr = new Date(now.getTime() + TR_OFFSET_MS);
  return tr.toISOString().slice(0, 10);
}

/** postgres-js DATE/TIMESTAMP kolonlarını JS Date dönüştürür — render her yerde string ISO bekliyor */
function asIso(v: string | Date | null | undefined): string {
  if (!v) return '';
  if (typeof v === 'string') return v.length > 10 ? v.slice(0, 10) : v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** Full ISO timestamp için (reported_at gibi) */
function asIsoTs(v: string | Date | null | undefined): string {
  if (!v) return new Date(0).toISOString();
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// Resend rate limit: 5 req/s. 220ms gap = ~4.5 req/s, güvenli.
const SEND_GAP_MS = Number(process.env.DIGEST_SEND_GAP_MS ?? '220');

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthStartIso(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  role: 'super_admin' | 'partner' | 'accountant' | 'captain' | 'crew';
}

// =========================================================
// Data fetchers
// =========================================================

async function fetchEligibleUsers(testUserId: string | null): Promise<ProfileRow[]> {
  if (testUserId) {
    const rows = await sql<ProfileRow[]>`
      SELECT id, email, full_name, role::text AS role
      FROM profiles
      WHERE id = ${testUserId}
      LIMIT 1
    `;
    return rows;
  }
  const rows = await sql<ProfileRow[]>`
    SELECT id, email, full_name, role::text AS role
    FROM profiles
    WHERE daily_digest_enabled = TRUE
      AND email IS NOT NULL
      AND (active IS NULL OR active = TRUE)
  `;
  return rows;
}

async function fetchManagedBoatIds(user: ProfileRow): Promise<string[]> {
  if (user.role === 'super_admin') {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM boats WHERE active = TRUE
    `;
    return rows.map((r) => r.id);
  }
  const rows = await sql<Array<{ boat_id: string }>>`
    SELECT boat_id FROM boat_assignments WHERE user_id = ${user.id}
  `;
  return rows.map((r) => r.boat_id);
}

async function fetchBookingsForDate(boatIds: string[], dateIso: string, assignedUserId: string | null): Promise<DigestBookingRow[]> {
  if (boatIds.length === 0) return [];
  // Captain/crew için assigned_to filtresi — assigned_captain_id veya assigned_crew_ids array'i (varsa)
  // Bu kolonlar varsayım — yoksa try/catch'le graceful degradation
  const rows = await sql<Array<any>>`
    SELECT
      b.id, b.boat_id, b.start_time, b.guest_name, b.adult, b.child, b.infant,
      b.total_price, b.total_price_try, b.currency, b.payment_status, b.deposit_amount,
      b.contact, b.notes, b.duration_hours, b.date, b.approval_status,
      c.name AS channel_name, c.type AS channel_type,
      p.name AS package_name
    FROM bookings b
    LEFT JOIN channels c ON c.id = b.channel_id
    LEFT JOIN packages p ON p.id = b.package_id
    WHERE b.date = ${dateIso}
      AND b.boat_id IN ${sql(boatIds)}
      AND b.status <> 'cancelled'
      AND (b.approval_status IS NULL OR b.approval_status <> 'rejected')
    ORDER BY b.start_time NULLS LAST
  `;
  return rows.map((b: any) => ({
    id: b.id, boat_id: b.boat_id, start_time: b.start_time,
    guest_name: b.guest_name, adult: b.adult, child: b.child, infant: b.infant,
    total_price: Number(b.total_price ?? 0), total_price_try: Number(b.total_price_try ?? 0),
    currency: b.currency, payment_status: b.payment_status, deposit_amount: Number(b.deposit_amount ?? 0),
    contact: b.contact, notes: b.notes, duration_hours: b.duration_hours, date: asIso(b.date),
    channel_name: b.channel_name ?? null, channel_type: b.channel_type ?? null,
    package_name: b.package_name ?? null,
    approval_status: b.approval_status ?? null,
  }));
}

async function fetchTasksForUser(boatIds: string[], dateIso: string, isPartnerLike: boolean, userId: string): Promise<{ todayTasks: DigestTaskRow[]; overdueTasks: DigestTaskRow[] }> {
  if (boatIds.length === 0) return { todayTasks: [], overdueTasks: [] };
  const assigneeFilter = isPartnerLike ? sql`` : sql`AND assigned_to = ${userId}`;
  const todayRows = await sql<Array<any>>`
    SELECT id, title, boat_id, due_date, assigned_to
    FROM tasks
    WHERE status <> 'done'
      AND boat_id IN ${sql(boatIds)}
      AND due_date = ${dateIso}
      ${assigneeFilter}
  `;
  const overdueRows = await sql<Array<any>>`
    SELECT id, title, boat_id, due_date, assigned_to
    FROM tasks
    WHERE status <> 'done'
      AND boat_id IN ${sql(boatIds)}
      AND due_date < ${dateIso}
      AND due_date IS NOT NULL
      ${assigneeFilter}
  `;
  const mapTask = (t: any): DigestTaskRow => ({
    id: t.id, title: t.title, boat_id: t.boat_id,
    due_date: t.due_date ? asIso(t.due_date) : null,
    assigned_to: t.assigned_to ?? null,
  });
  return { todayTasks: todayRows.map(mapTask), overdueTasks: overdueRows.map(mapTask) };
}

async function fetchOpenBreakdowns(boatIds: string[]): Promise<DigestBreakdownRow[]> {
  if (boatIds.length === 0) return [];
  const rows = await sql<Array<{
    id: string; boat_id: string; title: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    reported_at: string; photo_paths: string[] | null;
  }>>`
    SELECT id, boat_id, title, severity, reported_at, photo_paths
    FROM breakdowns
    WHERE boat_id IN ${sql(boatIds)}
      AND status <> 'resolved'
  `;
  return rows.map((b) => ({
    id: b.id, boat_id: b.boat_id, title: b.title,
    severity: b.severity, reported_at: asIsoTs(b.reported_at as any),
    photo_count: Array.isArray(b.photo_paths) ? b.photo_paths.length : 0,
  }));
}

async function fetchUpcomingMaintenance(boatIds: string[], dateIso: string): Promise<DigestMaintenanceRow[]> {
  if (boatIds.length === 0) return [];
  const cutoff = addDaysIso(dateIso, 14); // 14 gün forecast
  const rows = await sql<Array<any>>`
    SELECT id, boat_id, title, next_due_at
    FROM maintenance_records
    WHERE boat_id IN ${sql(boatIds)}
      AND next_due_at IS NOT NULL
      AND next_due_at <= ${cutoff}
  `;
  return rows.map((m: any) => ({
    id: m.id, boat_id: m.boat_id, title: m.title,
    next_due_at: asIso(m.next_due_at),
  }));
}

async function fetchOverdueUnpaid(boatIds: string[], dateIso: string): Promise<DigestBookingRow[]> {
  if (boatIds.length === 0) return [];
  const rows = await sql<Array<any>>`
    SELECT
      id, boat_id, start_time, guest_name, adult, child, infant,
      total_price, total_price_try, currency, payment_status, deposit_amount,
      contact, notes, duration_hours, date
    FROM bookings
    WHERE date < ${dateIso}
      AND boat_id IN ${sql(boatIds)}
      AND payment_status IN ('pending', 'deposit')
      AND status <> 'cancelled'
      AND (approval_status IS NULL OR approval_status <> 'rejected')
    ORDER BY date DESC
    LIMIT 50
  `;
  return rows.map((b: any) => ({
    id: b.id, boat_id: b.boat_id, start_time: b.start_time,
    guest_name: b.guest_name, adult: b.adult, child: b.child, infant: b.infant,
    total_price: Number(b.total_price ?? 0), total_price_try: Number(b.total_price_try ?? 0),
    currency: b.currency, payment_status: b.payment_status, deposit_amount: Number(b.deposit_amount ?? 0),
    contact: b.contact, notes: b.notes, duration_hours: b.duration_hours, date: asIso(b.date),
    channel_name: null, channel_type: null, package_name: null,
  }));
}

async function fetchPendingApprovals(boatIds: string[], dateIso: string): Promise<DigestBookingRow[]> {
  if (boatIds.length === 0) return [];
  try {
    const rows = await sql<Array<any>>`
      SELECT
        id, boat_id, start_time, guest_name, adult, child, infant,
        total_price, total_price_try, currency, payment_status, deposit_amount,
        contact, notes, duration_hours, date
      FROM bookings
      WHERE approval_status = 'pending'
        AND boat_id IN ${sql(boatIds)}
        AND date >= ${dateIso}
        AND status <> 'cancelled'
      ORDER BY date ASC
      LIMIT 20
    `;
    return rows.map((b: any) => ({
      id: b.id, boat_id: b.boat_id, start_time: b.start_time,
      guest_name: b.guest_name, adult: b.adult, child: b.child, infant: b.infant,
      total_price: Number(b.total_price ?? 0), total_price_try: Number(b.total_price_try ?? 0),
      currency: b.currency, payment_status: b.payment_status, deposit_amount: Number(b.deposit_amount ?? 0),
      contact: b.contact, notes: b.notes, duration_hours: b.duration_hours, date: asIso(b.date),
      channel_name: null, channel_type: null, package_name: null,
    }));
  } catch (e: any) {
    console.warn('[daily-digest] fetchPendingApprovals failed (kolon yoksa graceful):', e?.message);
    return [];
  }
}

async function fetchWeekStats(boatIds: string[], dateIso: string): Promise<WeekStats | undefined> {
  if (boatIds.length === 0) return undefined;
  try {
    // Bu hafta (son 7 gün) vs geçen hafta (önceki 7 gün)
    const thisWeekStart = addDaysIso(dateIso, -6);
    const lastWeekStart = addDaysIso(dateIso, -13);
    const lastWeekEnd = addDaysIso(dateIso, -7);

    const tw = await sql<Array<{ cnt: string; rev: string }>>`
      SELECT COUNT(*) AS cnt, COALESCE(SUM(total_price_try), 0) AS rev
      FROM bookings
      WHERE date >= ${thisWeekStart} AND date <= ${dateIso}
        AND boat_id IN ${sql(boatIds)}
        AND status <> 'cancelled'
        AND (approval_status IS NULL OR approval_status <> 'rejected')
    `;
    const lw = await sql<Array<{ cnt: string; rev: string }>>`
      SELECT COUNT(*) AS cnt, COALESCE(SUM(total_price_try), 0) AS rev
      FROM bookings
      WHERE date >= ${lastWeekStart} AND date <= ${lastWeekEnd}
        AND boat_id IN ${sql(boatIds)}
        AND status <> 'cancelled'
        AND (approval_status IS NULL OR approval_status <> 'rejected')
    `;

    // Sales lead — son 7 gün, best-effort
    let newLeadsThisWeek: number | undefined;
    try {
      const sl = await sql<Array<{ cnt: string }>>`
        SELECT COUNT(*) AS cnt FROM leads WHERE created_at >= ${thisWeekStart + 'T00:00:00Z'}
      `;
      newLeadsThisWeek = Number(sl[0]?.cnt ?? 0);
    } catch {
      // leads tablosu yoksa skip
    }

    return {
      bookingsThisWeek: Number(tw[0]?.cnt ?? 0),
      bookingsLastWeek: Number(lw[0]?.cnt ?? 0),
      revenueTryThisWeek: Number(tw[0]?.rev ?? 0),
      revenueTryLastWeek: Number(lw[0]?.rev ?? 0),
      newLeadsThisWeek,
    };
  } catch (e: any) {
    console.warn('[daily-digest] fetchWeekStats failed:', e?.message);
    return undefined;
  }
}

async function fetchMonthlyFinancials(boatIds: string[], dateIso: string): Promise<MonthlyFinancials | undefined> {
  if (boatIds.length === 0) return undefined;
  const monthStart = monthStartIso(dateIso);
  try {
    const rev = await sql<Array<{ total: string }>>`
      SELECT COALESCE(SUM(total_price_try), 0) AS total
      FROM bookings
      WHERE date >= ${monthStart} AND date <= ${dateIso}
        AND boat_id IN ${sql(boatIds)}
        AND status <> 'cancelled'
        AND (approval_status IS NULL OR approval_status <> 'rejected')
    `;
    const revenueTry = Number(rev[0]?.total ?? 0);

    // Expenses — boats filter ile (varsa expenses.boat_id), yoksa total
    let expenseTry = 0;
    let topCategories: Array<{ category: string; amount_try: number }> = [];
    try {
      const exp = await sql<Array<{ total: string }>>`
        SELECT COALESCE(SUM(amount_try), 0) AS total
        FROM expenses
        WHERE date >= ${monthStart} AND date <= ${dateIso}
          AND (boat_id IS NULL OR boat_id IN ${sql(boatIds)})
      `;
      expenseTry = Number(exp[0]?.total ?? 0);
      const cats = await sql<Array<{ category: string; total: string }>>`
        SELECT category, COALESCE(SUM(amount_try), 0) AS total
        FROM expenses
        WHERE date >= ${monthStart} AND date <= ${dateIso}
          AND (boat_id IS NULL OR boat_id IN ${sql(boatIds)})
        GROUP BY category
        ORDER BY total DESC
        LIMIT 3
      `;
      topCategories = cats.map((c) => ({ category: c.category ?? 'Diğer', amount_try: Number(c.total ?? 0) }));
    } catch (expErr: any) {
      console.warn('[daily-digest] expenses query skipped:', expErr?.message);
    }

    return {
      revenueTryMTD: revenueTry,
      expenseTryMTD: expenseTry,
      grossProfitTryMTD: revenueTry - expenseTry,
      topExpenseCategories: topCategories,
    };
  } catch (e: any) {
    console.warn('[daily-digest] fetchMonthlyFinancials failed:', e?.message);
    return undefined;
  }
}

async function fetchWeeklyOccupancy(boatIds: string[], dateIso: string): Promise<BoatOccupancy[] | undefined> {
  if (boatIds.length === 0) return undefined;
  const weekEnd = addDaysIso(dateIso, 6); // bugün + 6 gün = 7 gün
  try {
    const rows = await sql<Array<{ boat_id: string; cnt: string }>>`
      SELECT boat_id, COUNT(*) AS cnt
      FROM bookings
      WHERE date >= ${dateIso} AND date <= ${weekEnd}
        AND boat_id IN ${sql(boatIds)}
        AND status <> 'cancelled'
        AND (approval_status IS NULL OR approval_status <> 'rejected')
      GROUP BY boat_id
    `;
    const countMap = new Map<string, number>();
    for (const r of rows) countMap.set(r.boat_id, Number(r.cnt));
    return boatIds.map((id) => {
      const c = countMap.get(id) ?? 0;
      return { boat_id: id, bookingCount: c, occupancyPct: Math.round((c / 7) * 100) };
    }).sort((a, b) => b.occupancyPct - a.occupancyPct);
  } catch (e: any) {
    console.warn('[daily-digest] fetchWeeklyOccupancy failed:', e?.message);
    return undefined;
  }
}

// =========================================================
// Aggregate fetchData — variant + role aware
// =========================================================
async function fetchDigestData(
  user: ProfileRow,
  dateIso: string,
  tomorrowIso: string,
  variant: DigestVariant,
  managedBoatIds: string[],
): Promise<DigestData> {
  const boatsById: Record<string, DigestBoat> = {};
  if (managedBoatIds.length > 0) {
    const boats = await sql<DigestBoat[]>`
      SELECT id, name FROM boats WHERE id IN ${sql(managedBoatIds)}
    `;
    for (const b of boats) boatsById[b.id] = b;
  }

  const isPartnerLike = user.role === 'super_admin' || user.role === 'partner' || user.role === 'accountant';

  // Core fetcher'lar — paralel
  // Evening variant'ta "todayBookings" yerine "tomorrowBookings" gerekiyor ama ikisini de fetch et,
  // çünkü sabah önizleme veya akşam current durum lazım olabilir.
  // todayTasks: evening'de "yarın için" tasks (semantik), morning'de "bugün için"
  const tasksDate = variant === 'evening' ? tomorrowIso : dateIso;

  const [
    todayBookings,
    tomorrowBookings,
    tasks,
    openBreakdowns,
    upcomingMaintenance,
    overdueUnpaidBookings,
  ] = await Promise.all([
    fetchBookingsForDate(managedBoatIds, dateIso, isPartnerLike ? null : user.id),
    fetchBookingsForDate(managedBoatIds, tomorrowIso, isPartnerLike ? null : user.id),
    fetchTasksForUser(managedBoatIds, tasksDate, isPartnerLike, user.id),
    fetchOpenBreakdowns(managedBoatIds),
    fetchUpcomingMaintenance(managedBoatIds, dateIso),
    isPartnerLike ? fetchOverdueUnpaid(managedBoatIds, dateIso) : Promise.resolve([]),
  ]);

  // Role-spesifik ek fetch'ler
  const roleData: Partial<DigestData> = {};

  if (user.role === 'super_admin') {
    const [pending, week] = await Promise.all([
      fetchPendingApprovals(managedBoatIds, dateIso),
      fetchWeekStats(managedBoatIds, dateIso),
    ]);
    roleData.pendingApprovals = pending;
    roleData.weekStats = week;
  }

  if (user.role === 'partner' || user.role === 'accountant') {
    const [fin, occ] = await Promise.all([
      fetchMonthlyFinancials(managedBoatIds, dateIso),
      fetchWeeklyOccupancy(managedBoatIds, dateIso),
    ]);
    roleData.monthlyFinancials = fin;
    roleData.weeklyOccupancy = occ;
  }

  const digestUser: DigestUser = {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    role: user.role,
  };

  return {
    user: digestUser,
    boatsById,
    todayBookings,
    todayTasks: tasks.todayTasks,
    overdueTasks: tasks.overdueTasks,
    openBreakdowns,
    upcomingMaintenance,
    overdueUnpaidBookings,
    tomorrowBookings,
    ...roleData,
  };
}

// =========================================================
// Send log helper (best-effort)
// =========================================================
async function logSend(
  userId: string,
  status: 'sent' | 'failed',
  email: string,
  role: string,
  dateIso: string,
  variant: DigestVariant,
  extra: { message_id?: string; error_message?: string; has_critical?: boolean },
): Promise<void> {
  try {
    await sql`
      INSERT INTO digest_send_log (
        user_id, status, message_id, error_message,
        recipient_role, recipient_email, digest_date, has_critical
      ) VALUES (
        ${userId},
        ${status},
        ${extra.message_id ?? null},
        ${extra.error_message ?? null},
        ${`${role}${variant === 'evening' ? '-eve' : ''}`},
        ${email},
        ${dateIso},
        ${extra.has_critical ?? false}
      )
    `;
  } catch (e: any) {
    console.warn('[daily-digest] digest_send_log insert skipped:', e?.message);
  }
}

// =========================================================
// Core runner
// =========================================================

export interface OpsDigestRunResult {
  ok: true;
  variant: DigestVariant;
  sent: number;
  failed: number;
  date: string;
  reason?: string;
  errors?: Array<{ email: string; error: string }>;
}

export async function runOpsDailyDigest(
  testUserId: string | null = null,
  variant: DigestVariant = 'morning',
): Promise<OpsDigestRunResult> {
  const today = todayInIstanbul();
  const tomorrow = addDaysIso(today, 1);
  const targetIso = variant === 'evening' ? tomorrow : today;

  // 1. Recipients
  const users = await fetchEligibleUsers(testUserId);
  if (users.length === 0) {
    return { ok: true, variant, sent: 0, failed: 0, date: today, reason: 'no_recipients' };
  }

  // 2. Hava durumu (1 kere, paylaşılan cache)
  let weather: WeatherSnapshot | null = null;
  try {
    weather = await getDailyForecast();
  } catch (e: any) {
    console.warn('[daily-digest] weather fetch failed:', e?.message);
  }

  let sent = 0;
  let failed = 0;
  const errors: Array<{ email: string; error: string }> = [];

  let idx = 0;
  for (const user of users) {
    if (idx > 0) await sleep(SEND_GAP_MS); // Resend rate-limit (5 req/s)
    idx++;
    try {
      const managedBoatIds = await fetchManagedBoatIds(user);
      const data = await fetchDigestData(user, today, tomorrow, variant, managedBoatIds);
      const rendered = renderDigestByRole({
        data,
        weather,
        dateIso: today,
        tomorrowIso: tomorrow,
        variant,
      });

      const result = await sendDigestViaResend({
        to: user.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        senderEmail: OPS_SENDER_EMAIL,
        senderName: OPS_SENDER_NAME,
        replyTo: OPS_REPLY_TO,
        tags: [
          { name: 'kind', value: 'ops-daily-digest' },
          { name: 'variant', value: variant },
          { name: 'role', value: user.role },
        ],
      });

      if (result.ok) {
        await logSend(user.id, 'sent', user.email, testUserId ? 'TEST' : user.role, targetIso, variant, {
          message_id: result.messageId,
          has_critical: rendered.hasCritical,
        });
        sent++;
      } else {
        await logSend(user.id, 'failed', user.email, testUserId ? 'TEST' : user.role, targetIso, variant, {
          error_message: result.error,
        });
        failed++;
        errors.push({ email: user.email, error: result.error ?? 'unknown' });
        console.error(`[daily-digest] send failed for ${user.email}:`, result.error);
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      await logSend(user.id, 'failed', user.email, testUserId ? 'TEST' : user.role, targetIso, variant, {
        error_message: msg.slice(0, 1000),
      });
      failed++;
      errors.push({ email: user.email, error: msg });
      console.error(`[daily-digest] error for ${user.email}:`, msg);
    }
  }

  return { ok: true, variant, sent, failed, date: targetIso, errors: errors.length > 0 ? errors : undefined };
}

// =========================================================
// Hono handler
// =========================================================
export async function handleDailyDigest(c: Context): Promise<Response> {
  let body: { test_user_id?: string; variant?: DigestVariant } = {};
  if (c.req.method === 'POST') {
    body = await c.req.json().catch(() => ({}));
  }
  const testUserId = body.test_user_id ?? null;
  const variant: DigestVariant = body.variant === 'evening' ? 'evening' : 'morning';

  try {
    const result = await runOpsDailyDigest(testUserId, variant);
    return c.json(result);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error('[daily-digest] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
