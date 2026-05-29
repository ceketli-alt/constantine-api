/**
 * /functions/v1/cron-recompute-scores — Lead scoring recompute
 *
 * Schedule: her 15 dakikada bir (cron-scheduler.ts tarafından)
 *
 * Akış:
 *  1. Stale lead'leri seç (3 koşul OR):
 *     - score_computed_at IS NULL
 *     - score_computed_at < now() - 24h
 *     - last_score_event_at > score_computed_at
 *  2. Her lead için son 30 gün email_events sayım, score formula, breakdown
 *  3. leads.score + breakdown update
 *  4. lead_scores history snapshot insert
 *  5. |delta| >= 10 → activity_events 'score_changed'
 *  6. Cleanup: lead_scores < now() - 90d DELETE
 */
import type { Context } from 'hono';
import { sql } from './db.js';

const BATCH_SIZE = 100;
const HISTORY_RETENTION_DAYS = 90;
const HOT_THRESHOLD = 60;
const HALF_LIFE_DAYS = 7;

const SEGMENT_WEIGHTS: Record<string, number> = {
  '5star_chain': 30,
  '5star_boutique': 25,
  '4star_premium': 15,
  'agroup_agency': 20,
  'bgroup_agency': 8,
  'dmc': 15,
  'wedding_planner': 12,
  'corporate_event': 10,
  'ota': 8,
  'yacht_platform': 12,
  'other': 5,
};

