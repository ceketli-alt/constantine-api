-- 2026-06-11 — D3: v_campaign_metrics + auto_deals_count
--
-- Faz B otomasyonu açtığı pipeline kartlarını campaign başına say.
-- Source: activity_events.event_type='deal_auto_created' (metadata.campaign_id).
--
-- Kolon eklediğimiz için CREATE OR REPLACE çalışmaz (kolon adı/order değişiyor),
-- DROP + CREATE pattern. Tüm bağımlı index/sub-view yok, güvenli.

BEGIN;

DROP VIEW IF EXISTS v_campaign_metrics;

CREATE VIEW v_campaign_metrics AS
SELECT
  c.id, c.name, c.description, c.channel, c.status, c.template_id,
  c.sender_email, c.sender_pool, c.daily_cap, c.scheduled_at,
  c.started_at, c.completed_at, c.created_at, c.target_count,
  c.ab_test_enabled, c.ab_winner_variant, c.ab_winning_metric,
  c.warmup_enabled, c.min_gap_seconds, c.random_gap_seconds,
  c.send_window_start, c.send_window_end, c.send_days,
  c.cron_paused,
  -- target funnel
  COALESCE(t.queued_count, 0)     AS queued_count,
  COALESCE(t.sent_count, 0)       AS sent_count,
  COALESCE(t.failed_count, 0)     AS failed_count,
  COALESCE(t.opted_out_count, 0)  AS opted_out_count,
  COALESCE(t.replied_count, 0)    AS replied_count,
  COALESCE(t.total_targets, 0)    AS total_targets,
  -- email engagement
  COALESCE(m.delivered_count, 0)  AS delivered_count,
  COALESCE(m.opened_count, 0)     AS opened_count,
  COALESCE(m.clicked_count, 0)    AS clicked_count,
  COALESCE(m.bounced_count, 0)    AS bounced_count,
  -- warmup
  COALESCE(w.sent_today, 0)       AS sent_today,
  w.current_cap,
  w.warmup_day,
  w.paused_until,
  w.paused_reason,
  w.bounce_count_24h,
  w.complaint_count_24h,
  u.next_send_at,
  -- D3 — auto-deal sayacı: reply-classify Faz B otomatik açtığı pipeline kartları
  COALESCE(d.auto_deals_count, 0) AS auto_deals_count,
  COALESCE(d.auto_deals_skipped_low_conf, 0) AS auto_deals_skipped_low_conf,
  -- türetilmiş oranlar
  ROUND(100.0 * COALESCE(m.opened_count, 0)  / NULLIF(m.delivered_count, 0), 1) AS open_rate,
  ROUND(100.0 * COALESCE(t.replied_count, 0) / NULLIF(t.sent_count, 0), 1)      AS reply_rate,
  ROUND(100.0 * COALESCE(m.bounced_count, 0) / NULLIF(m.delivered_count + m.bounced_count, 0), 1) AS bounce_rate,
  -- Reply başına auto-deal yüzdesi (kalite metriği): "geldi & 'hot' confidence eşiği geçen" oranı
  ROUND(100.0 * COALESCE(d.auto_deals_count, 0) / NULLIF(t.replied_count, 0), 1) AS auto_deal_rate
FROM campaigns c
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE status = 'queued')       AS queued_count,
    COUNT(*) FILTER (WHERE status = 'sent')         AS sent_count,
    COUNT(*) FILTER (WHERE status = 'failed')       AS failed_count,
    COUNT(*) FILTER (WHERE status = 'opted_out')    AS opted_out_count,
    COUNT(*) FILTER (WHERE status = 'replied')      AS replied_count,
    COUNT(*)                                        AS total_targets
  FROM campaign_targets WHERE campaign_id = c.id
) t ON true
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered_count,
    COUNT(*) FILTER (WHERE opened_at    IS NOT NULL) AS opened_count,
    COUNT(*) FILTER (WHERE clicked_at   IS NOT NULL) AS clicked_count,
    COUNT(*) FILTER (WHERE bounced_at   IS NOT NULL) AS bounced_count
  FROM email_messages WHERE campaign_id = c.id AND direction = 'outbound'
) m ON true
LEFT JOIN campaign_warmup_state w ON w.campaign_id = c.id
LEFT JOIN LATERAL (
  SELECT MIN(scheduled_at) AS next_send_at
  FROM campaign_targets
  WHERE campaign_id = c.id AND status = 'queued' AND scheduled_at IS NOT NULL
) u ON true
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE event_type = 'deal_auto_created')               AS auto_deals_count,
    COUNT(*) FILTER (WHERE event_type = 'deal_auto_skipped_low_confidence') AS auto_deals_skipped_low_conf
  FROM activity_events
  WHERE (metadata ->> 'campaign_id')::uuid = c.id
    AND event_type IN ('deal_auto_created', 'deal_auto_skipped_low_confidence')
) d ON true;

COMMENT ON VIEW v_campaign_metrics IS
  'Kampanya başına tek satırda funnel + engagement + warmup + next_send_at + auto-deal sayaçları. FE liste + detay sayfası bu view''e bakar.';

COMMIT;
