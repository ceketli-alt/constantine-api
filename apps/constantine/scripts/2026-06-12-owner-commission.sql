-- 2026-06-12 — Partner Filo v1.2: tekne sahibi anlaşma komisyonu (%)
-- Sadece kayıt/görünürlük — hesaplaşma (settlement/ledger) üyelik fazında gelecek.
-- Idempotent.

BEGIN;

ALTER TABLE boat_owners
  ADD COLUMN IF NOT EXISTS commission_pct numeric(5,2)
  CHECK (commission_pct IS NULL OR (commission_pct >= 0 AND commission_pct <= 100));

COMMENT ON COLUMN boat_owners.commission_pct IS 'Anlaşılan Constantine komisyon yüzdesi (örn. 15.00). NULL = henüz anlaşılmadı. v1: sadece kayıt, otomatik hesap yok.';

COMMIT;
