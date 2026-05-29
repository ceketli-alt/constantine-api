-- 0005_sender_pool.sql
-- Feature #56 — Multi-inbox (sender) rotation.
--
-- Kampanya tek bir sender_email yerine birden çok gönderici adres kullanabilir.
-- Worker, lead_id hash'ine göre STICKY dağıtım yapar: bir lead'in tüm sequence'i
-- (ilk + takipler) HEP aynı adresten gider → thread/reply tutarlılığı korunur,
-- yük adresler arasında dengeli paylaşılır → tek inbox reputation'ı yorulmaz.
--
-- sender_pool boş [] → eski davranış (tek sender_email). Cold outreach adresleri
-- outreach Resend hesabında (constantineyachts.online root verified) → @cy.online
-- local-part'lar (outreach@, mert@) API'den gönderilebilir.

BEGIN;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS sender_pool jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN campaigns.sender_pool IS
  'Gönderici adres havuzu (jsonb string[]). Boş = tek sender_email. Worker lead_id hash ile sticky rotasyon yapar.';

COMMIT;
