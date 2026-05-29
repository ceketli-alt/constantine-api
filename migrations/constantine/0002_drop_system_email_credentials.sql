-- 0002_drop_system_email_credentials.sql
-- Created: 2026-05-24 (Faz 4 final cleanup)
--
-- system_email_credentials tablosu artık kullanılmıyor:
--   - daily-digest.ts Gmail OAuth'tan Resend'e geçti
--   - getSystemAccessToken() fn'i ve gmail.ts dosyası silindi
--   - Bu tabloya artık hiçbir kod INSERT/SELECT/UPDATE yapmıyor
--
-- Tablo schema (referans için):
--   CREATE TABLE system_email_credentials (
--     id TEXT PRIMARY KEY DEFAULT 'singleton',
--     email TEXT NOT NULL,
--     refresh_token TEXT NOT NULL,
--     access_token TEXT,
--     access_token_expires_at TIMESTAMPTZ,
--     created_at TIMESTAMPTZ DEFAULT NOW(),
--     updated_at TIMESTAMPTZ DEFAULT NOW()
--   );
--
-- Apply:
--   psql -U constantine_user -d constantine -f 0002_drop_system_email_credentials.sql
--
-- Rollback: yok — Gmail OAuth flow tamamen Resend'e taşındı, geri dönüş Resend
-- bağlantısını kesip Gmail OAuth flow'unu yeniden implement gerektirir.

BEGIN;

-- Önce row sayısını rapor et (audit trail için)
DO $$
DECLARE
  row_count INT;
BEGIN
  SELECT COUNT(*) INTO row_count FROM system_email_credentials;
  RAISE NOTICE 'system_email_credentials drop ediliyor — silinen row: %', row_count;
END $$;

DROP TABLE IF EXISTS system_email_credentials;

COMMIT;
