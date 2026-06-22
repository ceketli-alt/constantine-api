-- 2026-06-22 — Constantine çift-yön takvim senkronu (Simon entegrasyonu)
--
-- Ayrı, müşteri-verisi içermeyen "Booking Sync" takvimi üzerinden çift yön:
--   * CRM rezervasyonları → takvime detaysız "Dolu" all-day blok (sync_origin='crm')
--   * Simon'ın takvime yazdığı event'ler → CRM'e pending booking (sync_origin='partner')
-- Tekne-bazlı (per-boat) — şimdilik yalnız CONSTANTINE'de sync_enabled=true yapılacak;
-- Tuana/Crystal sonra sadece kendi sync takvimini provision edip paylaşınca devreye girer.
--
-- Tümü additive + idempotent (IF NOT EXISTS). Veri değişmez, yalnız kolon/index eklenir.

-- boats: tekne başına bir dedicated sync takvimi + paylaşım kaydı
ALTER TABLE boats ADD COLUMN IF NOT EXISTS sync_calendar_id   text;
ALTER TABLE boats ADD COLUMN IF NOT EXISTS sync_partner_email text;
ALTER TABLE boats ADD COLUMN IF NOT EXISTS sync_enabled       boolean NOT NULL DEFAULT false;
ALTER TABLE boats ADD COLUMN IF NOT EXISTS sync_last_run_at   timestamptz;

COMMENT ON COLUMN boats.sync_calendar_id   IS 'Dedicated "Booking Sync" Google takvim ID (partnerla paylaşılan; primary ops takviminden ayrı, PII içermez).';
COMMENT ON COLUMN boats.sync_partner_email IS 'Sync takviminin edit-paylaşıldığı dış partner Google hesabı (ör. Simon).';
COMMENT ON COLUMN boats.sync_enabled       IS 'Bu tekne için çift-yön sync cron aktif mi.';

-- bookings: sync takvimindeki event ↔ booking eşlemesi + köken
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sync_calendar_event_id text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sync_origin            text;

COMMENT ON COLUMN bookings.sync_calendar_event_id IS 'Sync takvimindeki ilişkili event ID (bizim pushladığımız "Dolu" blok ya da Simon''ın oluşturduğu event). google_event_id''den AYRI — o primary ops takvimi içindir.';
COMMENT ON COLUMN bookings.sync_origin            IS 'Sync kökeni: crm = CRM''den pushlanan dolu blok; partner = Simon''ın takvimden gelen rezervasyonu. NULL = sync dışı normal booking.';

-- sync_origin değer kısıtı (idempotent ekle)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_sync_origin_chk'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_sync_origin_chk
      CHECK (sync_origin IS NULL OR sync_origin IN ('crm','partner'));
  END IF;
END $$;

-- event_id ile hızlı arama (reconcile/withdraw taramaları)
CREATE INDEX IF NOT EXISTS idx_bookings_sync_event
  ON bookings (boat_id, sync_calendar_event_id)
  WHERE sync_calendar_event_id IS NOT NULL;
