-- Settlement (Hesaplaşma) modülü — CONSTANTINE teknesi için
-- 2026-05-31
--
-- 1. profiles: ortak payı oranı + erişim bayrağı
-- 2. partner_transactions: ortak ↔ sanal kasa para hareketleri
-- 3. Seed: Mert %40, Hasan %30, Caner %30, Caner = şirket kasası, Serhat view-only

BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS settlement_share_pct numeric(5,2),
  ADD COLUMN IF NOT EXISTS settlement_view_access boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS partner_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES profiles(id),
  kind text NOT NULL CHECK (kind IN (
    'profit_share_payout',
    'expense_reimbursement',
    'cash_in',
    'cash_out'
  )),
  amount_try numeric(14,2) NOT NULL CHECK (amount_try >= 0),
  occurred_at date NOT NULL,
  note text,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_tx_partner_date_idx
  ON partner_transactions(partner_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS partner_tx_kind_idx
  ON partner_transactions(kind);

UPDATE profiles SET settlement_share_pct = 40, settlement_view_access = true
  WHERE id = '07fb3763-e2ce-4fde-ae29-398b586cdd6f';  -- Mert
UPDATE profiles SET settlement_share_pct = 30, settlement_view_access = true
  WHERE id = '910ef3f9-c2e2-458f-a9b6-640191e599c8';  -- Hasan
UPDATE profiles SET settlement_share_pct = 30, settlement_view_access = true
  WHERE id = 'da35626e-4fb6-4515-81be-777e2ea66b49';  -- Caner (şirket kasası)
UPDATE profiles SET settlement_view_access = true
  WHERE id = 'e7713ff7-37a1-41cc-b48f-aa3fed056cd6';  -- Serhat (view-only)

COMMIT;
