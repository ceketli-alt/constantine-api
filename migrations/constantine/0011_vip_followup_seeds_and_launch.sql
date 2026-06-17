-- 0011_vip_followup_seeds_and_launch.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Bağlam (2026-06-16 akşam):
--   VIP HTML Düzeltme campaign'ine (c1a44bcd) 2 seed test target eklenir +
--   campaign başlatılır. Mert şu an inbox'larında "boş mu doluymu" kontrol
--   yapacak — eğer doluyu görürse 17 gerçek VIP'ye de güven.
--
-- Seed'ler (her ikisi de "zz-seed-test" tag'li mevcut seed lead'ler):
--   1) mert@asttourism.com (Outlook M365 — sabah seed testi inbox'a düşmüştü)
--   2) ceketli@gmail.com   (Mert ana Gmail — render referansı)
--
-- Subject: "[Tekrar - TEST] ..." prefix (gerçek VIP'lerden ayırt edilebilsin)
-- Body: Fatih'in (myGO) gerçek apology + body_text örneği (uzun + bağlamlı)
--
-- Etkilenen veri:
--   campaign_targets : 2 INSERT (seed test'ler)
--   campaigns        : 1 UPDATE (status draft → running, started_at)
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── 1) 2 seed test target ekle (Fatih'in body_text + apology örneğini kopyala) ─
WITH fatih_template AS (
  SELECT subject_override, body_text_override
  FROM campaign_targets ct
  JOIN leads l ON ct.lead_id = l.id
  JOIN campaigns c ON ct.campaign_id = c.id
  WHERE c.id = 'c1a44bcd-7fef-4d98-84a6-c1df694b1af1'
    AND l.primary_contact_email = 'fatih@mygo.pro'
  LIMIT 1
)
INSERT INTO campaign_targets (
  campaign_id, lead_id, status, sequence_step,
  subject_override, body_text_override
)
SELECT
  'c1a44bcd-7fef-4d98-84a6-c1df694b1af1',
  l.id,
  'queued'::campaign_target_status,
  0,
  replace((SELECT subject_override FROM fatih_template), '[Tekrar]', '[Tekrar - TEST]'),
  (SELECT body_text_override FROM fatih_template)
FROM leads l
WHERE l.primary_contact_email IN ('mert@asttourism.com', 'ceketli@gmail.com')
  AND 'zz-seed-test' = ANY(l.tags);

-- ─── 2) Campaign'i başlat — draft → running ─────────────────────────────────
UPDATE campaigns SET
  status   = 'running',
  started_at = now()
WHERE id = 'c1a44bcd-7fef-4d98-84a6-c1df694b1af1'
  AND status = 'draft';

-- ─── 3) Validation ──────────────────────────────────────────────────────────
DO $$
DECLARE
  v_target_cnt   int;
  v_seed_cnt     int;
  v_status       text;
BEGIN
  SELECT COUNT(*) INTO v_target_cnt FROM campaign_targets
    WHERE campaign_id = 'c1a44bcd-7fef-4d98-84a6-c1df694b1af1';
  SELECT COUNT(*) INTO v_seed_cnt FROM campaign_targets ct
    JOIN leads l ON ct.lead_id = l.id
    WHERE ct.campaign_id = 'c1a44bcd-7fef-4d98-84a6-c1df694b1af1'
      AND l.primary_contact_email IN ('mert@asttourism.com', 'ceketli@gmail.com');
  SELECT status::text INTO v_status FROM campaigns
    WHERE id = 'c1a44bcd-7fef-4d98-84a6-c1df694b1af1';

  RAISE NOTICE 'Total target: % (17 VIP + 2 seed = 19)', v_target_cnt;
  RAISE NOTICE 'Seed test target: %/2', v_seed_cnt;
  RAISE NOTICE 'Status: %', v_status;

  IF v_target_cnt <> 19 THEN
    RAISE EXCEPTION 'Toplam target 19 olmalı, % bulundu', v_target_cnt;
  END IF;
  IF v_seed_cnt <> 2 THEN
    RAISE EXCEPTION 'Seed target 2 olmalı, % bulundu', v_seed_cnt;
  END IF;
  IF v_status <> 'running' THEN
    RAISE EXCEPTION 'Status running olmalı, % bulundu', v_status;
  END IF;
END $$;

COMMIT;
