-- Canary'yi yeniden devreye alma + mesaj testi.
-- Canary'nin ilk gorevi "yeni .online domainleri teslim ediyor mu" idi; cevap alindi
-- (689 gonderim / 653 teslim = %95). Yeni gorevi: UCUZ trafikte konu basligi testi.
-- Kazanan, degerli kurumsal listelere uygulanacak.

-- 1) B varyanti konu basligi — A "arac/panel" cercevesi, B "misafir talebi" cercevesi
UPDATE email_templates
SET subject_b = 'misafiriniz "Boğaz turu var mı" dediğinde'
WHERE id = '3a32c3a6-01c6-4d3c-a89d-2226e0df242b';

-- 2) Canary: A/B ac, hacmi 50'den 12'ye indir, yeniden calistir.
--    Oncelik 90 oldugu icin gunun kapasitesinden ARTAN'i kullanir; Istanbul ve
--    Phase 1C once islenir.
UPDATE campaigns
SET status = 'running',
    cron_paused = false,
    daily_cap = 12,
    max_new_leads_per_day = 12,
    ab_test_enabled = true
WHERE id = '577169eb-d3d3-45e6-9d1e-4c6844b4e6d6';

-- 3) Kuyruktaki hedeflere varyant ata (deterministik 50/50; hedef id'sinin hash'i)
UPDATE campaign_targets
SET variant = CASE WHEN (abs(hashtext(id::text)) % 2) = 0 THEN 'a' ELSE 'b' END
WHERE campaign_id = '577169eb-d3d3-45e6-9d1e-4c6844b4e6d6'
  AND status = 'queued'
  AND variant IS NULL;
