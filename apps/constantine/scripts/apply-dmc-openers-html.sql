-- DMC açılış düzeltmesi — body_html senkronu (body_text ile aynı, 2026-05-30)
-- first_email_text_only=true olsa bile HTML stale kalmasın (takip/güvenlik).
BEGIN;

-- İLK MAİL
UPDATE email_templates SET body_html = replace(
  replace(body_html,
    $Q$<p>Merhaba {{primary_contact_name}},</p>$Q$,
    $Q$<p>Merhabalar,</p>$Q$),
  $Q$<p>Nasılsınız? Umarım sezon sizin için umut ettiğiniz gibi geçiyordur.</p>$Q$,
  $Q$<p>{İstanbul'a ağırladığınız grupların tur programlarına Boğaz'da özel bir yat deneyimi eklemek üzere sizinle iletişime geçiyoruz.|Misafirlerinize sunduğunuz İstanbul tur programlarına Boğaz'da özel bir yat deneyimi katma fikriyle yazıyoruz.|İstanbul tur programlarınıza Boğaz'da ayrıcalıklı bir yat deneyimi eklemenin yollarını paylaşmak isteriz.|Ağırladığınız grupların İstanbul programlarına Boğaz'da premium bir yat hizmeti eklemek üzere bir önerimizi paylaşmak isteriz.|Misafir gruplarınızın İstanbul tur programlarına Boğaz'da özel bir yat deneyimi katmayı sizinle değerlendirmek isteriz.}</p>$Q$)
WHERE name = 'outreach_initial_agency_dmc_tr';

-- 1. TAKİP (selamlama; html'de varsa)
UPDATE email_templates SET body_html = replace(body_html,
    $Q$<p>Merhaba {{primary_contact_name}},</p>$Q$,
    $Q$<p>Merhabalar,</p>$Q$)
WHERE name = 'follow_up_no_reply_day3';

-- 2. TAKİP (selamlama + klişe; html'de varsa)
UPDATE email_templates SET body_html = replace(
  replace(body_html,
    $Q$<p>Merhaba {{primary_contact_name}},</p>$Q$,
    $Q$<p>Merhabalar,</p>$Q$),
  $Q$<p>Nasılsınız? Umarım sezon sizin için umut ettiğiniz gibi geçiyordur.</p>$Q$,
  $Q$<p>{Umarım sezon hazırlıklarınız yolundadır.|Dilerim yoğun sezon temponuz yolunda gidiyordur.|Umarım işleriniz yolundadır.}</p>$Q$)
WHERE name = 'follow_up_agency_no_reply';

COMMIT;
