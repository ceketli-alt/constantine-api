-- DMC kampanya açılış cümlesi düzeltmesi (2026-05-30, Mert direktifi)
-- 1) Boş isim bug'ı: "Merhaba {{primary_contact_name}}," → "Merhabalar," (3 template)
-- 2) Klişe "Nasılsınız? Umarım sezon..." → 5 kibar/resmi spintax varyantı (ilk mail)
--    + 3 kısa varyant (2. takip). Spintax {a|b|c} her gönderimde birini seçer (AI'sız, kontrollü).
-- NOT: dollar-quoting ($Q$...$Q$) → Türkçe apostrof (Boğaz'da, İstanbul'a) kaçış derdi yok.
-- NOT: replace() yalnız hedef cümleleri değiştirir, gövdenin geri kalanı AYNEN korunur.

BEGIN;

-- ── İLK MAİL: outreach_initial_agency_dmc_tr ──────────────────────────────
UPDATE email_templates SET body_text = replace(
  replace(body_text,
    $Q$Merhaba {{primary_contact_name}},$Q$,
    $Q$Merhabalar,$Q$),
  $Q$Nasılsınız? Umarım sezon sizin için umut ettiğiniz gibi geçiyordur.$Q$,
  $Q${İstanbul'a ağırladığınız grupların tur programlarına Boğaz'da özel bir yat deneyimi eklemek üzere sizinle iletişime geçiyoruz.|Misafirlerinize sunduğunuz İstanbul tur programlarına Boğaz'da özel bir yat deneyimi katma fikriyle yazıyoruz.|İstanbul tur programlarınıza Boğaz'da ayrıcalıklı bir yat deneyimi eklemenin yollarını paylaşmak isteriz.|Ağırladığınız grupların İstanbul programlarına Boğaz'da premium bir yat hizmeti eklemek üzere bir önerimizi paylaşmak isteriz.|Misafir gruplarınızın İstanbul tur programlarına Boğaz'da özel bir yat deneyimi katmayı sizinle değerlendirmek isteriz.}$Q$)
WHERE name = 'outreach_initial_agency_dmc_tr';

-- ── 1. TAKİP: follow_up_no_reply_day3 (sadece selamlama) ──────────────────
UPDATE email_templates SET body_text = replace(body_text,
    $Q$Merhaba {{primary_contact_name}},$Q$,
    $Q$Merhabalar,$Q$)
WHERE name = 'follow_up_no_reply_day3';

-- ── 2. TAKİP: follow_up_agency_no_reply (selamlama + klişe) ────────────────
UPDATE email_templates SET body_text = replace(
  replace(body_text,
    $Q$Merhaba {{primary_contact_name}},$Q$,
    $Q$Merhabalar,$Q$),
  $Q$Nasılsınız? Umarım sezon sizin için umut ettiğiniz gibi geçiyordur.$Q$,
  $Q${Umarım sezon hazırlıklarınız yolundadır.|Dilerim yoğun sezon temponuz yolunda gidiyordur.|Umarım işleriniz yolundadır.}$Q$)
WHERE name = 'follow_up_agency_no_reply';

COMMIT;
