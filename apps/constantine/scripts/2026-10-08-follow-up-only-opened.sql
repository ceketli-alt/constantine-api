-- 2026-10-08 — Takip mailini yalnızca maili AÇANLARA gönderme seçeneği.
-- Açmayan biri muhtemelen maili görmüyor (spam/filtre); ona ikinci mail atmak itibarı yakar.
-- Varsayılan KAPALI. Açmak Mert'in açık onayına bağlı (Haziran 2026 takip-maili korkuluğu).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS follow_up_only_opened boolean NOT NULL DEFAULT false;
