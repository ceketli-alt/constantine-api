-- 2026-10-08 — Eşleşmeyen gelen mailler kaybolmasın.
-- Eskiden cevap toplayıcı leadi bulamadığı maili yalnızca console.log'a yazıp ATIYORDU.
-- Artık (Instantly warmup trafiği hariç) buraya düşer; günlük özet "eşleşmeyen gelen: N" gösterir.
CREATE TABLE IF NOT EXISTS inbound_unmatched (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at       timestamptz NOT NULL DEFAULT now(),
  from_email        text NOT NULL,
  from_name         text,
  to_email          text,
  subject           text,
  body_snippet      text,
  message_id_header text,
  in_reply_to       text,
  source            text,
  reviewed_at       timestamptz,           -- bir insan bakınca doldurulur
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- IMAP yeniden yoklamasında aynı mesaj iki kez yazılmasın (NULL'lar birbirini engellemez).
CREATE UNIQUE INDEX IF NOT EXISTS inbound_unmatched_msgid_uq
  ON inbound_unmatched (message_id_header) WHERE message_id_header IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbound_unmatched_unreviewed_idx
  ON inbound_unmatched (received_at DESC) WHERE reviewed_at IS NULL;
