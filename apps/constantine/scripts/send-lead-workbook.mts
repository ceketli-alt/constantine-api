/**
 * Lead datasi Excel'ini Mert'e ek dosya olarak yollar.
 * Amac: Gmail'de ekin uzerindeki "Drive'a kaydet" ile tek tikla klasore girsin
 * (Drive MCP 1.2 MB'lik dosyayi yukleyemiyor, icerigi konusmadan gecirmesi gerekiyor).
 *
 * Calistirma:
 *   cd /var/www/api/apps/constantine
 *   pnpm exec tsx --env-file=.env scripts/send-lead-workbook.mts
 */
import fs from 'node:fs';
import { mailProvider } from '../src/mail/index.js';

const TO = 'ceketli@gmail.com';
const FROM = 'ops@send.constantineyachts.com';
const FILE = '/root/acente-data-2026-08/Constantine-Lead-Datasi-2026-08-16.xlsx';

const buf = fs.readFileSync(FILE);
console.log(`ek: ${(buf.length / 1024 / 1024).toFixed(2)} MB`);

const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;max-width:640px">
  <h2 style="color:#1F3864;margin:0 0 4px">Constantine — Lead Datası</h2>
  <p style="color:#6b7280;margin:0 0 20px;font-size:13px">16 Ağustos 2026 tarihli tam kopya</p>

  <p>Ekteki Excel dosyasında CRM'deki tüm veri var. Gmail'de ekin üzerine gelip
  <b>Drive'a kaydet</b> düğmesine basarsan doğrudan klasöre girer, indirmene gerek kalmaz.</p>

  <table style="border-collapse:collapse;width:100%;margin:20px 0;font-size:14px">
    <tr style="background:#1F3864;color:#fff">
      <th style="padding:8px 10px;text-align:left">Sayfa</th>
      <th style="padding:8px 10px;text-align:right">Kayıt</th>
    </tr>
    <tr><td style="padding:7px 10px;border-bottom:1px solid #e5e7eb">Tüm Leadler</td><td style="padding:7px 10px;text-align:right;border-bottom:1px solid #e5e7eb">6.046</td></tr>
    <tr style="background:#f7f8fa"><td style="padding:7px 10px;border-bottom:1px solid #e5e7eb">İstanbul</td><td style="padding:7px 10px;text-align:right;border-bottom:1px solid #e5e7eb">6.007</td></tr>
    <tr><td style="padding:7px 10px;border-bottom:1px solid #e5e7eb">Outreach Geçmişi</td><td style="padding:7px 10px;text-align:right;border-bottom:1px solid #e5e7eb">1.795</td></tr>
    <tr style="background:#f7f8fa"><td style="padding:7px 10px;border-bottom:1px solid #e5e7eb">İST Yeni Acenteler</td><td style="padding:7px 10px;text-align:right;border-bottom:1px solid #e5e7eb">1.419</td></tr>
    <tr><td style="padding:7px 10px;border-bottom:1px solid #e5e7eb">İST Gerçek Mailler</td><td style="padding:7px 10px;text-align:right;border-bottom:1px solid #e5e7eb">175</td></tr>
    <tr style="background:#f7f8fa"><td style="padding:7px 10px;border-bottom:1px solid #e5e7eb">Etiketler</td><td style="padding:7px 10px;text-align:right;border-bottom:1px solid #e5e7eb">160</td></tr>
    <tr><td style="padding:7px 10px">Kampanyalar · Segment Özeti · Özet</td><td style="padding:7px 10px;text-align:right">—</td></tr>
  </table>

  <p style="background:#fff8e6;border-left:3px solid #d9a441;padding:10px 14px;margin:20px 0;font-size:14px">
    Dosya kişisel veri içeriyor (isim, e-posta, telefon). Herkese açık paylaşma.
  </p>

  <p style="color:#6b7280;font-size:13px;margin-top:24px">
    Klasördeki özet sayfaları zaten Drive'da:
    <a href="https://drive.google.com/drive/folders/1SzsPw2kDRyLe6ACiF7uenEKqfOT7LN5I" style="color:#1F3864">Constantine — Lead Datası</a>
  </p>
</div>`.trim();

const text = [
  'Constantine — Lead Datası (16 Ağustos 2026)',
  '',
  'Ekteki Excel dosyasında CRM\'deki tüm veri var. Gmail\'de ekin üzerindeki',
  '"Drive\'a kaydet" düğmesiyle doğrudan klasöre atabilirsin.',
  '',
  'Sayfalar: Tüm Leadler 6.046 | İstanbul 6.007 | Outreach Geçmişi 1.795',
  '          İST Yeni Acenteler 1.419 | İST Gerçek Mailler 175 | Etiketler 160',
  '          + Kampanyalar, Segment Özeti, Özet',
  '',
  'Dosya kişisel veri içeriyor — herkese açık paylaşma.',
  '',
  'Drive klasörü: https://drive.google.com/drive/folders/1SzsPw2kDRyLe6ACiF7uenEKqfOT7LN5I',
].join('\n');

const res = await mailProvider.send({
  from: `Constantine Ops <${FROM}>`,
  to: [TO],
  subject: 'Constantine — Lead Datası (16 Ağustos 2026)',
  html,
  text,
  attachments: [{
    filename: 'Constantine-Lead-Datasi-2026-08-16.xlsx',
    content: buf.toString('base64'),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }],
});

console.log('sonuç:', JSON.stringify(res));
