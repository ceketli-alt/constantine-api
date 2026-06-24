-- 2026-06-23 — sync partner kanalı
-- Gelen partner (sync_origin='partner', ör. Simon) rezervasyonları otomatik bu kanala etiketlenir.
-- Onaylar ekranında + raporlamada kanal "Simon" görünür; onaydan sonra tur detayları girilir.
-- Tekne-bazlı: her boat kendi partner kanalını taşır (Tuana/Crystal sonra farklı olabilir).

ALTER TABLE boats ADD COLUMN IF NOT EXISTS sync_partner_channel_id uuid REFERENCES channels(id) ON DELETE SET NULL;
COMMENT ON COLUMN boats.sync_partner_channel_id IS 'Gelen partner (sync_origin=partner) rezervasyonlarının otomatik etiketleneceği kanal (ör. Simon).';

-- Constantine → mevcut "Simon" kanalı
UPDATE boats SET sync_partner_channel_id = '79a9c9fb-3e6a-4c85-b4ed-26b6e8b4e282'
WHERE id = '222a10f8-6d66-41ec-9162-198d26d84cde' AND sync_partner_channel_id IS NULL;
