-- Settlement modülü sadeleştirme — Caner = sıradan ortak (kasa kavramı kaldırıldı)
-- 2026-05-31
--
-- partner_transactions: payer_id → payee_id, sade ortak-ortak transfer modeli.
-- Eski tablo boştu, kayıp yok.

BEGIN;

DROP TABLE IF EXISTS partner_transactions;

CREATE TABLE partner_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id uuid NOT NULL REFERENCES profiles(id),   -- ödeyen
  payee_id uuid NOT NULL REFERENCES profiles(id),   -- alan
  amount_try numeric(14,2) NOT NULL CHECK (amount_try >= 0),
  occurred_at date NOT NULL,
  note text,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payer_id != payee_id)
);
CREATE INDEX partner_tx_payer_idx ON partner_transactions(payer_id, occurred_at DESC);
CREATE INDEX partner_tx_payee_idx ON partner_transactions(payee_id, occurred_at DESC);

COMMIT;