const TEMP_BONUS: Record<string, number> = {
  hot: 30,
  warm: 15,
  cold: 5,
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

interface ScoreInput {
  type?: string | null;
  segment?: string | null;
  temperature?: string | null;
  last_score_event_at?: string | null;
}

interface EventCounts {
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
}

interface ScoreOutput {
  total: number;
  emailScore: number;
  engagementScore: number;
  segmentScore: number;
  recencyDecay: number;
  daysSince: number;
}

function computeScore(lead: ScoreInput, counts: EventCounts): ScoreOutput {
  const emailScore = clamp(
    counts.delivered * 1 + counts.opened * 5 + counts.clicked * 15 + counts.replied * 30,
    0,
    40,
  );
  const lastEvtMs = lead.last_score_event_at
    ? new Date(lead.last_score_event_at).getTime()
    : Date.now() - 30 * 24 * 60 * 60 * 1000;
  const daysSince = (Date.now() - lastEvtMs) / (1000 * 60 * 60 * 24);
  const recencyDecay = Math.exp(-daysSince / HALF_LIFE_DAYS);
  const tempBase = lead.temperature ? (TEMP_BONUS[lead.temperature] ?? 0) : 0;
  const engagementScore = clamp(tempBase * recencyDecay, 0, 30);
  const segWeight = lead.segment ? (SEGMENT_WEIGHTS[lead.segment] ?? 5) : 5;
  const typeBonus = lead.type === 'hotel' ? 5 : 0;
  const segmentScore = clamp(segWeight + typeBonus, 0, 30);
  const total = Math.round(emailScore + engagementScore + segmentScore);
  return {
    total,
    emailScore: Math.round(emailScore),
    engagementScore: Math.round(engagementScore),
    segmentScore: Math.round(segmentScore),
    recencyDecay: Number(recencyDecay.toFixed(3)),
    daysSince: Number(daysSince.toFixed(1)),
  };
}

export interface RecomputeScoresResult {
  ok: boolean;
  processed: number;
  changed: number;
  new_hot: number;
}

export async function runRecomputeScores(): Promise<RecomputeScoresResult> {
  const now = new Date();
  const since24hIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const since30dIso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // 1. Stale leads — 3 koşul OR (postgres SQL direkt destekler)
  const leads = await sql`
    SELECT id, type::text, segment::text, temperature::text, score,
           last_score_event_at, score_computed_at
    FROM leads
    WHERE score_computed_at IS NULL
       OR score_computed_at < ${since24hIso}
       OR (last_score_event_at IS NOT NULL
           AND score_computed_at IS NOT NULL
           AND last_score_event_at > score_computed_at)
    ORDER BY score_computed_at NULLS FIRST
    LIMIT ${BATCH_SIZE}
  `;

  if (leads.length === 0) {
    return { ok: true, processed: 0, changed: 0, new_hot: 0 };
  }

  let processed = 0;
  let changed = 0;
  let newHot = 0;

  // super_admin id for activity_events
  const adminRows = await sql`
    SELECT id FROM profiles WHERE role = 'super_admin' AND active = true
    ORDER BY created_at LIMIT 1
  `;
  const adminId: string | undefined = adminRows[0]?.id;

  for (const lead of leads) {
    try {
      // 2a. email_events son 30 gün (email_messages.thread_id → email_threads.lead_id JOIN)
      const eventRows = await sql`
        SELECT ev.event_type::text AS event_type
        FROM email_events ev
        INNER JOIN email_messages m ON m.id = ev.message_id
        INNER JOIN email_threads t ON t.id = m.thread_id
        WHERE t.lead_id = ${lead.id}
          AND ev.occurred_at >= ${since30dIso}
      `;

      const counts: EventCounts = { delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0 };
      for (const e of eventRows) {
        switch (e.event_type) {
          case 'delivered': counts.delivered++; break;
          case 'opened': counts.opened++; break;
          case 'clicked': counts.clicked++; break;
          case 'replied': counts.replied++; break;
          case 'bounced': counts.bounced++; break;
        }
      }

      const r = computeScore(lead, counts);
      const oldScore: number = Number(lead.score ?? 0);

      const reason =
        lead.last_score_event_at &&
        lead.score_computed_at &&
        new Date(lead.last_score_event_at).getTime() > new Date(lead.score_computed_at).getTime()
          ? 'event_triggered'
          : !lead.score_computed_at
            ? 'cron_15min'
            : new Date(lead.score_computed_at) < new Date(since24hIso)
              ? 'cron_24h'
              : 'cron_15min';

      const breakdown = {
        emails: counts,
        engagement: {
          temperature: lead.temperature,
          days_since_last_event: r.daysSince,
          recency_decay: r.recencyDecay,
        },
        segment: {
          weight: SEGMENT_WEIGHTS[lead.segment ?? ''] ?? 5,
          type_bonus: lead.type === 'hotel' ? 5 : 0,
        },
        totals: {
          email_score: r.emailScore,
          engagement_score: r.engagementScore,
          segment_score: r.segmentScore,
          total: r.total,
        },
      };

      // 2c. leads update
      await sql`
        UPDATE leads
        SET score = ${r.total},
            score_breakdown = ${sql.json(breakdown as any)},
            score_computed_at = ${now.toISOString()}
        WHERE id = ${lead.id}
      `;

      // 2d. lead_scores history insert
      try {
        await sql`
          INSERT INTO lead_scores (
            lead_id, total, email_score, engagement_score, segment_score,
            recency_factor, breakdown, reason
          ) VALUES (
            ${lead.id}, ${r.total}, ${r.emailScore}, ${r.engagementScore}, ${r.segmentScore},
            ${r.recencyDecay}, ${sql.json(breakdown as any)}, ${reason}
          )
        `;
      } catch (e: any) {
        console.warn(`[cron-scores] lead_scores insert skipped:`, e.message);
      }

      processed++;

      // 2e. Significant change → activity log
      if (Math.abs(r.total - oldScore) >= 10 && adminId) {
        changed++;
        try {
          await sql`
            INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
            VALUES (
              ${adminId}::uuid, 'score_changed', 'standard', 0, 'lead', ${lead.id}::uuid,
              ${sql.json({ old: oldScore, new: r.total, delta: r.total - oldScore, reason })}
            )
          `;
        } catch (e: any) {
          console.warn(`[cron-scores] activity log skipped:`, e.message);
        }
      }

      if (oldScore < HOT_THRESHOLD && r.total >= HOT_THRESHOLD) {
        newHot++;
      }
    } catch (e: any) {
      console.error(`[cron-scores] lead ${lead.id} error:`, e?.message);
    }
  }

  // 3. Retention cleanup
  const retentionCutoff = new Date(
    now.getTime() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  try {
    await sql`DELETE FROM lead_scores WHERE computed_at < ${retentionCutoff}`;
  } catch (e: any) {
    console.warn('[cron-scores] retention cleanup skipped:', e.message);
  }

  return { ok: true, processed, changed, new_hot: newHot };
}

export async function handleRecomputeScores(c: Context): Promise<Response> {
  try {
    const result = await runRecomputeScores();
    return c.json(result);
  } catch (e: any) {
    console.error('[cron-scores] unhandled:', e);
    return c.json({ error: 'internal_error', message: e?.message }, 500);
  }
}
