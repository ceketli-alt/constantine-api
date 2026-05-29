/**
 * /functions/v1/cron-tick-warmup — Email kampanya warmup day tick
 *
 * Schedule: her gün 00:05 UTC (cron-scheduler.ts tarafından)
 *
 * Akış:
 *  1. Aktif warmup_state'leri çek (campaigns.warmup_enabled=true, status='running')
 *  2. Her state için:
 *     a. sent_today = 0 reset
 *     b. bounce/complaint son 24h sayım
 *     c. bounce > 5% → pause 24h
 *     d. complaint > 0.1% → pause 72h
 *     e. paused_until geçtiyse → resume
 *     f. Paused değilse + 24h geçtiyse → warmup_day++, current_cap update
 *     g. activity_events log
 */
import type { Context } from 'hono';
import { sql } from './db.js';

const BOUNCE_RATE_THRESHOLD = 0.05;
const COMPLAINT_RATE_THRESHOLD = 0.001;

export function capForDay(day: number): number {
  if (day <= 3) return 50;
  if (day <= 7) return 100;
  if (day <= 10) return 200;
  if (day <= 14) return 500;
  return 1000;
}

export interface WarmupTickResult {
  ok: boolean;
  ticked: number;
  results: Array<{
    campaign_id: string;
    new_day?: number;
    new_cap?: number;
    bounce_rate?: number;
    paused?: string | null;
    resumed?: boolean;
    error?: string;
  }>;
}

