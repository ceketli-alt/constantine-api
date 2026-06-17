-- 2026-06-09 — VIP launch prep (Agent Day 2026-06-04 follow-up campaign)
--
-- 1) 17 mail: [Google Drive view-only link] → partner portal URL
-- 2) 18-19 (Hüseyin/Halil discovery): imzadan önce link satırı ekle
-- 3) 19 target: scheduled_at TR saatleri (10/06 12:00..14:30, 11/06 09:00..12:00, 12/06 09:00..11:30)
-- 4) Campaign config: throttle 0/0 (timing scheduled_at'tan), send_window 09:00-17:30
--
-- NOT: status='running' AYRI bir SQL ile (Mert'in launch komutu) çalışacak.

BEGIN;

-- (1) Placeholder REPLACE — sadece placeholder içerenler etkilenir (idempotent)
UPDATE campaign_targets
SET body_text_override = REPLACE(
  body_text_override,
  '[Google Drive view-only link]',
  'https://acente.constantineyachts.com/acente/genel'
)
WHERE campaign_id = 'cc7f3817-8dba-4436-ad70-cc1cf83bc46a'
  AND body_text_override LIKE '%[Google Drive view-only link]%';

-- (2) 18-19 discovery — imzadan önce ekstra satır (idempotent: zaten varsa skip)
UPDATE campaign_targets
SET body_text_override = REPLACE(
  body_text_override,
  E'Görüşmek üzere,',
  E'Bu arada — istediğiniz an inceleyebilmeniz için detaylı acente sunumumuz hazır:\nhttps://acente.constantineyachts.com/acente/genel\n\nGörüşmek üzere,'
)
WHERE id IN (
  '1e416cee-a5d0-4368-8466-e5db6c93b42f',  -- Hüseyin Karadağ
  '909b57eb-7239-48fe-a4f6-be061c77f8c6'   -- Halil Mercan
)
AND body_text_override NOT LIKE '%acente.constantineyachts.com%';

-- (3) scheduled_at — 19 target, TR saati (Europe/Istanbul, UTC+3)
--     Worker SEND_TZ=Europe/Istanbul ile çalışır; timestamptz olarak veriyoruz.

-- 10.06.2026 Çar — 12:00..14:30 (6 mail)
UPDATE campaign_targets SET scheduled_at = '2026-06-10 12:00:00+03' WHERE id = 'bb740665-aa60-46f8-a095-7bf4eb38a7a9'; -- Ghassan
UPDATE campaign_targets SET scheduled_at = '2026-06-10 12:30:00+03' WHERE id = 'cb3a12c4-53c4-4601-8aa0-b09e55045fbc'; -- Mustafa Devrim
UPDATE campaign_targets SET scheduled_at = '2026-06-10 13:00:00+03' WHERE id = '2fe2cf45-679b-4b7c-9a83-196dd16bba5d'; -- A. Esat
UPDATE campaign_targets SET scheduled_at = '2026-06-10 13:30:00+03' WHERE id = 'de80a00d-fc4a-48e2-a7d0-ee1bd8b67a5d'; -- Gül Taner
UPDATE campaign_targets SET scheduled_at = '2026-06-10 14:00:00+03' WHERE id = 'a40cf62f-a62b-42ec-9ac3-b3ac2c77b4a6'; -- Yeliz Çimen
UPDATE campaign_targets SET scheduled_at = '2026-06-10 14:30:00+03' WHERE id = '9825afce-8c7c-4a0f-a7e3-c9b5c8d3acb0'; -- Murat Kartal

-- 11.06.2026 Per — 09:00..12:00 (7 mail)
UPDATE campaign_targets SET scheduled_at = '2026-06-11 09:00:00+03' WHERE id = '9165e01a-10cf-412d-8e0a-5926c0373c58'; -- Gürkan Eliçin
UPDATE campaign_targets SET scheduled_at = '2026-06-11 09:30:00+03' WHERE id = 'd9f49b98-8d2a-4864-974b-2a6f2126ea07'; -- Fatih Alp
UPDATE campaign_targets SET scheduled_at = '2026-06-11 10:00:00+03' WHERE id = 'e5f5a297-0d80-4cc5-9edf-646931bc4ebc'; -- Atakan Güllecioğlu
UPDATE campaign_targets SET scheduled_at = '2026-06-11 10:30:00+03' WHERE id = '2b9a6047-1de8-41d9-8aaf-6f6560ff1938'; -- Yeşim Özalp
UPDATE campaign_targets SET scheduled_at = '2026-06-11 11:00:00+03' WHERE id = '83f0ee2d-4ec5-4cda-adb5-97eecf186ac0'; -- Kezban Çuhadar
UPDATE campaign_targets SET scheduled_at = '2026-06-11 11:30:00+03' WHERE id = 'c1c66aa3-b9a7-4875-bfaa-0099a0b03a30'; -- İsmail Hacıosman
UPDATE campaign_targets SET scheduled_at = '2026-06-11 12:00:00+03' WHERE id = 'e8211738-6fa4-4f37-8a47-7dbafbb0361a'; -- Fahri Açar

-- 12.06.2026 Cum — 09:00..11:30 (6 mail)
UPDATE campaign_targets SET scheduled_at = '2026-06-12 09:00:00+03' WHERE id = '9c3f7b60-a51e-4421-93f0-9912314a82d1'; -- Şansel Kavlakoğlu
UPDATE campaign_targets SET scheduled_at = '2026-06-12 09:30:00+03' WHERE id = '89246902-51ba-4dda-a142-22901ace27a9'; -- Adem Atilgan
UPDATE campaign_targets SET scheduled_at = '2026-06-12 10:00:00+03' WHERE id = '4c851887-2ac2-41be-ab2c-95894f9dc64d'; -- Emre Kutlu
UPDATE campaign_targets SET scheduled_at = '2026-06-12 10:30:00+03' WHERE id = '49770b05-300d-40fe-8385-dee1a96f2bd5'; -- Emre Gülaçtı
UPDATE campaign_targets SET scheduled_at = '2026-06-12 11:00:00+03' WHERE id = '1e416cee-a5d0-4368-8466-e5db6c93b42f'; -- Hüseyin Karadağ
UPDATE campaign_targets SET scheduled_at = '2026-06-12 11:30:00+03' WHERE id = '909b57eb-7239-48fe-a4f6-be061c77f8c6'; -- Halil Mercan

-- (4) Campaign config — timing artık scheduled_at'tan; gap'leri sıfırla, send_window'u 09:00'a indir
UPDATE campaigns
SET min_gap_seconds = 0,
    random_gap_seconds = 0,
    send_window_start = '09:00:00',
    send_window_end = '17:30:00'
WHERE id = 'cc7f3817-8dba-4436-ad70-cc1cf83bc46a';

COMMIT;
