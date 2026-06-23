/**
 * Cron scheduler — in-process node-cron tabanlı.
 *
 * Schedule'lar (UTC):
 *   - warmup-tick: her gün 00:00 UTC (= 03:00 TR) — campaign-worker daily cap window ile aligned
 *   - recompute-scores: her 15 dakikada bir
 *
 * Henüz port edilmemiş cron'lar:
 *   - cron-daily-digest (operasyon günlük raporu) — Faz 3.5
 *   - cron-overdue (geciken booking/task notify) — Faz 3.5
 *   - cron-recurring (aylık expense/task instantiate) — Faz 3.5
 *
 * Her cron job için bir last_run_at değeri `app_config` tablosuna yazılır
 * (UI'da EmailSettings'teki "son cron tick" göstergesi için).
 */
import cron, { type ScheduledTask } from 'node-cron';
import { sql } from './db.js';
import { runWarmupTick } from './cron-warmup-tick.js';
import { runRecomputeScores } from './cron-recompute-scores.js';
import { runSalesDailyDigest } from './cron-daily-digest.js';
import { runWeeklyTrendDigest } from './cron-weekly-digest.js';
import { runOpsDailyDigest } from './daily-digest.js';
import { runPartnerCalendarSync } from './partner-calendar-sync.js';
import { runConstantineSync } from './constantine-sync.js';

let warmupTask: ScheduledTask | null = null;
let scoresTask: ScheduledTask | null = null;
let overdueTask: ScheduledTask | null = null;
let recurringTask: ScheduledTask | null = null;
let digestTask: ScheduledTask | null = null;
let weeklyTrendTask: ScheduledTask | null = null;
let opsDigestTask: ScheduledTask | null = null;
let opsEveningDigestTask: ScheduledTask | null = null;
let notifCleanupTask: ScheduledTask | null = null;
let partnerSyncTask: ScheduledTask | null = null;
let constantineSyncTask: ScheduledTask | null = null;

async function loadCronEnabled(): Promise<boolean> {
  try {
    const rows = await sql`
      SELECT value FROM app_config WHERE key = 'sales.cron_enabled'
    `;
    if (rows.length === 0) return true; // default açık
    const v = rows[0]?.value;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v === 'true' || v === '1';
    if (typeof v === 'object' && v !== null && 'enabled' in (v as any)) {
      return !!(v as any).enabled;
    }
    return true;
  } catch {
    return true;
  }
}

