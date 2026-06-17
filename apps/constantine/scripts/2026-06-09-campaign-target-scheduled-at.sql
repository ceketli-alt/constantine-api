-- 2026-06-09 — campaign_targets.scheduled_at
--
-- Per-target earliest send time. Worker only sends queued targets where
-- scheduled_at IS NULL OR scheduled_at <= now(); ORDER BY COALESCE(scheduled_at, created_at).
--
-- Kullanım: VIP batch'lerde lead başına elden zaman ataması gerektiğinde
-- (Agent Day 2026-06-04 follow-up — 19 mail 10-12 Haz arası 30 dk aralıkla).
-- Boş bırakılırsa worker eski davranışta (FIFO, throttle aralığıyla) gönderir.

ALTER TABLE campaign_targets
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

CREATE INDEX IF NOT EXISTS campaign_targets_scheduled_at_idx
  ON campaign_targets (campaign_id, scheduled_at)
  WHERE status = 'queued';

COMMENT ON COLUMN campaign_targets.scheduled_at IS
  'Optional per-target earliest send time. Worker only sends queued targets where scheduled_at IS NULL OR scheduled_at <= now(); ORDER BY COALESCE(scheduled_at, created_at). Used by VIP batches with hand-picked time slots (Agent Day 2026-06-04 follow-up — 19 mail across 10-12 Jun).';
