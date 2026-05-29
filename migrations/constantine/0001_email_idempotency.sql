-- ============================================================
-- Migration: Email send idempotency
-- Tarih: 2026-05-23
-- Amaç: Aynı kampanyada aynı alıcıya iki gönderim engellensin.
--        email-send endpoint'i bu index'i dependency olarak kullanır.
--
-- partial unique index: (campaign_id, to_email) çiftinin sadece
-- campaign_id NOT NULL olduğunda unique olması.
-- Ad-hoc send'ler (campaign_id NULL) etkilenmez.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS email_messages_campaign_idempotent_idx
  ON email_messages (campaign_id, to_email)
  WHERE campaign_id IS NOT NULL;

COMMENT ON INDEX email_messages_campaign_idempotent_idx IS
  'Idempotency guard: aynı campaign_id + to_email kombinasyonu için sadece bir email_messages kaydı. Faz 1 — Aziz Claude (2026-05-23).';