async function writeLastRun(key: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await sql`
      INSERT INTO app_config (key, value)
      VALUES (${key}, ${sql.json({ ...payload, at: new Date().toISOString() })})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  } catch (e: any) {
    console.warn(`[cron-scheduler] writeLastRun(${key}) skipped:`, e.message);
  }
}

async function safeRunWarmup(): Promise<void> {
  if (!(await loadCronEnabled())) {
    console.log('[cron-scheduler] cron disabled, warmup skipped');
    return;
  }
  console.log('[cron-scheduler] running warmup-tick...');
  try {
    const result = await runWarmupTick();
    console.log(`[cron-scheduler] warmup-tick OK: ticked=${result.ticked}`);
    await writeLastRun('sales.cron.last_warmup_tick', { ticked: result.ticked });
  } catch (e: any) {
    console.error('[cron-scheduler] warmup-tick error:', e?.message);
    await writeLastRun('sales.cron.last_warmup_tick', { error: e?.message ?? 'unknown' });
  }
}

async function safeRunScores(): Promise<void> {
  if (!(await loadCronEnabled())) {
    return;
  }
  try {
    const result = await runRecomputeScores();
    if (result.processed > 0) {
      console.log(`[cron-scheduler] scores: processed=${result.processed} changed=${result.changed} new_hot=${result.new_hot}`);
    }
    await writeLastRun('sales.cron.last_score_recompute', {
      processed: result.processed,
      changed: result.changed,
      new_hot: result.new_hot,
    });
  } catch (e: any) {
    console.error('[cron-scheduler] scores error:', e?.message);
    await writeLastRun('sales.cron.last_score_recompute', { error: e?.message ?? 'unknown' });
  }
}

/** Partner tekne takvim senkronu — 10dk'da bir, sessiz (yalnız hata/aktivitede log).
 *  app_config 'partner.cron.last_calendar_sync' kaydını runPartnerCalendarSync kendisi yazar
 *  (manuel tetik de aynı yere yazsın diye). */
async function safeRunPartnerSync(): Promise<void> {
  if (!(await loadCronEnabled())) {
    return;
  }
  try {
    const result = await runPartnerCalendarSync();
    if (result.errors.length > 0 || result.slots > 0) {
      console.log(`[cron-scheduler] partner-sync: boats=${result.boats} synced=${result.synced} slots=${result.slots} errors=${result.errors.length}`);
    }
  } catch (e: any) {
    console.error('[cron-scheduler] partner-sync error:', e?.message);
  }
}

/** Constantine çift-yön takvim senkronu (Simon) — 10dk'da bir, partner-sync'ten 5dk offset.
 *  sync_enabled=true tekneler için push (CRM→Dolu blok) + pull (Simon event→pending booking)
 *  + reconcile. Hiç sync_enabled tekne yoksa no-op (Simon e-postası gelene dek pasif). */
async function safeRunConstantineSync(): Promise<void> {
  if (!(await loadCronEnabled())) {
    return;
  }
  try {
    const result = await runConstantineSync();
    if (result.errors.length > 0 || result.pushed > 0 || result.ingestedEvents > 0 ||
        result.blocksDeleted > 0 || result.rejectedCleaned > 0 || result.withdrawn > 0) {
      console.log(`[cron-scheduler] constantine-sync: boats=${result.boats} pushed=${result.pushed} ingested=${result.ingestedEvents} rejected=${result.rejectedCleaned} withdrawn=${result.withdrawn} errors=${result.errors.length}`);
    }
  } catch (e: any) {
    console.error('[cron-scheduler] constantine-sync error:', e?.message);
  }
}

/** Geciken görevleri tara, task_overdue activity_events ekle. DB'deki fn_log_task_overdue() */
export async function runOverdueTick(): Promise<{ ok: true }> {
  try {
    await sql`SELECT fn_log_task_overdue()`;
    await writeLastRun('cron.last_task_overdue', { ok: true });
  } catch (e: any) {
    console.error('[cron-scheduler] overdue error:', e?.message);
    await writeLastRun('cron.last_task_overdue', { error: e?.message ?? 'unknown' });
  }
  return { ok: true };
}

/** Sales daily digest — TR 08:00 sabah maili (super_admin + partner) */
async function safeRunSalesDigest(): Promise<void> {
  if (!(await loadCronEnabled())) {
    console.log('[cron-scheduler] cron disabled, sales digest skipped');
    return;
  }
  console.log('[cron-scheduler] running sales daily digest...');
  try {
    const result = await runSalesDailyDigest();
    console.log(`[cron-scheduler] sales digest OK: sent=${result.sent} skipped=${result.skipped} errors=${result.errors.length}`);
    await writeLastRun('sales.cron.last_daily_digest', {
      sent: result.sent,
      skipped: result.skipped,
      errors: result.errors.length,
      reason: result.reason,
      counts: result.counts,
    });
  } catch (e: any) {
    console.error('[cron-scheduler] sales digest error:', e?.message);
    await writeLastRun('sales.cron.last_daily_digest', { error: e?.message ?? 'unknown' });
  }
}

/** Weekly trend digest — TR Pazartesi 09:00 (yalnızca super_admin / Mert) */
async function safeRunWeeklyTrendDigest(): Promise<void> {
  if (!(await loadCronEnabled())) {
    console.log('[cron-scheduler] cron disabled, weekly trend digest skipped');
    return;
  }
  console.log('[cron-scheduler] running weekly trend digest...');
  try {
    const result = await runWeeklyTrendDigest();
    console.log(`[cron-scheduler] weekly trend digest OK: sent=${result.sent} skipped=${result.skipped} errors=${result.errors.length}`);
    await writeLastRun('sales.cron.last_weekly_trend_digest', {
      sent: result.sent,
      skipped: result.skipped,
      errors: result.errors.length,
      reason: result.reason,
    });
  } catch (e: any) {
    console.error('[cron-scheduler] weekly trend digest error:', e?.message);
    await writeLastRun('sales.cron.last_weekly_trend_digest', { error: e?.message ?? 'unknown' });
  }
}

/** Operations daily digest — role-aware mail (super_admin/partner/captain/crew + opt-in)
 *  variant='morning' (TR 09:00): bugün odaklı
 *  variant='evening' (TR 23:00): yarın hazırlık
 */
async function safeRunOpsDigest(variant: 'morning' | 'evening'): Promise<void> {
  if (!(await loadCronEnabled())) {
    console.log(`[cron-scheduler] cron disabled, ops digest (${variant}) skipped`);
    return;
  }
  console.log(`[cron-scheduler] running ops daily digest (${variant})...`);
  try {
    const result = await runOpsDailyDigest(null, variant);
    console.log(`[cron-scheduler] ops digest ${variant} OK: sent=${result.sent} failed=${result.failed}`);
    await writeLastRun(`ops.cron.last_daily_digest_${variant}`, {
      sent: result.sent,
      failed: result.failed,
      reason: result.reason,
    });
  } catch (e: any) {
    console.error(`[cron-scheduler] ops digest (${variant}) error:`, e?.message);
    await writeLastRun(`ops.cron.last_daily_digest_${variant}`, { error: e?.message ?? 'unknown' });
  }
}

/** Notifications retention — 90 gün okunmuş + 180 gün okunmamış sil.
 *  Bell ikonunda biriken bildirim sayısını kontrol altında tutar, eski okunmuşlar
 *  veritabanını şişirmesin. Yeni notification akışı zaten dedupe_key ile idempotent. */
export async function runNotificationCleanup(): Promise<{ deleted_read: number; deleted_unread: number }> {
  let deletedRead = 0;
  let deletedUnread = 0;
  try {
    const r1 = await sql`
      DELETE FROM notifications
      WHERE read_at IS NOT NULL AND read_at < now() - interval '90 days'
      RETURNING id
    `;
    deletedRead = r1.length;
  } catch (e: any) {
    console.error('[cron-scheduler] notif cleanup (read) error:', e?.message);
  }
  try {
    const r2 = await sql`
      DELETE FROM notifications
      WHERE read_at IS NULL AND created_at < now() - interval '180 days'
      RETURNING id
    `;
    deletedUnread = r2.length;
  } catch (e: any) {
    console.error('[cron-scheduler] notif cleanup (unread) error:', e?.message);
  }
  if (deletedRead > 0 || deletedUnread > 0) {
    console.log(`[cron-scheduler] notif cleanup: deleted_read=${deletedRead} deleted_unread=${deletedUnread}`);
  }
  await writeLastRun('cron.last_notif_cleanup', { deleted_read: deletedRead, deleted_unread: deletedUnread });
  return { deleted_read: deletedRead, deleted_unread: deletedUnread };
}

/** lead_scores retention — lead başına en yeni LEAD_SCORES_KEEP_PER_LEAD snapshot tutulur.
 *  recompute-scores cron'u (15dk) recency_factor zaman-decay'i nedeniyle skor değişmese bile
 *  her tick yeni satır INSERT ediyor → sınırsız büyüme (22 günde 100k satır / 67MB). Bu retention
 *  tabloyu ~20×lead_sayısı'nda sabitler, lead'in EN SON skoru asla silinmez (rn=1 hep korunur),
 *  ~26 gün trend geçmişi kalır. Tamamen türetilmiş veri — kaynak leads + email_events'ten yeniden
 *  hesaplanabilir, audit gerektirmez. */
const LEAD_SCORES_KEEP_PER_LEAD = 20;
export async function runLeadScoresCleanup(): Promise<{ deleted: number }> {
  let deleted = 0;
  try {
    const r = await sql`
      WITH ranked AS (
        SELECT id, row_number() OVER (PARTITION BY lead_id ORDER BY computed_at DESC) AS rn
        FROM lead_scores
      )
      DELETE FROM lead_scores ls
      USING ranked
      WHERE ls.id = ranked.id AND ranked.rn > ${LEAD_SCORES_KEEP_PER_LEAD}
      RETURNING ls.id
    `;
    deleted = r.length;
  } catch (e: any) {
    console.error('[cron-scheduler] lead_scores cleanup error:', e?.message);
  }
  if (deleted > 0) {
    console.log(`[cron-scheduler] lead_scores cleanup: deleted=${deleted} (keep_per_lead=${LEAD_SCORES_KEEP_PER_LEAD})`);
  }
  await writeLastRun('cron.last_lead_scores_cleanup', { deleted, keep_per_lead: LEAD_SCORES_KEEP_PER_LEAD });
  return { deleted };
}

/** Tekrarlı görev + gider şablonlarını instantiate et. DB'deki generate_recurring_tasks/_expenses() */
export async function runRecurringTick(): Promise<{ ok: true; tasks?: number; expenses?: number }> {
  let tasks = 0;
  let expenses = 0;
  try {
    const rTasks = await sql`SELECT generate_recurring_tasks() AS n`;
    tasks = Number(rTasks[0]?.n ?? 0);
  } catch (e: any) {
    console.error('[cron-scheduler] recurring tasks error:', e?.message);
  }
  try {
    const rExpenses = await sql`SELECT generate_recurring_expenses() AS n`;
    expenses = Number(rExpenses[0]?.n ?? 0);
  } catch (e: any) {
    console.error('[cron-scheduler] recurring expenses error:', e?.message);
  }
  await writeLastRun('cron.last_recurring', { tasks, expenses });
  return { ok: true, tasks, expenses };
}

export function startCronScheduler(): void {
  if (warmupTask || scoresTask) {
    console.warn('[cron-scheduler] already started');
    return;
  }

  // warmup-tick: her gün 00:00 UTC — Backend B6 fix: campaign-worker daily cap window
  // (UTC midnight'a göre count) ile align edilmiş; eskiden 00:05'ti, 5dk pencerede
  // worker yeni günü saymaya başlamış, warmup henüz sent_today reset etmemiş oluyordu.
  warmupTask = cron.schedule('0 0 * * *', () => {
    safeRunWarmup().catch((e) => console.error('[cron-scheduler] warmup unhandled:', e?.message));
  }, { timezone: 'UTC' });

  // recompute-scores: her 15 dakikada bir
  scoresTask = cron.schedule('*/15 * * * *', () => {
    safeRunScores().catch((e) => console.error('[cron-scheduler] scores unhandled:', e?.message));
  }, { timezone: 'UTC' });

  // task-overdue: her gün 00:00 UTC (TR 03:00)
  overdueTask = cron.schedule('0 0 * * *', () => {
    runOverdueTick().catch((e) => console.error('[cron-scheduler] overdue unhandled:', e?.message));
  }, { timezone: 'UTC' });

  // recurring tasks + expenses: her gün 00:00 UTC (TR 03:00)
  recurringTask = cron.schedule('0 0 * * *', () => {
    runRecurringTick().catch((e) => console.error('[cron-scheduler] recurring unhandled:', e?.message));
  }, { timezone: 'UTC' });

  // sales daily digest: her gün 05:00 UTC (= TR 08:00 sabah)
  digestTask = cron.schedule('0 5 * * *', () => {
    safeRunSalesDigest().catch((e) => console.error('[cron-scheduler] sales digest unhandled:', e?.message));
  }, { timezone: 'UTC' });

  // weekly trend digest: her Pazartesi 06:00 UTC (= TR 09:00) — yalnızca super_admin (Mert)
  weeklyTrendTask = cron.schedule('0 6 * * 1', () => {
    safeRunWeeklyTrendDigest().catch((e) => console.error('[cron-scheduler] weekly trend unhandled:', e?.message));
  }, { timezone: 'UTC' });

  // ops daily digest — morning: 06:00 UTC = TR 09:00 sabah
  opsDigestTask = cron.schedule('0 6 * * *', () => {
    safeRunOpsDigest('morning').catch((e) => console.error('[cron-scheduler] ops morning unhandled:', e?.message));
  }, { timezone: 'UTC' });

  // ops daily digest — evening: 20:00 UTC = TR 23:00 gece (yarın hazırlık)
  opsEveningDigestTask = cron.schedule('0 20 * * *', () => {
    safeRunOpsDigest('evening').catch((e) => console.error('[cron-scheduler] ops evening unhandled:', e?.message));
  }, { timezone: 'UTC' });

  // gece temizliği — her gün 01:00 UTC (TR 04:00), diğer 00:00 cron'larla çakışmasın.
  // notifications retention + lead_scores retention birlikte koşar.
  notifCleanupTask = cron.schedule('0 1 * * *', () => {
    runNotificationCleanup().catch((e) => console.error('[cron-scheduler] notif cleanup unhandled:', e?.message));
    runLeadScoresCleanup().catch((e) => console.error('[cron-scheduler] lead_scores cleanup unhandled:', e?.message));
  }, { timezone: 'UTC' });

  // partner tekne takvim senkronu: 10dk'da bir — agency_only tekneler freeBusy → boat_busy_slots
  partnerSyncTask = cron.schedule('*/10 * * * *', () => {
    safeRunPartnerSync().catch((e) => console.error('[cron-scheduler] partner-sync unhandled:', e?.message));
  }, { timezone: 'UTC' });

  // constantine çift-yön takvim senkronu (Simon): 10dk'da bir, partner-sync'ten 5dk offset
  // (5,15,...,55) — token refresh'leri ve API yükü çakışmasın.
  constantineSyncTask = cron.schedule('5-59/10 * * * *', () => {
    safeRunConstantineSync().catch((e) => console.error('[cron-scheduler] constantine-sync unhandled:', e?.message));
  }, { timezone: 'UTC' });

  console.log('[cron-scheduler] scheduled:');
  console.log('  - warmup-tick: cron("0 0 * * *", UTC)');
  console.log('  - recompute-scores: cron("*/15 * * * *", UTC)');
  console.log('  - task-overdue: cron("0 0 * * *", UTC)');
  console.log('  - recurring (tasks+expenses): cron("0 0 * * *", UTC)');
  console.log('  - sales daily digest: cron("0 5 * * *", UTC = TR 08:00)');
  console.log('  - weekly trend digest: cron("0 6 * * 1", UTC = TR Pazartesi 09:00, super_admin)');
  console.log('  - ops daily digest [morning]: cron("0 6 * * *", UTC = TR 09:00)');
  console.log('  - ops daily digest [evening]: cron("0 20 * * *", UTC = TR 23:00)');
  console.log('  - notifications cleanup: cron("0 1 * * *", UTC = TR 04:00) — 90g okunmuş + 180g okunmamış sil');
  console.log('  - lead_scores cleanup: cron("0 1 * * *", UTC = TR 04:00) — lead başına son 20 snapshot tut');
  console.log('  - partner-calendar-sync: cron("*/10 * * * *", UTC) — agency_only tekneler freeBusy → boat_busy_slots');
  console.log('  - constantine-sync: cron("5-59/10 * * * *", UTC) — sync_enabled tekneler çift-yön (Simon)');
}

export function stopCronScheduler(): void {
  if (warmupTask) { warmupTask.stop(); warmupTask = null; }
  if (scoresTask) { scoresTask.stop(); scoresTask = null; }
  if (overdueTask) { overdueTask.stop(); overdueTask = null; }
  if (recurringTask) { recurringTask.stop(); recurringTask = null; }
  if (digestTask) { digestTask.stop(); digestTask = null; }
  if (weeklyTrendTask) { weeklyTrendTask.stop(); weeklyTrendTask = null; }
  if (opsDigestTask) { opsDigestTask.stop(); opsDigestTask = null; }
  if (opsEveningDigestTask) { opsEveningDigestTask.stop(); opsEveningDigestTask = null; }
  if (notifCleanupTask) { notifCleanupTask.stop(); notifCleanupTask = null; }
  if (partnerSyncTask) { partnerSyncTask.stop(); partnerSyncTask = null; }
  if (constantineSyncTask) { constantineSyncTask.stop(); constantineSyncTask = null; }
  console.log('[cron-scheduler] stopped');
}
