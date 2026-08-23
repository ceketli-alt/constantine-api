-- Kampanya isleme onceligi.
-- Worker kampanyalari SIRAYLA isliyor ve her birinden BATCH_SIZE kadar gonderiyor;
-- gonderim arasi 15-22 dk oldugu icin ilk siradaki kampanya gunun kapasitesinin
-- cogunu yiyor. Onceden sira `started_at`e gore idi => en ESKI kampanya birinci
-- olup en DUSUK kaliteli kitleye oncelik veriyordu. Bu kolon sirayi acikca kurar.
-- Kucuk sayi = once islenir.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 100;
COMMENT ON COLUMN campaigns.priority IS 'Worker isleme onceligi; kucuk once. Varsayilan 100.';

-- Dogrulanmis kurumsal Istanbul acenteleri once
UPDATE campaigns SET priority = 10 WHERE id = 'cf291a24-25e5-4b68-98a4-6a621f425513';
-- Kurumsal Phase 1C ikinci
UPDATE campaigns SET priority = 20 WHERE id = '018f99ba-cea8-4a1b-9bab-466801f5810f';
-- Gmail Canary (trust-low kitle, artik mesaj testi) en son, artan kapasiteyle
UPDATE campaigns SET priority = 90 WHERE id = '577169eb-d3d3-45e6-9d1e-4c6844b4e6d6';
