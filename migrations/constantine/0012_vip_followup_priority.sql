-- 0012_vip_followup_priority.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Bağlam (2026-06-17): VIP HTML follow-up campaign'inde Mert seed'leri (mert@asttourism +
-- ceketli@gmail) önce gönderilsin → kontrol → onaylanmazsa gerçek 17 VIP'i kurtaralım.
-- Worker `ORDER BY COALESCE(scheduled_at, created_at)` — seed'lerin scheduled_at NULL
-- kalır (hemen gönderim), gerçek VIP'lere now()+1h scheduled_at atanır.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

UPDATE campaign_targets
SET scheduled_at = now() + interval '1 hour'
WHERE campaign_id = 'c1a44bcd-7fef-4d98-84a6-c1df694b1af1'
  AND lead_id NOT IN (
    SELECT id FROM leads
    WHERE primary_contact_email IN ('mert@asttourism.com', 'ceketli@gmail.com')
  );

DO $$
DECLARE v_priority int; v_delayed int;
BEGIN
  SELECT COUNT(*) INTO v_priority FROM campaign_targets ct
    JOIN leads l ON ct.lead_id = l.id
    WHERE ct.campaign_id = 'c1a44bcd-7fef-4d98-84a6-c1df694b1af1'
      AND ct.scheduled_at IS NULL
      AND l.primary_contact_email IN ('mert@asttourism.com', 'ceketli@gmail.com');
  SELECT COUNT(*) INTO v_delayed FROM campaign_targets
    WHERE campaign_id = 'c1a44bcd-7fef-4d98-84a6-c1df694b1af1'
      AND scheduled_at IS NOT NULL;
  RAISE NOTICE 'Priority seed (hemen): %/2', v_priority;
  RAISE NOTICE 'Delayed VIP (1 saat sonra): %/17', v_delayed;
  IF v_priority <> 2 THEN RAISE EXCEPTION 'Priority 2 olmalı, %', v_priority; END IF;
  IF v_delayed <> 17 THEN RAISE EXCEPTION 'Delayed 17 olmalı, %', v_delayed; END IF;
END $$;

COMMIT;
