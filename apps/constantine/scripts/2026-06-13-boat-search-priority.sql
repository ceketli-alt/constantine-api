-- 2026-06-13 — Partner Filo v3.2 (Akıllı Hızlı Arama): tekne sonuç önceliği
-- Hızlı arama sonuçlarında hangi teknenin üstte görüneceğini belirler.
-- Yüksek = üstte. Mert direktifi: CONSTANTINE flagship öne çıkar.
-- Idempotent.

BEGIN;

ALTER TABLE boats
  ADD COLUMN IF NOT EXISTS search_priority integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN boats.search_priority IS
  'Hızlı arama sonuç sıralaması; yüksek=üstte (flagship öne çıkar). v3.2.';

-- CONSTANTINE flagship öne çıksın (Mert isteği)
UPDATE boats SET search_priority = 100
  WHERE id = '222a10f8-6d66-41ec-9162-198d26d84cde';

COMMIT;
