-- 0008_dmc_split_by_provider.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Bağlam: 2026-06-02 Instantly Inbox Placement testi (50 seed, 4 günlük warmup)
--   Genel: %74 inbox / %26 spam
--   Gmail (Other → Google):   100% inbox  ✅
--   Microsoft → Microsoft:    0% inbox / 100% SPAM  ❌
--
-- Mevcut DMC kampanyasının (60987729-ef6d-4919-b002-2b4c8ec4cf85, status='draft',
-- 162 lead queued) 34 Microsoft MX'li lead'i 9 Haz launch'undan AYRILIR ve
-- yeni "Phase 2 — Microsoft DMC (delayed)" kampanyasına taşınır. Phase 2
-- status='draft' kalır; warmup uzar + DMARC sertleşir + 8 Haz placement testi
-- pozitif gelirse manuel başlatılır.
--
-- Microsoft MX domain'leri (88 unique domain'in MX lookup'undan tespit, 2026-06-02):
--   Consumer: hotmail.com, msn.com  (19 lead)
--   Corporate Microsoft 365 (14 lead): adavegastravel.com, apptravelplatform.com,
--     canyonholidays.com, cabistanbul.com, cihangirtravel.com, functiontour.com,
--     mkjmice.com, itstourism.com, neslitours.com, soteksetiket.com.tr,
--     skylifetravel.com, traveltalktours.com, turaturizm.com, woxtour.com
--
-- Etkilenen veri:
--   leads.tags          : 34 lead'e 'provider-microsoft','phase2-delayed' eklenir
--   campaign_targets    : Phase 1 (60987729-...) -34 satır DELETE; Phase 2 +34 satır INSERT
--   campaigns           : Phase 2 kampanyası INSERT (draft)
--   Toplam 162 lead 128 (Phase 1, launch 9 Haz) + 34 (Phase 2, delayed) bölünür.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) 34 Microsoft MX lead'ine tag stamp (audit trail; "neden ayrıldı" kalıcı)
WITH ms_domains AS (
  SELECT unnest(ARRAY[
    'hotmail.com', 'msn.com',
    'adavegastravel.com', 'apptravelplatform.com', 'canyonholidays.com', 'cabistanbul.com',
    'cihangirtravel.com', 'functiontour.com', 'mkjmice.com', 'itstourism.com',
    'neslitours.com', 'soteksetiket.com.tr', 'skylifetravel.com',
    'traveltalktours.com', 'turaturizm.com', 'woxtour.com'
  ]) AS d
)
UPDATE leads l
SET tags = array(
  SELECT DISTINCT unnest(COALESCE(l.tags, ARRAY[]::text[]) || ARRAY['provider-microsoft','phase2-delayed'])
)
FROM ms_domains m
WHERE lower(split_part(l.primary_contact_email, '@', 2)) = m.d
  AND l.tags @> ARRAY['seg-dmc','trust-high','email-valid']
  AND l.status = 'new';

-- 2) Yeni "Phase 2" kampanyası — mevcut DMC config'ini kopyala
INSERT INTO campaigns (
  id, name, description, status,
  segment_filter, template_id,
  send_window_start, send_window_end, send_days, scheduled_at,
  started_at, completed_at, created_by, created_at,
  channel, sender_email, target_count, daily_cap,
  warmup_enabled, ab_test_enabled, ab_winner_variant, cron_paused,
  last_processed_at, follow_up_steps, sender_pool,
  min_gap_seconds, random_gap_seconds, max_new_leads_per_day,
  prioritize_new_leads, send_text_only, first_email_text_only,
  max_per_company_per_day, stop_company_on_reply, ab_winning_metric
)
SELECT
  gen_random_uuid(),
  'Phase 2 — Microsoft DMC (delayed)',
  'Mevcut "DMC İlk Batch — premium (9 Haz)" (60987729-ef6d-4919-b002-2b4c8ec4cf85) kampanyasından ayrılan 34 Microsoft MX lead. '
    || 'Sebep: 2026-06-02 Inbox Placement testi → cy.online → Microsoft = 100% SPAM, Gmail = 100% inbox. '
    || '4 günlük warmup Microsoft için yetersiz; uzun warmup + DMARC sertleştirme + 8 Haz placement testi pozitif → manuel launch.',
  'draft'::campaign_status,
  segment_filter, template_id,
  send_window_start, send_window_end, send_days, NULL,
  NULL, NULL, created_by, now(),
  channel, sender_email, NULL, daily_cap,
  warmup_enabled, ab_test_enabled, NULL, false,
  NULL, follow_up_steps, sender_pool,
  min_gap_seconds, random_gap_seconds, max_new_leads_per_day,
  prioritize_new_leads, send_text_only, first_email_text_only,
  max_per_company_per_day, stop_company_on_reply, ab_winning_metric
