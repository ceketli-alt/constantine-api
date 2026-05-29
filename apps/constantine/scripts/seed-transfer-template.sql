-- seg-transfer için outreach template: transfer/VIP ulaşım → Boğaz yat turu cross-sell + komisyon partner
-- Idempotent: ON CONFLICT (name) DO UPDATE

INSERT INTO email_templates (
  name, display_name, subject, body_html, body_text,
  subject_b, body_html_b, body_text_b, variant_split_pct,
  variables, category, is_active, created_by
) VALUES (
  'outreach_initial_agency_transfer_tr',
  'Acente - Transfer/VIP Ulaşım (TR)',
  'transfer misafirlerinize boğaz turu',
  $body_html$<p>Merhaba {{primary_contact_name}},</p>

<p>Nasılsınız? İstanbul'da transfer ve VIP ulaşım tarafında yoğun bir sezon geçirdiğinizi tahmin ediyorum.</p>

<p>{{company_name}}'nın misafir profilini düşününce bir fırsat dikkatimizi çekti: havalimanı ve otel transferi için size gelen yabancı misafirlerin çoğu İstanbul'da birkaç gün kalıyor ve sıklıkla "Boğaz'da özel ne yapabiliriz?" diye soruyor. Constantine olarak tam burada devreye giriyoruz — transfer misafirinize Boğaz özel yat turu öneriyorsunuz, operasyonun tamamını biz üstleniyoruz, komisyonunuz her rezervasyonda net hattınızda kalıyor.</p>

<p>Pratikte şöyle işliyor: misafiriniz yat turu istediğinde Constantine'in online portalı üzerinden teknelerin anlık müsaitliğini görüyorsunuz, rezervasyonu birkaç dakikada teyit ediyoruz. Transfer + Boğaz turunu tek elden sunmuş oluyorsunuz, ek operasyonel yük yok. Multi-currency fatura (USD/EUR/GBP) destekli.</p>

<p>Bu modeli birkaç VIP ulaşım firmasıyla koşuyoruz; misafir başına 2-4 kişilik özel tur, sezon boyunca düzenli akış sağlıyor.</p>

<p>{{company_name}} için komisyon yapısını ve canlı müsaitlik portalını paylaşmamı ister misiniz? {{rep_phone}} numaramıza WhatsApp mesajınız yeterli — uygun bir saatte konuşalım.</p>

<p>Filomuz ve canlı müsaitlik şurada: <a href="{{agency_panel_url}}">{{agency_panel_url}}</a><br><small>(rezervasyon talebi gönderirseniz birkaç dakika içinde teyit ediyoruz)</small></p>

<p>Saygılarımla,<br/>
{{rep_name}}<br/>
Constantine Yachts<br/>
{{rep_phone}}</p>$body_html$,
  $body_text$Merhaba {{primary_contact_name}},

Nasılsınız? İstanbul'da transfer ve VIP ulaşım tarafında yoğun bir sezon geçirdiğinizi tahmin ediyorum.

{{company_name}}'nın misafir profilini düşününce bir fırsat dikkatimizi çekti: havalimanı ve otel transferi için size gelen yabancı misafirlerin çoğu İstanbul'da birkaç gün kalıyor ve sıklıkla "Boğaz'da özel ne yapabiliriz?" diye soruyor. Constantine olarak tam burada devreye giriyoruz — transfer misafirinize Boğaz özel yat turu öneriyorsunuz, operasyonun tamamını biz üstleniyoruz, komisyonunuz her rezervasyonda net hattınızda kalıyor.

Pratikte şöyle işliyor: misafiriniz yat turu istediğinde Constantine'in online portalı üzerinden teknelerin anlık müsaitliğini görüyorsunuz, rezervasyonu birkaç dakikada teyit ediyoruz. Transfer + Boğaz turunu tek elden sunmuş oluyorsunuz, ek operasyonel yük yok. Multi-currency fatura (USD/EUR/GBP) destekli.

Bu modeli birkaç VIP ulaşım firmasıyla koşuyoruz; misafir başına 2-4 kişilik özel tur, sezon boyunca düzenli akış sağlıyor.

{{company_name}} için komisyon yapısını ve canlı müsaitlik portalını paylaşmamı ister misiniz? {{rep_phone}} numaramıza WhatsApp mesajınız yeterli — uygun bir saatte konuşalım.

Filomuz ve canlı müsaitlik şurada: {{agency_panel_url}}
(rezervasyon talebi gönderirseniz birkaç dakika içinde teyit ediyoruz)

Saygılarımla,
{{rep_name}}
Constantine Yachts
{{rep_phone}}$body_text$,
  'ek komisyon hattı — boğaz yat turu',
  $body_html_b$<p>Merhaba {{primary_contact_name}},</p>

<p>{{company_name}}'a gelen transfer misafirlerinin çoğu İstanbul'da birkaç gün kalıyor. Onlara Boğaz özel yat turu önerin — operasyonu biz yapalım, komisyonunuz her rezervasyonda net kalsın.</p>

<p>Online portalımızdan anlık müsaitliği görüp birkaç dakikada rezervasyon teyit ediyorsunuz. Ek operasyonel yük yok, multi-currency fatura (USD/EUR/GBP) destekli.</p>

<p>Komisyon yapısını paylaşmamı ister misiniz? WhatsApp: {{rep_phone}}</p>

<p>Müsaitlik portalı: <a href="{{agency_panel_url}}">{{agency_panel_url}}</a></p>

<p>Saygılarımla,<br/>
{{rep_name}}<br/>
Constantine Yachts</p>$body_html_b$,
  $body_text_b$Merhaba {{primary_contact_name}},

{{company_name}}'a gelen transfer misafirlerinin çoğu İstanbul'da birkaç gün kalıyor. Onlara Boğaz özel yat turu önerin — operasyonu biz yapalım, komisyonunuz her rezervasyonda net kalsın.

Online portalımızdan anlık müsaitliği görüp birkaç dakikada rezervasyon teyit ediyorsunuz. Ek operasyonel yük yok, multi-currency fatura (USD/EUR/GBP) destekli.

Komisyon yapısını paylaşmamı ister misiniz? WhatsApp: {{rep_phone}}

Müsaitlik portalı: {{agency_panel_url}}

Saygılarımla,
{{rep_name}}
Constantine Yachts$body_text_b$,
  50,
  '["primary_contact_name","company_name","rep_name","rep_phone","agency_panel_url"]'::jsonb,
  'outreach',
  true,
  '07fb3763-e2ce-4fde-ae29-398b586cdd6f'
)
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  subject = EXCLUDED.subject,
  body_html = EXCLUDED.body_html,
  body_text = EXCLUDED.body_text,
  subject_b = EXCLUDED.subject_b,
  body_html_b = EXCLUDED.body_html_b,
  body_text_b = EXCLUDED.body_text_b,
  variant_split_pct = EXCLUDED.variant_split_pct,
  variables = EXCLUDED.variables,
  updated_at = now();
