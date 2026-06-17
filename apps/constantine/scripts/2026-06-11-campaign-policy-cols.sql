-- 2026-06-11 — Campaign-level enrollment & pipeline policy columns
-- Faz A1 (Sales Otomasyon planı): cooldown + reply otomasyon flag'leri
--
-- Idempotent: IF NOT EXISTS ile defalarca apply edilebilir.

BEGIN;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS cooldown_days INTEGER NOT NULL DEFAULT 30;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS respect_global_cooldown BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS auto_create_deal_on_hot_reply BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN campaigns.cooldown_days IS
  'Bir lead son N gün içinde mail aldıysa bu kampanyaya enroll edilmez. respect_global_cooldown=true iken aktif.';

COMMENT ON COLUMN campaigns.respect_global_cooldown IS
  'true: eligible_leads_for_campaign cooldown filtresini uygular. false: cooldown yok sayılır.';

COMMENT ON COLUMN campaigns.auto_create_deal_on_hot_reply IS
  'true: reply-classify hot temperature set ettiğinde deals tablosuna kart açar. false: sadece temperature güncellenir.';

COMMIT;
