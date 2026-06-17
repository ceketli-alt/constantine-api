-- 2026-06-10 — Faz 3 analytics view'ları
--
-- Performance tab'ı için 3 zenginleştirme:
--   - v_campaign_ab_stats: A/B varyant başına sent/opened/replied (campaign-worker.ts:143-156
--     ile aynı agg mantığı; ab-winner.ts kazananı zaten campaigns.ab_winner_variant'a yazıyor).
--   - v_campaign_daily: son 30g günlük breakdown (sparkline + per-day tablo).
--   - v_campaign_sender_stats: sender pool varsa gönderici adresi başına agg.

CREATE OR REPLACE VIEW v_campaign_ab_stats AS
SELECT
  ct.campaign_id,
  ct.variant,
  COUNT(*) FILTER (WHERE ct.status IN ('sent', 'replied'))::int AS sent,
  COUNT(*) FILTER (WHERE ct.status = 'replied')::int            AS replied,
  COUNT(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM email_messages em
    JOIN email_threads et ON et.id = em.thread_id
    WHERE em.campaign_id = ct.campaign_id
      AND et.lead_id = ct.lead_id
      AND em.direction = 'outbound'
      AND em.opened_at IS NOT NULL
  ))::int AS opened
FROM campaign_targets ct
WHERE ct.variant IN ('a', 'b')
GROUP BY ct.campaign_id, ct.variant;

COMMENT ON VIEW v_campaign_ab_stats IS
  'A/B varyant başına sent/opened/replied. campaign-worker.ts ab-winner agregesinin FE eşdeğeri.';

CREATE OR REPLACE VIEW v_campaign_daily AS
SELECT
  campaign_id,
  date_trunc('day', sent_at AT TIME ZONE 'Europe/Istanbul')::date AS day,
  COUNT(*)                                              ::int AS sent,
  COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)      ::int AS delivered,
  COUNT(*) FILTER (WHERE opened_at IS NOT NULL)         ::int AS opened,
  COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)        ::int AS clicked,
  COUNT(*) FILTER (WHERE bounced_at IS NOT NULL)        ::int AS bounced,
  COUNT(*) FILTER (WHERE replied_at IS NOT NULL)        ::int AS replied
FROM email_messages
WHERE campaign_id IS NOT NULL
  AND direction = 'outbound'
  AND sent_at IS NOT NULL
  AND sent_at >= (now() - interval '30 days')
GROUP BY campaign_id, date_trunc('day', sent_at AT TIME ZONE 'Europe/Istanbul');

COMMENT ON VIEW v_campaign_daily IS
  'Kampanya × gün × engagement metrikleri (son 30g, TR günü). Sparkline (7g) ve Performans tab per-day tablosu (14g) bu view''den FE-side filter ile gelir.';

CREATE OR REPLACE VIEW v_campaign_sender_stats AS
SELECT
  campaign_id,
  from_email,
  COUNT(*)                                              ::int AS sent,
  COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)      ::int AS delivered,
  COUNT(*) FILTER (WHERE opened_at IS NOT NULL)         ::int AS opened,
  COUNT(*) FILTER (WHERE bounced_at IS NOT NULL)        ::int AS bounced
FROM email_messages
WHERE campaign_id IS NOT NULL
  AND direction = 'outbound'
  AND sent_at IS NOT NULL
GROUP BY campaign_id, from_email;

COMMENT ON VIEW v_campaign_sender_stats IS
  'Sender pool varsa gönderici adresi başına sent/opened/bounced. Deliverability sorunlu adresleri tespit etmek için.';