FROM campaigns
WHERE id = '60987729-ef6d-4919-b002-2b4c8ec4cf85';

-- 3) Phase 2 kampanyasına 34 Microsoft lead'i target olarak ekle
INSERT INTO campaign_targets (campaign_id, lead_id, status, sequence_step)
SELECT
  (SELECT id FROM campaigns WHERE name = 'Phase 2 — Microsoft DMC (delayed)' ORDER BY created_at DESC LIMIT 1),
  l.id,
  'queued'::campaign_target_status,
  0
FROM leads l
WHERE 'provider-microsoft' = ANY(l.tags)
  AND 'phase2-delayed' = ANY(l.tags);

-- 4) Phase 1 (mevcut) kampanyadan Microsoft 34 lead'i DELETE
DELETE FROM campaign_targets
WHERE campaign_id = '60987729-ef6d-4919-b002-2b4c8ec4cf85'
  AND lead_id IN (
    SELECT id FROM leads
    WHERE 'provider-microsoft' = ANY(tags)
      AND 'phase2-delayed' = ANY(tags)
  );

-- 5) Validation — invariant'lar tutmuyorsa rollback
DO $$
DECLARE
  v_phase1_count   int;
  v_phase2_count   int;
  v_ms_tagged      int;
  v_phase2_id      uuid;
BEGIN
  SELECT id INTO v_phase2_id
    FROM campaigns
    WHERE name = 'Phase 2 — Microsoft DMC (delayed)'
    ORDER BY created_at DESC LIMIT 1;

  SELECT COUNT(*) INTO v_phase1_count FROM campaign_targets
    WHERE campaign_id = '60987729-ef6d-4919-b002-2b4c8ec4cf85';
  SELECT COUNT(*) INTO v_phase2_count FROM campaign_targets
    WHERE campaign_id = v_phase2_id;
  SELECT COUNT(*) INTO v_ms_tagged FROM leads
    WHERE 'provider-microsoft' = ANY(tags)
      AND 'phase2-delayed' = ANY(tags);

  RAISE NOTICE 'Phase 1 target (9 Haz launch): %', v_phase1_count;
  RAISE NOTICE 'Phase 2 target (Microsoft delayed): %', v_phase2_count;
  RAISE NOTICE 'Microsoft tagged lead: %', v_ms_tagged;
  RAISE NOTICE 'Phase 2 campaign_id: %', v_phase2_id;

  IF v_phase1_count + v_phase2_count <> 162 THEN
    RAISE EXCEPTION 'Toplam target sayısı 162 değil: % + % = %',
      v_phase1_count, v_phase2_count, v_phase1_count + v_phase2_count;
  END IF;
  IF v_ms_tagged <> v_phase2_count THEN
    RAISE EXCEPTION 'Tagged lead (%) ile Phase 2 target (%) eşit değil',
      v_ms_tagged, v_phase2_count;
  END IF;
  IF v_phase2_count NOT BETWEEN 30 AND 40 THEN
    RAISE EXCEPTION 'Beklenmedik Phase 2 sayısı (% — 34 olmalı)', v_phase2_count;
  END IF;
END $$;

COMMIT;
