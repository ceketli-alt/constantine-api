// rewrite-dmc-initial.mjs — DMC ilk mailini dert-odaklı + sade + WhatsApp linkli yeniden yaz.
// 18 spintax açılış bloğu KORUNUR (mevcut body_text'ten çekilir). Yabancı kelimeler atılır.
// Değer: "anlık müsaitlik — kaptan kaptan aramaya son". Mert onayı 2026-05-31.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import postgres from 'postgres';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'), override: true });

const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const NAME = 'outreach_initial_agency_dmc_tr';

const cur = (await sql`SELECT body_text FROM email_templates WHERE name=${NAME}`)[0];
if (!cur) { console.error('template yok'); process.exit(1); }

// Mevcut 18 varyant spintax bloğunu çek (ilk pipe-içeren { } grubu)
const m = cur.body_text.match(/\{[^{}]*\|[^{}]*\}/);
if (!m) { console.error('spintax açılış bloğu bulunamadı'); process.exit(1); }
const OPENER = m[0];
console.log('Açılış varyant sayısı:', OPENER.split('|').length);

// ---- YENİ DÜZ METİN (text_only ilk mail bunu kullanır) ----
const body_text = `Merhabalar,

${OPENER}

Misafirlerinize Boğaz turu ayarlarken en çok vakit kaybettiren şey, müsait tekne bulmak için kaptan kaptan aramak oluyor. Constantine'de bunu tek ekrana indirdik: hangi tekne hangi tarihte boş, anında görüyorsunuz.

Size özel acente panelinizde:
- Tüm teknelerin canlı müsaitliği, tek ekranda
- Her teknenin altında size özel acente fiyatı (kur seçenekli)
- Tek tıkla rezervasyon talebi, dakikalar içinde teyit

Kısa bir görüşmede panelinizi birlikte açıp deneyebiliriz. Dilerseniz WhatsApp'tan da yazabilirsiniz: {{rep_whatsapp_url}}

Panelinizi şuradan inceleyebilirsiniz: {{agency_panel_url}}

Saygılarımla,
{{rep_name}}
Constantine Yachts
{{rep_phone}}`;

// ---- YENİ HTML (text_only kapanırsa / tutarlılık için) ----
const body_html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">
<p>Merhabalar,</p>
<p>${OPENER}</p>
<p>Misafirlerinize Boğaz turu ayarlarken en çok vakit kaybettiren şey, müsait tekne bulmak için kaptan kaptan aramak oluyor. Constantine'de bunu tek ekrana indirdik: hangi tekne hangi tarihte boş, anında görüyorsunuz.</p>
<p>Size özel acente panelinizde:</p>
<ul>
<li>Tüm teknelerin canlı müsaitliği, tek ekranda</li>
<li>Her teknenin altında size özel acente fiyatı (kur seçenekli)</li>
<li>Tek tıkla rezervasyon talebi, dakikalar içinde teyit</li>
</ul>
<p>Kısa bir görüşmede panelinizi birlikte açıp deneyebiliriz. Dilerseniz WhatsApp'tan da yazabilirsiniz: <a href="{{rep_whatsapp_url}}">{{rep_phone}}</a></p>
<p><a href="{{agency_panel_url}}">Acente panelinizi buradan inceleyin →</a></p>
<p>Saygılarımla,<br>{{rep_name}}<br>Constantine Yachts<br>{{rep_phone}}</p>
</div>`;

// Subject de sadeleşsin (eski "dmc rate sheet" → Türkçe, değer-odaklı)
const subject = 'Boğaz tekneleri için acente paneliniz';

await sql`UPDATE email_templates SET subject=${subject}, body_text=${body_text}, body_html=${body_html}, updated_at=now() WHERE name=${NAME}`;

// Doğrulama
const after = (await sql`SELECT subject, body_text, body_html FROM email_templates WHERE name=${NAME}`)[0];
const txtVar = (after.body_text.match(/\{[^{}]*\|[^{}]*\}/)?.[0].split('|').length) ?? 0;
const htmlVar = (after.body_html.match(/\{[^{}]*\|[^{}]*\}/)?.[0].split('|').length) ?? 0;
console.log('YENİ subject:', after.subject);
console.log('text spintax varyant:', txtVar, '| html spintax varyant:', htmlVar);
console.log('rep_whatsapp_url text:', after.body_text.includes('{{rep_whatsapp_url}}'), '| html:', after.body_html.includes('{{rep_whatsapp_url}}'));
console.log('yabancı kelime kaldı mı (rate sheet/booking/matris/invoice):',
  /rate sheet|booking|matris|invoice|multi-currency/i.test(after.body_text));
console.log('kelime sayısı (açılış hariç kabaca):', after.body_text.split(/\s+/).length);
await sql.end();
