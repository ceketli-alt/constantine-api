-- DMC İlk Batch taslağı (3 Haz launch için) — Mert review'ı + seed test sonrası
-- status='running'e çevrilerek başlatılır. Worker SADECE 'running' işler → bu inert.
-- Tek seferlik. ON_ERROR_STOP ile çalıştır. Aynı isim varsa abort.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns WHERE name = 'DMC İlk Batch — premium (3 Haz)') THEN
    RAISE EXCEPTION 'Bu isimde campaign zaten var — abort (mükerrer önleme)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE role='super_admin' AND active=true) THEN
    RAISE EXCEPTION 'super_admin profil yok — created_by set edilemez';
  END IF;
END $$;

BEGIN;

INSERT INTO campaigns (
  name, description, channel, template_id, sender_email, sender_pool,
  status, daily_cap, segment_filter, follow_up_steps,
  ab_test_enabled, ab_winning_metric, min_gap_seconds, random_gap_seconds,
  warmup_enabled, created_by
) VALUES (
  'DMC İlk Batch — premium (3 Haz)',
  'İlk cold outreach batch. 162 premium DMC lead (seg-dmc + trust-high + email-valid). Haftalık 2 takip. Seed test sonrası status draft→running ile launch.',
  'email',
  '3a32c3a6-01c6-4d3c-a89d-2226e0df242b',   -- outreach_initial_agency_dmc_tr
  NULL,
  '["outreach@constantineyachts.online","mert@constantineyachts.online"]'::jsonb,
  'draft',
  16,
  '{"tags_all":["seg-dmc","trust-high","email-valid"],"note":"3 Haz premium ilk batch"}'::jsonb,
  '[{"template_id":"fc7e48f8-c335-4782-b85d-b412c121358b","delay_days":7},{"template_id":"7dd8f30e-4b3a-47ac-addd-f3f8dd371ee7","delay_days":7}]'::jsonb,
  false,
  'auto',
  45,    -- min_gap_seconds — insansı gönderim aralığı
  90,    -- random_gap_seconds — jitter (45-135s arası)
  true,  -- warmup_enabled → ramp (cap 16'da sabit) + bounce/complaint auto-pause
  (SELECT id FROM profiles WHERE role='super_admin' AND active=true ORDER BY created_at LIMIT 1)
)
RETURNING id AS cid \gset

-- 162 hedefi pool'dan doğrudan enroll (status='queued' → trigger sadece 'sent'te takip kurar)
INSERT INTO campaign_targets (campaign_id, lead_id, status)
SELECT :'cid', id, 'queued'
FROM leads
WHERE tags @> ARRAY['seg-dmc','trust-high','email-valid']::text[];

UPDATE campaigns
SET target_count = (SELECT count(*) FROM campaign_targets WHERE campaign_id = :'cid')
WHERE id = :'cid';

COMMIT;

-- Doğrulama
SELECT id, name, status, daily_cap, target_count,
       jsonb_array_length(follow_up_steps) AS followup_steps,
       sender_pool, min_gap_seconds, random_gap_seconds, warmup_enabled
FROM campaigns WHERE id = :'cid';

SELECT status, count(*) FROM campaign_targets WHERE campaign_id = :'cid' GROUP BY status;
