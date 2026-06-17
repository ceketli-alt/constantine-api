-- 2026-06-10 — email_messages campaign engagement partial index
--
-- v_campaign_metrics'in m LATERAL'ı `WHERE campaign_id = X AND direction = 'outbound'`
-- ardından FILTER agg yapıyor. Mevcut `email_messages_sent_at_idx` outbound DESC ama
-- campaign_id'ye filtre değil — kampanya başına agg için optimal değil.
--
-- Bu partial index sadece outbound satırları (toplam yarısı) campaign_id ile getirir;
-- view 10-20 kampanya × ~100-200 outbound her biri için sub-ms aggrega eder.
--
-- email_events için ek index gerekmiyor: mevcut (message_id) + (occurred_at DESC) + (event_type)
-- Timeline tab'ı için yeterli (message_id IN (...) sorgusu hızlı).

CREATE INDEX IF NOT EXISTS email_messages_campaign_outbound_idx
  ON email_messages (campaign_id)
  WHERE direction = 'outbound' AND campaign_id IS NOT NULL;
