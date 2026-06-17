-- 2026-06-10 — v_campaign_metrics view
--
-- Kampanya başına TEK SATIR'da tüm sayaçlar + oranlar + warmup durumu + next_send_at.
-- FE liste sayfası (sales.constantineyachts.com/campaigns) N+1'i kaldırdı — eskiden her
-- satır için 2 ekstra COUNT atılıyordu; artık tek SELECT yeter.
--
-- Tasarım:
--   - LATERAL'lar campaign_targets ve email_messages'tan tek tarama ile FILTER agg üretir.
--   - campaign_warmup_state LEFT JOIN — warmup kapalıysa kolonlar NULL.
--   - next_send_at: queued + scheduled_at NOT NULL satırların minimum'u (scheduled_at sistemi
--     2026-06-09'da eklendi, VIP per-target zamanlama için).
--   - open_rate/reply_rate/bounce_rate: NULLIF ile sıfır bölmeyi NULL'a çevir → FE "—" gösterir.
--   - Ham view (materialized değil); şu an ~10-20 kampanya için yeterli. 50+ olursa MATERIALIZED'a
--     çevrilebilir + cron refresh.

CREATE OR REPLACE VIEW v_campaign_metrics AS
SELECT
  c.id, c.name, c.description, c.channel, c.status, c.template_id,
  c.sender_email, c.sender_pool, c.daily_cap, c.scheduled_at,
  c.started_at, c.completed_at, c.created_at, c.target_count,
  c.ab_test_enabled, c.ab_winner_variant, c.ab_winning_metric,
  c.warmup_enabled, c.min_gap_seconds, c.random_gap_seconds,
  c.send_window_start, c.send_window_end, c.send_days,
  c.cron_paused,
  -- target funnel (campaign_targets tek tarama)
  COALESCE(t.queued_count, 0)     AS queued_count,
  COALESCE(t.sent_count, 0)       AS sent_count,
  COALESCE(t.failed_count, 0)     AS failed_count,
  COALESCE(t.opted_out_count, 0)  AS opted_out_count,
  COALESCE(t.replied_count, 0)    AS replied_count,
  -- gerçek hedef sayısı: campaign_targets'ın tüm status toplamı.
  -- campaigns.target_count create-time intent'i; suppress/dedupe sonrası gerçek hedef bu.
  COALESCE(t.total_targets, 0)    AS total_targets,
  -- email engagement (email_messages outbound tek tarama)
  COALESCE(m.delivered_count, 0)  AS delivered_count,
  COALESCE(m.opened_count, 0)     AS opened_count,
  COALESCE(m.clicked_count, 0)    AS clicked_count,
  COALESCE(m.bounced_count, 0)    AS bounced_count,
  -- bugün gönderim + sıradaki schedule
  COALESCE(w.sent_today, 0)       AS sent_today,
  w.current_cap,
  w.warmup_day,
  w.paused_until,
  w.paused_reason,
  w.bounce_count_24h,
  w.complaint_count_24h,
  u.next_send_at,
  -- türetilmiş oranlar (NULLIF böleni 0 olduğunda NULL döner; FE "—" gösterir)
  ROUND(100.0 * COALESCE(m.opened_count, 0)  / NULLIF(m.delivered_count, 0), 1) AS open_rate,
  ROUND(100.0 * COALESCE(t.replied_count, 0) / NULLIF(t.sent_count, 0), 1)      AS reply_rate,
  ROUND(100.0 * COALESCE(m.bounced_count, 0) / NULLIF(m.delivered_count + m.bounced_count, 0), 1) AS bounce_rate
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
) u ON true;

COMMENT ON VIEW v_campaign_metrics IS
  'Kampanya başına tek satırda funnel + engagement + warmup + next_send_at. FE liste sayfası N+1 yerine bu view''e bakar. Detail sayfası (CampaignDetail.tsx) da ana metrik kaynağı olarak kullanır.';