export async function runWarmupTick(): Promise<WarmupTickResult> {
  const now = new Date();
  const since24hIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const results: WarmupTickResult['results'] = [];

  // 1. Active warmup states (JOIN campaigns)
  const states = await sql`
    SELECT ws.id, ws.campaign_id, ws.warmup_day, ws.current_cap, ws.sent_today,
           ws.bounce_count_24h, ws.complaint_count_24h,
           ws.paused_reason, ws.paused_until, ws.last_advanced_at,
           c.name AS campaign_name
    FROM campaign_warmup_state ws
    INNER JOIN campaigns c ON c.id = ws.campaign_id
    WHERE c.warmup_enabled = true
      AND c.status = 'running'
  `;

  if (states.length === 0) {
    return { ok: true, ticked: 0, results: [] };
  }

  for (const state of states) {
    try {
      const campaignId: string = state.campaign_id;
      const sentLast24h: number = Number(state.sent_today ?? 0);

      // 2b. Bounce + complaint sayım (email_events JOIN email_messages.campaign_id)
      const bounceRows = await sql`
        SELECT count(*)::int AS n
        FROM email_events ev
        INNER JOIN email_messages m ON m.id = ev.message_id
        WHERE ev.event_type = 'bounced'
          AND m.campaign_id = ${campaignId}
          AND ev.occurred_at >= ${since24hIso}
      `;
      const complaintRows = await sql`
        SELECT count(*)::int AS n
        FROM email_events ev
        INNER JOIN email_messages m ON m.id = ev.message_id
        WHERE ev.event_type = 'complained'
          AND m.campaign_id = ${campaignId}
          AND ev.occurred_at >= ${since24hIso}
      `;
      const bounceCount: number = bounceRows[0]?.n ?? 0;
      const complaintCount: number = complaintRows[0]?.n ?? 0;
      const bounceRate = sentLast24h > 0 ? bounceCount / sentLast24h : 0;
      const complaintRate = sentLast24h > 0 ? complaintCount / sentLast24h : 0;

      const wasPaused = !!state.paused_reason;
      let newPausedReason: string | null = state.paused_reason;
      let newPausedUntil: Date | null = state.paused_until ? new Date(state.paused_until) : null;
      let isPausing = false;
      let isResuming = false;

      if (bounceRate > BOUNCE_RATE_THRESHOLD) {
        newPausedReason = 'bounce_threshold';
        newPausedUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        isPausing = !wasPaused;
      } else if (complaintRate > COMPLAINT_RATE_THRESHOLD) {
        newPausedReason = 'complaint_threshold';
        newPausedUntil = new Date(now.getTime() + 72 * 60 * 60 * 1000);
        isPausing = !wasPaused;
      } else if (wasPaused && newPausedUntil && newPausedUntil <= now) {
        newPausedReason = null;
        newPausedUntil = null;
        isResuming = true;
      }

      // 2f. Day advance (paused değilse + 24h geçtiyse)
      const lastAdv = new Date(state.last_advanced_at);
      const dayPassed = now.getTime() - lastAdv.getTime() >= 24 * 60 * 60 * 1000 - 10 * 60 * 1000;
      const willBePaused = !!newPausedReason;

      let newDay: number = Number(state.warmup_day ?? 1);
      let newCap: number = Number(state.current_cap ?? 50);
      let lastAdvancedAtIso: string | null = null;
      let advanced = false;

      if (!willBePaused && dayPassed) {
        newDay = newDay + 1;
        newCap = capForDay(newDay);
        lastAdvancedAtIso = now.toISOString();
        advanced = true;
      }

      // Single update — kolonları conditional set etmek için iki yol:
      // (a) Her zaman set, advance olmadıysa eski değer → basit
      if (lastAdvancedAtIso) {
        await sql`
          UPDATE campaign_warmup_state
          SET sent_today = 0,
              bounce_count_24h = ${bounceCount},
              complaint_count_24h = ${complaintCount},
              paused_reason = ${newPausedReason},
              paused_until = ${newPausedUntil ? newPausedUntil.toISOString() : null},
              warmup_day = ${newDay},
              current_cap = ${newCap},
              last_advanced_at = ${lastAdvancedAtIso}
          WHERE id = ${state.id}
        `;
      } else {
        await sql`
          UPDATE campaign_warmup_state
          SET sent_today = 0,
              bounce_count_24h = ${bounceCount},
              complaint_count_24h = ${complaintCount},
              paused_reason = ${newPausedReason},
              paused_until = ${newPausedUntil ? newPausedUntil.toISOString() : null}
          WHERE id = ${state.id}
        `;
      }

      // 2g. Activity log (super_admin user_id ile)
      const adminRows = await sql`
        SELECT id FROM profiles WHERE role = 'super_admin' AND active = true
        ORDER BY created_at LIMIT 1
      `;
      const adminId: string | undefined = adminRows[0]?.id;
      if (adminId) {
        if (isPausing) {
          try {
            await sql`
              INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
              VALUES (
                ${adminId}::uuid, 'warmup_paused', 'standard', 0, 'campaign', ${campaignId}::uuid,
                ${sql.json({
                  reason: newPausedReason,
                  bounce_rate: Number(bounceRate.toFixed(4)),
                  complaint_rate: Number(complaintRate.toFixed(4)),
                  paused_until: newPausedUntil?.toISOString() ?? null,
                })}
              )
            `;
          } catch (e: any) { console.warn('[cron-warmup] activity log warmup_paused:', e.message); }
        } else if (isResuming) {
          try {
            await sql`
              INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
              VALUES (
                ${adminId}::uuid, 'warmup_resumed', 'standard', 0, 'campaign', ${campaignId}::uuid,
                ${sql.json({ auto: true })}
              )
            `;
          } catch (e: any) { console.warn('[cron-warmup] activity log warmup_resumed:', e.message); }
        } else if (advanced) {
          try {
            await sql`
              INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
              VALUES (
                ${adminId}::uuid, 'warmup_advanced', 'standard', 0, 'campaign', ${campaignId}::uuid,
                ${sql.json({ day: newDay, cap: newCap })}
              )
            `;
          } catch (e: any) { console.warn('[cron-warmup] activity log warmup_advanced:', e.message); }
        }
      }

      results.push({
        campaign_id: campaignId,
        new_day: newDay,
        new_cap: newCap,
        bounce_rate: Number(bounceRate.toFixed(4)),
        paused: newPausedReason,
        resumed: isResuming,
      });
    } catch (e: any) {
      console.error(`[cron-warmup] state ${state.id} error:`, e?.message);
      results.push({
        campaign_id: state.campaign_id,
        error: e?.message ?? 'unknown',
      });
    }
  }

  return { ok: true, ticked: results.length, results };
}

/** HTTP handler — manuel tetikleme için (super_admin) */
export async function handleWarmupTick(c: Context): Promise<Response> {
  try {
    const result = await runWarmupTick();
    return c.json(result);
  } catch (e: any) {
    console.error('[cron-warmup] unhandled:', e);
    return c.json({ error: 'internal_error', message: e?.message }, 500);
  }
}
