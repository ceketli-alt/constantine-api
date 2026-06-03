-- 0001_auth_recovery.sql
-- Concierge auth recovery flow için auth.users tablosuna gerekli kolonları ekler.
-- Supabase Cloud bağımlılığı kaldırılırken kendi /auth/v1/recover + /auth/v1/verify
-- endpoint'lerinin token saklayabilmesi gerekiyor.
-- 2026-05-26

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS recovery_token   TEXT,
  ADD COLUMN IF NOT EXISTS recovery_sent_at TIMESTAMPTZ;

-- Token lookup için partial index (sadece aktif recovery'lerde dolu olur,
-- consume sonrası NULL'a çekildiği için tablo büyüse bile küçük kalır)
CREATE INDEX IF NOT EXISTS users_recovery_token_idx
  ON auth.users (recovery_token)
  WHERE recovery_token IS NOT NULL;
