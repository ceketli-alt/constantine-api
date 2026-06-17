// Tek seferlik — Aziz'e Mailcow test görev maili (transactional Resend, send.cy.com).
// Cold outreach domain'i KULLANILMAZ (warmup hacmi korunur).
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'), override: true });

const KEY = process.env.RESEND_API_KEY_TRANSACTIONAL || process.env.RESEND_API_KEY || '';
if (!KEY) { console.error('Transactional Resend key yok'); process.exit(1); }

const TO = 'derincea@gmail.com';
const FROM = 'Mert Ödemiş <mert@send.constantineyachts.com>';
const REPLY_TO = 'ceketli@gmail.com';
const SUBJECT = 'Constantine cold outreach — senden tek iş kaldı (Mailcow testi)';

const text = `Selam Aziz,

Constantine cold outreach 9 Haziran'da başlıyor. Resend ve DNS tarafını kontrol ettik, hepsi hazır — senden tek bir şey kaldı.

MAILCOW KUTU TESTİ — outreach@ ve mert@constantineyachts.online kutuları çalışıyor mu?

1) https://mail.constantineyachts.online → admin girişi
2) İki kutu da (outreach@constantineyachts.online + mert@constantineyachts.online) aktif mi bak
3) Webmail'den her ikisine de bir test maili at-al → geliyor mu?

(Sebep: müşteri yanıtlarını sistem bu iki kutudan otomatik okuyacak, IMAP'in ayakta olması şart.)

Bunu 7 Haziran akşamına kadar teyit edebilirsen 9 Haz'a tamamız.

NOT: Resend tarafını kontrol ettik, ikisi de zaten tamamdı — sende iş yok:
- Domain constantineyachts.online -> verified, sending açık
- Open + click tracking -> zaten kapalı (Resend varsayılanı)
- DNS (SPF/DKIM/DMARC/MX/PTR) -> hepsi çalışıyor

Opsiyonel/sonra (acil değil): DMARC'ı ~2 hafta sonra p=quarantine'e çekmek, IYS başvurusu.

Teşekkürler,
Mert`;

const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a">
<p>Selam Aziz,</p>
<p>Constantine cold outreach <b>9 Haziran'da</b> başlıyor. Resend ve DNS tarafını kontrol ettik, hepsi hazır — <b>senden tek bir şey kaldı.</b></p>
<p><b>📬 Mailcow kutu testi</b> — <code>outreach@</code> ve <code>mert@constantineyachts.online</code> kutuları çalışıyor mu?</p>
<ol>
<li><a href="https://mail.constantineyachts.online">mail.constantineyachts.online</a> → admin girişi</li>
<li>İki kutu da (<code>outreach@constantineyachts.online</code> + <code>mert@constantineyachts.online</code>) aktif mi bak</li>
<li>Webmail'den her ikisine de bir test maili at-al → geliyor mu?</li>
</ol>
<p style="color:#555">(Sebep: müşteri yanıtlarını sistem bu iki kutudan otomatik okuyacak, IMAP'in ayakta olması şart.)</p>
<p>Bunu <b>7 Haziran akşamına</b> kadar teyit edebilirsen 9 Haz'a tamamız 👍</p>
<hr style="border:none;border-top:1px solid #eee;margin:18px 0">
<p style="color:#555"><b>Not:</b> Resend tarafını kontrol ettik, ikisi de zaten tamamdı — sende iş yok:</p>
<ul style="color:#555">
<li>Domain <code>constantineyachts.online</code> → ✅ verified, sending açık</li>
<li>Open + click tracking → ✅ zaten kapalı (Resend varsayılanı)</li>
<li>DNS (SPF/DKIM/DMARC/MX/PTR) → ✅ hepsi çalışıyor</li>
</ul>
<p style="color:#888;font-size:13px">Opsiyonel/sonra (acil değil): DMARC'ı ~2 hafta sonra <code>p=quarantine</code>'e çekmek, IYS başvurusu.</p>
<p>Teşekkürler,<br>Mert</p>
</div>`;

const resp = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: FROM, to: [TO], reply_to: REPLY_TO, subject: SUBJECT, text, html }),
});
const data = await resp.json();
console.log('HTTP', resp.status);
console.log(JSON.stringify(data, null, 2));
