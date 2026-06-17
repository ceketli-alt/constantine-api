-- 2026-06-13 — Partner Filo v3 (CC white-label katalog): talep atıfı
-- CC storefront'taki bir OTEL reseller'ı (/h/:slug) üzerinden gelen yat talepleri
-- Constantine'e tek "Concierge Connect" acentesi olarak düşer. Hangi otelin
-- yönlendirdiğini Mert'in inbox'ında görebilmek + ileride komisyon paylaşımı için
-- talebin kaynak reseller'ını (otel adı) saklarız.
-- NULL = doğrudan talep (acente portalı veya CC global /yachts). Uzunluk app-side
-- 120 ile sınırlanır. Idempotent.

BEGIN;

ALTER TABLE agency_requests
  ADD COLUMN IF NOT EXISTS source_reseller text;

COMMENT ON COLUMN agency_requests.source_reseller IS
  'CC white-label: talebi yönlendiren otel/reseller görünen adı (örn. "Hotel Daphne"). NULL = doğrudan. v3.';

COMMIT;
