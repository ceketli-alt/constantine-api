-- 2026-06-08 — Per-lead body/subject override on campaign_targets
--
-- Sebep: Agent Day 2026-06-04 follow-up için 19 kişiselleştirilmiş mail.
-- Mevcut sistem template-id bazlı; tek template ile 19 farklı body gönderilemez.
-- sendEmailCore zaten input.subject / input.body_text raw verisini kabul ediyor
-- (email-send.ts:347-360); template_id olmadan da gönderebiliyor.
-- Bu migration sadece per-target override sütunları açar; mevcut akış bozulmaz
-- (NULL override → eski davranış: template render).
--
-- Geri alma (rollback):
--   ALTER TABLE campaign_targets DROP COLUMN IF EXISTS subject_override;
--   ALTER TABLE campaign_targets DROP COLUMN IF EXISTS body_text_override;

BEGIN;

ALTER TABLE campaign_targets
  ADD COLUMN IF NOT EXISTS subject_override   TEXT NULL,
  ADD COLUMN IF NOT EXISTS body_text_override TEXT NULL;

COMMENT ON COLUMN campaign_targets.subject_override IS
  'Per-target subject override. Doluysa template subject yerine bu kullanılır. Agent Day 19-mail VIP follow-up için eklendi (2026-06-08).';
COMMENT ON COLUMN campaign_targets.body_text_override IS
  'Per-target body override (plain text). Doluysa template_id ignore edilir, bu raw body gönderilir. Agent Day 19-mail VIP follow-up için eklendi (2026-06-08).';

COMMIT;
