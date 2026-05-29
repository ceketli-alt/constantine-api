-- 0003_followup_sequence.sql
-- Feature #54 — Follow-up sequence automation.
--
-- Bir kampanya artık ilk maile ek olarak, reply gelmezse N gün sonra otomatik
-- takip mailleri (step 2, 3, ...) gönderebilir. Reply rate 2-3x.
--
-- Model:
--   campaigns.follow_up_steps  jsonb  — sıralı [{template_id, delay_days}, ...]
--     (step index 0 = ilk takip; delay_days = bir ÖNCEKİ gönderimden sonra kaç gün)
--   campaign_targets.sequence_step      — bu hedefe gönderilen takip sayısı (0 = sadece ilk mail)
--   campaign_targets.next_followup_at    — sıradaki takibin vakti (NULL = bekleyen takip yok)
--   email_messages.sequence_step         — gönderimin hangi adım olduğu (idempotency + analytics)
--
-- next_followup_at ilk değeri trigger ile set edilir (hedef 'sent' olunca). Böylece
-- HEM frontend immediate-batch HEM backend worker yolundan tutarlı çalışır. Worker
-- sonraki adımları ilerletir; inbound reply geldiğinde sequence durdurulur.

BEGIN;

-- ─── Schema ───────────────────────────────────────────────────────────────
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS follow_up_steps jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE campaign_targets
  ADD COLUMN IF NOT EXISTS sequence_step int NOT NULL DEFAULT 0;
ALTER TABLE campaign_targets
  ADD COLUMN IF NOT EXISTS next_followup_at timestamptz;

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS sequence_step int NOT NULL DEFAULT 0;

COMMENT ON COLUMN campaigns.follow_up_steps IS
  'Sıralı takip adımları: [{"template_id":"uuid","delay_days":3}, ...]. Boş = takip yok.';
COMMENT ON COLUMN campaign_targets.sequence_step IS
  'Bu hedefe gönderilen takip sayısı. 0 = sadece ilk mail gitti.';
COMMENT ON COLUMN campaign_targets.next_followup_at IS
  'Sıradaki takip gönderim zamanı. NULL = bekleyen takip yok (bitti / reply / opt-out).';

-- Worker due-followup taraması için partial index
CREATE INDEX IF NOT EXISTS idx_campaign_targets_followup
  ON campaign_targets (campaign_id, next_followup_at)
  WHERE status = 'sent' AND next_followup_at IS NOT NULL;

-- ─── Trigger: ilk takibi zamanla ────────────────────────────────────────────
-- Hedef ilk kez 'sent' olduğunda (sequence_step=0), kampanyada takip adımı varsa
-- next_followup_at'i ilk adımın delay_days'i kadar ileri kur.
CREATE OR REPLACE FUNCTION fn_schedule_first_followup() RETURNS trigger AS $$
DECLARE
  steps jsonb;
  first_delay int;
BEGIN
  IF NEW.status = 'sent' AND NEW.sequence_step = 0 AND NEW.next_followup_at IS NULL THEN
    SELECT follow_up_steps INTO steps FROM campaigns WHERE id = NEW.campaign_id;
    IF steps IS NOT NULL AND jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) > 0 THEN
      first_delay := GREATEST(COALESCE((steps->0->>'delay_days')::int, 3), 0);
      NEW.next_followup_at := now() + make_interval(days => first_delay);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_schedule_first_followup ON campaign_targets;
CREATE TRIGGER trg_schedule_first_followup
  BEFORE INSERT OR UPDATE OF status ON campaign_targets
  FOR EACH ROW EXECUTE FUNCTION fn_schedule_first_followup();

COMMIT;
