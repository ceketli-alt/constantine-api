-- 2026-06-12 — Partner Fleet: dış tekne sahipleri + fiyat tabloları + Google freeBusy dolu saatleri
-- White-label: acente tarafına owner bilgisi asla sızdırılmaz (agency-panel endpointleri owner alanı dönmez).
-- Idempotent: IF NOT EXISTS ile defalarca apply edilebilir.
-- Uygulama: psql -h localhost -U constantine_user -d constantine -f scripts/2026-06-12-partner-fleet.sql

BEGIN;

-- 1) Tekne sahipleri (partner tekneciler — CRM kullanıcısı DEĞİL, sadece kayıt)
CREATE TABLE IF NOT EXISTS boat_owners (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  phone       text,
  email       text,
  notes       text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE boats
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES boat_owners(id) ON DELETE SET NULL;

-- 2) Fiyat tablosu satırları (acente panelinde gösterilen NİHAİ satış fiyatı — komisyon dahil)
CREATE TABLE IF NOT EXISTS boat_pricing_rows (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boat_id             uuid NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  label               text NOT NULL,
  label_translations  jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_hours      numeric(4,2),
  price               numeric(10,2) NOT NULL CHECK (price >= 0),
  currency            text NOT NULL DEFAULT 'EUR' CHECK (currency IN ('TRY','EUR','USD')),
  unit                text NOT NULL DEFAULT 'per_boat' CHECK (unit IN ('per_boat','per_person')),
  sort_order          integer NOT NULL DEFAULT 0,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(label_translations) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_boat_pricing_rows_boat ON boat_pricing_rows(boat_id);

-- 3) Dolu saat cache'i (Google freeBusy senkronu; source=manual ileride elle blok için rezerve)
CREATE TABLE IF NOT EXISTS boat_busy_slots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boat_id          uuid NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  date             date NOT NULL,
  start_time       time NOT NULL,
  end_time         time NOT NULL,
  source           text NOT NULL DEFAULT 'google' CHECK (source IN ('google','manual')),
  google_event_id  text,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS idx_boat_busy_slots_boat_date ON boat_busy_slots(boat_id, date);

COMMENT ON TABLE boat_owners IS 'Partner tekne sahipleri — white-label filo; acente endpointlerine asla dönmez.';
COMMENT ON TABLE boat_pricing_rows IS 'Acente paneli fiyat tablosu — admin girer, NİHAİ satış fiyatı (komisyon dahil, v1''de komisyon alanı yok). Tekne başına tek para birimi kullanılması önerilir (min_price seçimi para birimi karışımında en düşük sayıyı alır).';
COMMENT ON TABLE boat_busy_slots IS 'Google freeBusy''den senkronlanan dolu saatler. source=google satırları her sync''te bugünden ileriye DELETE+INSERT ile yenilenir (boat başına tek transaction). source=manual ileride elle blok için rezerve.';
COMMENT ON COLUMN boat_busy_slots.google_event_id IS 'freeBusy event id döndürmez — v1''de hep NULL; ileride events-bazlı sync için rezerve.';

COMMIT;
