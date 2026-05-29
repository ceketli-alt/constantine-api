-- 0004_followup_idempotency_index.sql
-- Feature #54 follow-up sequence — idempotency index'i adım-bazlı yap.
--
-- SORUN: 0001'deki UNIQUE (campaign_id, to_email) WHERE campaign_id IS NOT NULL
-- index'i, aynı kampanyada aynı alıcıya 2. maili (takip) FİZİKSEL olarak engeller
-- (unique violation). Takip sequence'i bu yüzden insert edemez.
--
-- ÇÖZÜM: index'e sequence_step ekle → her (campaign, recipient, step) için tek kayıt.
-- İlk mail (step 0) hâlâ tekil; step 1/2/... takipleri serbest. Ad-hoc (campaign_id
-- NULL) gönderimler etkilenmez (partial index koşulu aynı).
--
-- GÜVENLİ: email_messages şu an 0 satır (henüz kampanya göndermedi) — rebuild anlık,
-- mevcut idempotency garantisi için veri kaybı/çakışma riski yok.

BEGIN;

DROP INDEX IF EXISTS email_messages_campaign_idempotent_idx;

CREATE UNIQUE INDEX IF NOT EXISTS email_messages_campaign_idempotent_idx
  ON email_messages (campaign_id, to_email, sequence_step)
  WHERE campaign_id IS NOT NULL;

COMMENT ON INDEX email_messages_campaign_idempotent_idx IS
  'Idempotency guard (adım-bazlı): (campaign_id, to_email, sequence_step) için tek kayıt. 0001 + #54 follow-up sequence.';

COMMIT;
