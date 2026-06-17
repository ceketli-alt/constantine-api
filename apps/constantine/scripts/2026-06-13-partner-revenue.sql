-- 2026-06-13 — Partner Filo v1.3: yönlendirilen partner taleplerinde gelir/komisyon kaydı
-- Partner tekneler (agency_only) booking üretmez → "forwarded" olur. Komisyon ekonomisi
-- yönlendirme anında buraya yazılır (beklenen gelir pipeline'ı). Tahsilat/ödendi takibi
-- üyelik fazındaki settlement'a bırakıldı — burada SADECE beklenen tutarlar.
-- Tümü nullable: yönlendirirken tutar bilinmiyorsa boş geçilebilir.
-- Idempotent.

BEGIN;

ALTER TABLE agency_requests
  ADD COLUMN IF NOT EXISTS sale_amount numeric(10,2) CHECK (sale_amount IS NULL OR sale_amount >= 0),
  ADD COLUMN IF NOT EXISTS sale_currency text CHECK (sale_currency IS NULL OR sale_currency IN ('TRY','EUR','USD')),
  ADD COLUMN IF NOT EXISTS commission_pct numeric(5,2) CHECK (commission_pct IS NULL OR (commission_pct >= 0 AND commission_pct <= 100)),
  ADD COLUMN IF NOT EXISTS commission_amount numeric(10,2) CHECK (commission_amount IS NULL OR commission_amount >= 0);

COMMENT ON COLUMN agency_requests.sale_amount IS 'Partner yönlendirmede anlaşılan satış tutarı (beklenen). v1.3.';
COMMENT ON COLUMN agency_requests.commission_pct IS 'Yönlendirme anında sahibin commission_pct snapshot''ı (sonradan owner değişse de kayıt sabit).';
COMMENT ON COLUMN agency_requests.commission_amount IS 'sale_amount × commission_pct / 100 — beklenen Constantine komisyonu.';

COMMIT;
