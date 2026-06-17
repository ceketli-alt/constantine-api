-- 0009_phase1_split_and_cleanup.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Bağlam (2026-06-15):
--
-- 1) VIP campaign (cc7f3817) 2 hard bounce → emre@holyturizm.com + huseyin@karadagturizm.com.tr
--    Sebep boş gelmiş ama paterni (aynı gece 1 saat arayla 2 mail) → typo şüphesi.
--    Mert kararı: tam DELETE (cascade ile thread/target/message temizlenir).
--
-- 2) 2026-06-15 seed test bulguları:
--    - mert@cy.online → 7/7 INBOX (VIP engagement geçmişi var, Gmail güveniyor)
--    - outreach@cy.online → Gmail'lerde SPAM (sender history sıfır, ham)
--    Karar: Phase 1'i splitle. %78 mert@ ana sender + %22 outreach@ "az az" ile
--    sender reputation gerçek alıcılarla birikir.
--
-- 3) Throttle 20-30 dk arası (önceki 15-20 dk yerine): min_gap=1200, random_gap=600
--    Sebep: insansı pacing + reputation koruması (volume burst signal yumuşar).
--
-- 4) Launch: 16 Haz Sal 10:00 TR (her iki Phase aynı anda)
--    Status='draft' kalır — Mert manuel onayla status='running' yapar.
--
-- Etkilenen veri:
--   leads               : 2 satır DELETE (VIP bounce'lar)
--   email_threads       : cascade DELETE (2 thread)
--   email_messages      : cascade DELETE (2 mail kaydı)
--   campaign_targets    : cascade DELETE + Phase 1 → 1A (100) + 1B (28) split
--   campaigns           : Phase 1A UPDATE (rename+config) + Phase 1B INSERT (clone)
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── Block 1: VIP 2 bounce lead'i sil ───────────────────────────────────────
DELETE FROM leads
WHERE id IN (
  'b0ed6390-f83f-4f26-91f8-9cf74ac9dac9',  -- Holy Turizm / Emre Kutlu / emre@holyturizm.com
  '3e81d04a-020e-4f0a-8926-73264db2f912'   -- Karadağ Turizm / Hüseyin Karadağ / huseyin@karadagturizm.com.tr
);

-- ─── Block 2: Phase 1B kampanyası (outreach@ az az) — Phase 1'den clone ─────
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
  'DMC Phase 1B — outreach@ az az (16 Haz)',
  'Phase 1 split: %22 outreach@constantineyachts.online sender ile az az gönderim. '
    || 'Sebep: 2026-06-15 seed test → outreach@ Gmail spam (sender history sıfır). '
    || 'Bu kampanya outreach@ reputation''ı gerçek alıcılarla birikecek. '
    || 'Daily cap=1 başlangıç, Mert manuel ramp''e karar verir.',
  'draft'::campaign_status,
  segment_filter, template_id,
  send_window_start, send_window_end, send_days,
  '2026-06-16 10:00:00+03'::timestamptz,
  NULL, NULL, created_by, now(),
  channel,
  'outreach@constantineyachts.online',                       -- override: outreach sender
  NULL,
  1,                                                          -- daily_cap=1 (yavaş ramp)
  warmup_enabled, ab_test_enabled, NULL, false,
  NULL, follow_up_steps,
  '["outreach@constantineyachts.online"]'::jsonb,            -- sender_pool: tek eleman
  1200,                                                       -- min_gap=20 dk
  600,                                                        -- random_gap=0-10 dk
  max_new_leads_per_day,
  prioritize_new_leads, send_text_only, first_email_text_only,
  max_per_company_per_day, stop_company_on_reply, ab_winning_metric
FROM campaigns
WHERE id = '60987729-ef6d-4919-b002-2b4c8ec4cf85';

-- ─── Block 3: 28 lead'i Phase 1B'ye taşı (deterministic hash-based seçim) ───
-- md5(lead_id::text) hash sıralaması → reproducible random, audit'lenebilir.
WITH phase1b_id AS (
  SELECT id FROM campaigns
  WHERE name = 'DMC Phase 1B — outreach@ az az (16 Haz)'
  ORDER BY created_at DESC LIMIT 1
),
selected AS (
  SELECT lead_id FROM campaign_targets
  WHERE campaign_id = '60987729-ef6d-4919-b002-2b4c8ec4cf85'
    AND status = 'queued'
  ORDER BY md5(lead_id::text)
  LIMIT 28
)
INSERT INTO campaign_targets (campaign_id, lead_id, status, sequence_step)
SELECT (SELECT id FROM phase1b_id), s.lead_id, 'queued'::campaign_target_status, 0
FROM selected s;

-- Aynı 28 lead'i Phase 1A'dan (eski Phase 1) sil
DELETE FROM campaign_targets
WHERE campaign_id = '60987729-ef6d-4919-b002-2b4c8ec4cf85'
  AND lead_id IN (
    SELECT lead_id FROM campaign_targets
    WHERE campaign_id = (
      SELECT id FROM campaigns
      WHERE name = 'DMC Phase 1B — outreach@ az az (16 Haz)'
      ORDER BY created_at DESC LIMIT 1
    )
  );

-- ─── Block 4: Phase 1A config güncelle (Phase 1 → 1A rename + mert@ tek sender) ─
UPDATE campaigns SET
  name = 'DMC Phase 1A — mert@ ana (16 Haz)',
  description = 'Phase 1 split: %78 mert@constantineyachts.online sender ile ana iş. '
    || 'Sebep: 2026-06-15 seed test → mert@ Gmail 7/7 INBOX (VIP engagement geçmişi). '
    || 'Daily cap=5 başlangıç, kademeli ramp: 19 Haz=8, 22 Haz=12, 26 Haz=18, 30 Haz=20. '
    || 'Mert manuel UI''dan cap günceller (reminder cron''dan tetiklenir).',
  sender_email = 'mert@constantineyachts.online',
  sender_pool = '["mert@constantineyachts.online"]'::jsonb,
  daily_cap = 5,                                              -- başlangıç düşük
  min_gap_seconds = 1200,                                     -- 20 dk
  random_gap_seconds = 600,                                   -- 0-10 dk extra
  scheduled_at = '2026-06-16 10:00:00+03'::timestamptz
WHERE id = '60987729-ef6d-4919-b002-2b4c8ec4cf85';

-- ─── Block 5: Validation — invariant'lar tutmuyorsa rollback ────────────────
DO $$
DECLARE
  v_1a_count   int;
  v_1b_count   int;
  v_1b_id      uuid;
  v_vip_lead   int;
  v_vip_thread int;
  v_vip_msg    int;
BEGIN
  SELECT id INTO v_1b_id FROM campaigns
    WHERE name = 'DMC Phase 1B — outreach@ az az (16 Haz)'
    ORDER BY created_at DESC LIMIT 1;
  SELECT COUNT(*) INTO v_1a_count FROM campaign_targets
    WHERE campaign_id = '60987729-ef6d-4919-b002-2b4c8ec4cf85';
  SELECT COUNT(*) INTO v_1b_count FROM campaign_targets
    WHERE campaign_id = v_1b_id;

  -- Bounce lead'lerin temizliği
  SELECT COUNT(*) INTO v_vip_lead FROM leads
    WHERE id IN ('b0ed6390-f83f-4f26-91f8-9cf74ac9dac9',
                 '3e81d04a-020e-4f0a-8926-73264db2f912');
  SELECT COUNT(*) INTO v_vip_thread FROM email_threads
    WHERE lead_id IN ('b0ed6390-f83f-4f26-91f8-9cf74ac9dac9',
                      '3e81d04a-020e-4f0a-8926-73264db2f912');
  SELECT COUNT(*) INTO v_vip_msg FROM email_messages em
    JOIN email_threads et ON em.thread_id = et.id
    WHERE et.lead_id IN ('b0ed6390-f83f-4f26-91f8-9cf74ac9dac9',
                         '3e81d04a-020e-4f0a-8926-73264db2f912');

  RAISE NOTICE 'Phase 1A target (mert@ ana): %', v_1a_count;
  RAISE NOTICE 'Phase 1B target (outreach@ az az): %', v_1b_count;
  RAISE NOTICE 'Phase 1B campaign_id: %', v_1b_id;
  RAISE NOTICE 'Bounce lead/thread/msg (sıfır olmalı): % / % / %', v_vip_lead, v_vip_thread, v_vip_msg;

  IF v_1a_count + v_1b_count <> 128 THEN
    RAISE EXCEPTION 'Phase 1A+1B toplam 128 olmalı, % + % = % bulundu',
      v_1a_count, v_1b_count, v_1a_count + v_1b_count;
  END IF;
  IF v_1b_count <> 28 THEN
    RAISE EXCEPTION 'Phase 1B 28 olmalı, % bulundu', v_1b_count;
  END IF;
  IF v_1a_count <> 100 THEN
    RAISE EXCEPTION 'Phase 1A 100 olmalı, % bulundu', v_1a_count;
  END IF;
  IF v_vip_lead <> 0 THEN
    RAISE EXCEPTION 'Bounce lead silinmedi, % satır kaldı', v_vip_lead;
  END IF;
END $$;

COMMIT;
