-- 2026-06-11 — D1: Auto-deal confidence threshold
-- reply-classify hot reply'da Claude'un confidence'ı bu eşiği geçmezse deal AÇILMAZ.
-- Default 0.7 (yüksek). Kampanya bazında düşürülebilir (örn. 0.5) veya 1.01 ile efektif olarak kapatılabilir.

BEGIN;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS auto_deal_min_confidence NUMERIC(3, 2) NOT NULL DEFAULT 0.70
    CHECK (auto_deal_min_confidence >= 0 AND auto_deal_min_confidence <= 1);

COMMENT ON COLUMN campaigns.auto_deal_min_confidence IS
  'reply-classify hot reply auto-deal alt sınırı (0-1). Claude confidence < bu değer ise temperature güncellenir ama deal açılmaz.';

COMMIT;
