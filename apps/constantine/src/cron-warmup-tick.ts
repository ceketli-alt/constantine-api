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
 *     c. bounce: >=20 gönderimde oran >%5 → pause 24h; <20 gönderimde mutlak >=3 bounce → pause 24h
 *        (asgari hacim tabanı: 5 örnekten oran hesaplanmaz — Mert kararı 26 Ağu 2026)
 *     d. complaint: 24 saatte >=2 sikayet VE oran >%0,3 → pause 24h (Mert 21 Eki 2026)
 *     e. paused_until geçtiyse → resume
 *     f. Paused değilse + 24h geçtiyse → warmup_day++, current_cap update
 *     g. activity_events log
 */
import type { Context } from 'hono';
import { sql } from './db.js';

// Duraklatma karari saf fonksiyonda (test edilebilsin diye): src/warmup-guard.ts
import { duraklatmaKarari } from './warmup-guard.js';

export function capForDay(day: number, mailboxes = 2): number {
  // COLD B2B OUTREACH ramp. Güvenli soğuk tavan KUTU BAŞINA ~25/gün; kampanya tavanı = kutu başı
  // × gönderici kutu sayısı. 21 Eki 2026'ya kadar "2 kutu" varsayımı sabit kodluydu → HER kampanya
  // 50/gün'de kilitleniyordu; 6 kutulu havuzda da (daily_cap ne olursa olsun) 50'yi geçemiyordu.
  // mailboxes=2 (varsayılan) eski eğriyle BİREBİR aynı: 20/30/40/50.
  const n = Math.max(1, Math.floor(mailboxes));
  let perMailbox: number;
  if (day <= 3) perMailbox = 10;        // ilk dokunuş, çok temkinli
  else if (day <= 7) perMailbox = 15;
  else if (day <= 14) perMailbox = 20;
  else perMailbox = 25;                 // cold steady-state (kutu başına üstüne çıkma)
  return perMailbox * n;
}

/** Kampanyanın gerçek gönderici kutu sayısı: sender_pool doluysa onun boyu, yoksa 1. */
export function mailboxCount(senderPool: unknown): number {
  const pool = Array.isArray(senderPool) ? senderPool.filter((s) => typeof s === 'string' && s.includes('@')) : [];
  return pool.length > 0 ? pool.length : 1;
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
           c.name AS campaign_name, c.sender_pool
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
      const karar = duraklatmaKarari(sentLast24h, bounceCount, complaintCount);
      // loglama icin oranlar (karar artik saf fonksiyonda veriliyor)
      const bounceRate = sentLast24h > 0 ? bounceCount / sentLast24h : 0;
      const complaintRate = sentLast24h > 0 ? complaintCount / sentLast24h : 0;

      const wasPaused = !!state.paused_reason;
      let newPausedReason: string | null = state.paused_reason;
      let newPausedUntil: Date | null = state.paused_until ? new Date(state.paused_until) : null;
      let isPausing = false;
      let isResuming = false;

      if (karar.durdur) {
        newPausedReason = karar.sebep;
        newPausedUntil = new Date(now.getTime() + karar.saat * 60 * 60 * 1000);
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
        newCap = capForDay(newDay, mailboxCount(state.sender_pool));
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
