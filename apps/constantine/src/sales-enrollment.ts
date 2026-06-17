/**
 * /functions/v1/enroll-leads — Faz A3 (Sales Otomasyon planı)
 *
 * Verilen lead'leri kampanya policy triajından geçirir ve eligible olanları
 * campaign_targets'a enroll eder.
 *
 * Auth: requireAuth (sales kullanıcısı, herhangi bir authenticated user).
 *
 * Request:
 *   {
 *     campaign_id: uuid,
 *     lead_ids: uuid[],
 *     dry_run?: boolean,            // default true
 *     cooldown_override?: number    // gün; null=kampanyanın değeri
 *   }
 *
 * Response:
 *   {
 *     ok: true,
 *     dry_run: boolean,
 *     campaign_id: uuid,
 *     cooldown_days: number,        // effective
 *     eligible: uuid[],
 *     dropped: [{ lead_id, reason }],
 *     summary: { eligible: N, suppressed: N, ... },
 *     enrolled_count: number        // dry_run=false ise
 *   }
 *
 * Reason tablosu: lead_not_found | opted_out | no_email | suppressed | already_enrolled | cooldown
 */
import type { Context } from 'hono';
import { sql } from './db.js';
import { requireAuth } from './middleware.js';

interface EnrollBody {
  campaign_id?: string;
  lead_ids?: string[];
  dry_run?: boolean;
  cooldown_override?: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleEnrollLeads(c: Context): Promise<Response> {
  const auth = requireAuth(c);
  if (!auth) return c.json({ error: 'Auth gerek' }, 401);

  let body: EnrollBody;
  try {
    body = (await c.req.json()) as EnrollBody;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const campaignId = body.campaign_id;
  if (!campaignId || !UUID_RE.test(campaignId)) {
    return c.json({ error: 'campaign_id_required' }, 400);
  }

  const leadIds = Array.isArray(body.lead_ids) ? body.lead_ids : [];
  if (leadIds.length === 0) {
    return c.json({ error: 'lead_ids_required' }, 400);
  }
  if (leadIds.length > 5000) {
    return c.json({ error: 'too_many_lead_ids', limit: 5000 }, 400);
  }
  for (const id of leadIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return c.json({ error: 'invalid_lead_id', value: id }, 400);
    }
  }

  const dryRun = body.dry_run !== false; // default true — güvenlik için
  const cooldownOverride =
    typeof body.cooldown_override === 'number' && body.cooldown_override >= 0
      ? Math.floor(body.cooldown_override)
      : null;

  // 1. Triage via Postgres function
  let triage: {
    campaign_id: string;
    cooldown_days: number;
    eligible: string[];
    dropped: Array<{ lead_id: string; reason: string }>;
    summary: Record<string, number>;
  };
  try {
    const rows = await sql<Array<{ result: any }>>`
      SELECT eligible_leads_for_campaign(${campaignId}::uuid, ${leadIds as any}::uuid[], ${cooldownOverride}::int) AS result
    `;
    triage = rows[0]?.result;
  } catch (err: any) {
    if (String(err?.message ?? '').includes('campaign_not_found')) {
      return c.json({ error: 'campaign_not_found' }, 404);
    }
    console.error('[enroll-leads] triage error:', err);
    return c.json({ error: 'triage_failed', detail: err?.message ?? String(err) }, 500);
  }

  if (!triage) {
    return c.json({ error: 'triage_empty' }, 500);
  }

  const eligible = Array.isArray(triage.eligible) ? triage.eligible : [];

  // 2. Dry-run kısa yol
  if (dryRun) {
    return c.json({
      ok: true,
      dry_run: true,
      campaign_id: campaignId,
      cooldown_days: triage.cooldown_days,
      eligible,
      dropped: triage.dropped ?? [],
      summary: triage.summary ?? {},
      enrolled_count: 0,
    });
  }

  // 3. INSERT — ON CONFLICT DO NOTHING (race-safe)
  let enrolledCount = 0;
  if (eligible.length > 0) {
    try {
      const inserted = await sql<Array<{ lead_id: string }>>`
        INSERT INTO campaign_targets (campaign_id, lead_id, status, sequence_step)
        SELECT ${campaignId}::uuid, lead_id::uuid, 'queued', 0
          FROM unnest(${eligible as any}::uuid[]) AS lead_id
        ON CONFLICT (campaign_id, lead_id) DO NOTHING
        RETURNING lead_id
      `;
      enrolledCount = inserted.length;
    } catch (err: any) {
      console.error('[enroll-leads] insert error:', err);
      return c.json({ error: 'insert_failed', detail: err?.message ?? String(err) }, 500);
    }
  }

  // 4. campaigns.target_count senkronize (sayım yapıyor view bağımsız)
  try {
    await sql`
      UPDATE campaigns SET target_count = (
        SELECT count(*) FROM campaign_targets WHERE campaign_id = ${campaignId}::uuid
      )
      WHERE id = ${campaignId}::uuid
    `;
  } catch (err: any) {
    console.warn('[enroll-leads] target_count sync failed (non-fatal):', err?.message);
  }

  // 5. Activity event
  try {
    await sql`
      INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
      VALUES (
        ${auth.userId}::uuid,
        'leads_enrolled_to_campaign',
        'standard',
        0,
        'campaign',
        ${campaignId}::uuid,
        ${sql.json({
          campaign_id: campaignId,
          input_count: leadIds.length,
          eligible_count: eligible.length,
          enrolled_count: enrolledCount,
          dropped_summary: triage.summary ?? {},
          cooldown_days: triage.cooldown_days,
          cooldown_override: cooldownOverride,
        })}
      )
    `;
  } catch (err: any) {
    console.warn('[enroll-leads] activity_events insert failed (non-fatal):', err?.message);
  }

  return c.json({
    ok: true,
    dry_run: false,
    campaign_id: campaignId,
    cooldown_days: triage.cooldown_days,
    eligible,
    dropped: triage.dropped ?? [],
    summary: triage.summary ?? {},
    enrolled_count: enrolledCount,
  });
}
