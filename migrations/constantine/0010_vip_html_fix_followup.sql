-- 0010_vip_html_fix_followup.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Bağlam (2026-06-16):
--   VIP campaign (cc7f3817) 17 mail gönderildi (10-12 Haz). Hepsinin body_text'i
--   doluyu (Mert'in özel Türkçe pitch'leri) ama body_html boş kaldı çünkü
--   2026-06-08 staging script'i sadece body_text_override doldurdu. Sonuç:
--   HTML render eden mail client'lar (Gmail/Outlook %95+) sadece footer gördü
--   (Constantine Yachts adresi + unsubscribe), Mert'in pitch'ini HİÇ görmediler.
--   Mert ekran görüntüsü ile doğruladı (Yeliz Hanım intratours Exchange + kendi Gmail).
--
-- Backend fix (email-send.ts): body_html boş + body_text dolu ise textToBasicHtml()
-- helper'ı body_text'i basic HTML'e otomatik çevirir (paragraph + br + linkify).
-- Test mail (vip-html-fix-test.mts → ceketli@gmail.com) ile fix kanıtlandı:
-- 612 char → 2949 char HTML, paragraph + Türkçe karakterler sağlam.
--
-- Bu migration: 17 VIP alıcısına apology + tekrar mail. Sender mert@cy.online
-- (VIP'tekiyle aynı, threading aynı kalır), subject '[Tekrar] ' prefix, body
-- başına apology preface eklenir. Worker artık (deploy edildi) body_text'ten
-- otomatik HTML üretir → bu sefer alıcılar tam içeriği görür.
--
-- Etkilenen veri:
--   campaigns          : 1 INSERT ("VIP HTML Düzeltme — Apology")
--   campaign_targets   : 17 INSERT (status='queued', override'lı)
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── 1) Yeni campaign — VIP config'inden clone, daily_cap=20 + throttle 15-20 dk ──
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
  'VIP HTML Düzeltme — Apology (16 Haz)',
  '17 VIP alıcısına apology + tekrar mail. Sebep: 2026-06-10/12 VIP launch''ında '
    || 'body_html boş kaldığı için HTML render eden client''ler sadece footer gördü. '
    || 'Backend email-send.ts fix''i 2026-06-16''da deploy edildi (textToBasicHtml '
    || 'helper''ı: body_html boşsa body_text''ten otomatik HTML üretir). '
    || 'Subject "[Tekrar] " prefix + body başına apology preface eklenir; orijinal '
    || 'body_text korunur. Sender mert@cy.online (threading aynı kalır).',
  'draft'::campaign_status,
  segment_filter, NULL,                                       -- template_id NULL (override kullanılır)
  send_window_start, send_window_end, send_days,
  '2026-06-16 10:00:00+03'::timestamptz,
  NULL, NULL, created_by, now(),
  channel,
  'mert@constantineyachts.online',                            -- sender override
  NULL,
  20,                                                          -- daily_cap=20 (bugün hepsi gider)
  warmup_enabled, ab_test_enabled, NULL, false,
  NULL, follow_up_steps,
  '["mert@constantineyachts.online"]'::jsonb,                 -- sender_pool: sadece mert@
  900,                                                         -- min_gap=15 dk
  300,                                                         -- random_gap=0-5 dk → toplam 15-20 dk
  max_new_leads_per_day,
  prioritize_new_leads, send_text_only, first_email_text_only,
  max_per_company_per_day, stop_company_on_reply, ab_winning_metric
FROM campaigns
WHERE id = 'cc7f3817-8dba-4436-ad70-cc1cf83bc46a';

-- ─── 2) 17 lead için campaign_target + override ekle ───────────────────────
WITH new_camp AS (
  SELECT id FROM campaigns
  WHERE name = 'VIP HTML Düzeltme — Apology (16 Haz)'
  ORDER BY created_at DESC LIMIT 1
),
src_vip AS (
  -- VIP campaign'in 17 sent mailini al; bounce'lar zaten silinmiş durumda
  SELECT em.subject AS old_subject,
         em.body_text AS old_body_text,
         em.to_email,
         et.lead_id
  FROM email_messages em
  JOIN email_threads et ON em.thread_id = et.id
  WHERE em.campaign_id = 'cc7f3817-8dba-4436-ad70-cc1cf83bc46a'
    AND em.bounced_at IS NULL
    AND em.subject NOT LIKE '[TEST FIX]%'              -- 2026-06-16 fallback test mailini hariç tut
    AND em.to_email <> 'ceketli@gmail.com'             -- seed inbox değil, gerçek VIP'ler
)
INSERT INTO campaign_targets (
  campaign_id, lead_id, status, sequence_step,
  subject_override, body_text_override
)
SELECT
  (SELECT id FROM new_camp),
  s.lead_id,
  'queued'::campaign_target_status,
  0,
  '[Tekrar] ' || s.old_subject,
  E'Merhaba,\n\n'
    || E'Geçen hafta size yazdığım mailde teknik bir HTML render hatası nedeniyle '
    || E'içerik düzgün görüntülenememiş — yalnızca imza kısmı görünmüş. '
    || E'Mailimi tekrar gönderiyorum, kusura bakmayın:\n\n'
    || E'---\n\n'
    || s.old_body_text
FROM src_vip s;

-- ─── 3) Validation ──────────────────────────────────────────────────────────
DO $$
DECLARE
  v_camp_id     uuid;
  v_target_cnt  int;
  v_sub_check   int;
  v_body_check  int;
BEGIN
  SELECT id INTO v_camp_id FROM campaigns
    WHERE name = 'VIP HTML Düzeltme — Apology (16 Haz)'
    ORDER BY created_at DESC LIMIT 1;
  SELECT COUNT(*) INTO v_target_cnt FROM campaign_targets WHERE campaign_id = v_camp_id;
  SELECT COUNT(*) INTO v_sub_check FROM campaign_targets
    WHERE campaign_id = v_camp_id AND subject_override LIKE '[Tekrar] %';
  SELECT COUNT(*) INTO v_body_check FROM campaign_targets
    WHERE campaign_id = v_camp_id AND body_text_override LIKE 'Merhaba,%';

  RAISE NOTICE 'VIP Follow-up campaign_id: %', v_camp_id;
  RAISE NOTICE 'Target count: %', v_target_cnt;
  RAISE NOTICE 'Subject ''[Tekrar] '' prefix: %/17', v_sub_check;
  RAISE NOTICE 'Body apology preface: %/17', v_body_check;

  IF v_target_cnt <> 17 THEN
    RAISE EXCEPTION 'Hedef sayı 17 olmalı, % bulundu', v_target_cnt;
  END IF;
  IF v_sub_check <> 17 OR v_body_check <> 17 THEN
    RAISE EXCEPTION 'Override yazımı eksik: subject %, body %', v_sub_check, v_body_check;
  END IF;
END $$;

COMMIT;
