-- 0007 — Faz 2: A/B kazanan metrik seçimi (Instantly "Choose winning metric" muadili)
-- 'auto' (default, mevcut davranış: reply≥3 → reply, yoksa open) | 'reply' | 'open'.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ab_winning_metric text NOT NULL DEFAULT 'auto';
