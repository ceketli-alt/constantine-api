-- 2026-06-11 — eligible_leads_for_campaign function
-- Faz A2: Verilen lead listesini kampanya policy'sine göre triajlar.
--
-- İmza:
--   eligible_leads_for_campaign(p_campaign_id uuid, p_lead_ids uuid[], p_cooldown_override int)
--   RETURNS jsonb
--
-- Dönüş:
--   {
--     "campaign_id": "...",
--     "eligible": ["<lead_id>", ...],
--     "dropped":  [ { "lead_id": "...", "reason": "..." }, ... ],
--     "summary":  { "eligible": N, "suppressed": N, ... }
--   }
--
-- Reason değerleri:
--   eligible | lead_not_found | opted_out | no_email | suppressed
--   | already_enrolled | cooldown
--
-- Karar önceliği (bir lead birden fazla nedenle düşse de ilk eşleşen reason set olur):
--   lead_not_found → opted_out → no_email → suppressed → already_enrolled → cooldown → eligible
--
-- Cooldown:
--   p_cooldown_override NOT NULL → o değer kullanılır
--   NULL → campaign.cooldown_days (respect_global_cooldown=false ise cooldown bypass)

CREATE OR REPLACE FUNCTION eligible_leads_for_campaign(
  p_campaign_id    uuid,
  p_lead_ids       uuid[],
  p_cooldown_override int DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_campaign       record;
  v_cooldown_days  int;
  v_eligible       uuid[]  := ARRAY[]::uuid[];
  v_dropped        jsonb   := '[]'::jsonb;
  v_summary        jsonb   := '{}'::jsonb;
  v_row            record;
BEGIN
  -- 1. Campaign lookup
  SELECT id, cooldown_days, respect_global_cooldown
    INTO v_campaign
    FROM campaigns
   WHERE id = p_campaign_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_not_found: %', p_campaign_id;
  END IF;

  -- 2. Effective cooldown
  IF v_campaign.respect_global_cooldown = false THEN
    v_cooldown_days := 0;
  ELSIF p_cooldown_override IS NOT NULL THEN
    v_cooldown_days := GREATEST(p_cooldown_override, 0);
  ELSE
    v_cooldown_days := v_campaign.cooldown_days;
  END IF;

  -- 3. Per-lead reason çıkarımı — tek CTE pass
  FOR v_row IN
    WITH input_leads AS (
      SELECT unnest(p_lead_ids) AS lead_id
    ),
    triage AS (
      SELECT
        il.lead_id,
        l.id                     AS l_id,
        l.status::text           AS l_status,
        l.primary_contact_email  AS l_email,
        l.last_contacted_at      AS l_last_contacted,
        (
          SELECT 1 FROM unsubscribes u
           WHERE u.channel = 'email'
             AND lower(u.identifier) = lower(l.primary_contact_email)
           LIMIT 1
        )                        AS suppressed_hit,
        (
          SELECT 1 FROM campaign_targets ct
           WHERE ct.campaign_id = p_campaign_id
             AND ct.lead_id     = l.id
           LIMIT 1
        )                        AS enrolled_hit
      FROM input_leads il
      LEFT JOIN leads l ON l.id = il.lead_id
    )
    SELECT
      lead_id,
      CASE
        WHEN l_id IS NULL                                THEN 'lead_not_found'
        WHEN l_status = 'opted_out'                      THEN 'opted_out'
        WHEN l_email IS NULL OR btrim(l_email) = ''      THEN 'no_email'
        WHEN suppressed_hit IS NOT NULL                  THEN 'suppressed'
        WHEN enrolled_hit IS NOT NULL                    THEN 'already_enrolled'
        WHEN v_cooldown_days > 0
             AND l_last_contacted IS NOT NULL
             AND l_last_contacted > (now() - (v_cooldown_days || ' days')::interval)
                                                         THEN 'cooldown'
        ELSE 'eligible'
      END AS reason
    FROM triage
  LOOP
    IF v_row.reason = 'eligible' THEN
      v_eligible := v_eligible || v_row.lead_id;
    ELSE
      v_dropped := v_dropped || jsonb_build_object(
        'lead_id', v_row.lead_id,
        'reason',  v_row.reason
      );
    END IF;

    -- summary tally
    v_summary := jsonb_set(
      v_summary,
      ARRAY[v_row.reason],
      to_jsonb(COALESCE((v_summary->>v_row.reason)::int, 0) + 1),
      true
    );
  END LOOP;

  RETURN jsonb_build_object(
    'campaign_id', p_campaign_id,
    'cooldown_days', v_cooldown_days,
    'eligible',    to_jsonb(v_eligible),
    'dropped',     v_dropped,
    'summary',     v_summary
  );
END
$$;

COMMENT ON FUNCTION eligible_leads_for_campaign IS
  'Faz A2: Kampanya policy triajı. dropped[]: reason ∈ {lead_not_found,opted_out,no_email,suppressed,already_enrolled,cooldown}';
