/**
 * Siteden kazinmis gercek e-postali Istanbul acentelerini CRM'e alir.
 * Kaynak: /root/acente-data-2026-08/ISTANBUL-GERCEK-MAILLER.csv
 * Dogrulama: YAPILMAZ - campaign-autofill.mjs kampanyaya alirken NeverBounce'tan gecirir.
 * Calistirma: node import-istanbul-acente.mjs [--dry]
 */
import postgres from 'postgres';
import fs from 'node:fs';

const CSV = '/root/acente-data-2026-08/ISTANBUL-GERCEK-MAILLER.csv';
const DRY = process.argv.includes('--dry');

const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sql = postgres(env.DATABASE_URL);

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift().map((h) => h.replace(/^﻿/, '').trim());
  return rows.filter((r) => r.length >= head.length && r[0])
    .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
console.log(`CSV: ${rows.length} firma`);

const existingEmail = new Set(
  (await sql`SELECT lower(primary_contact_email) e FROM leads WHERE primary_contact_email IS NOT NULL`)
    .map((r) => r.e),
);
const normName = (s) => (s || '').toLocaleUpperCase('tr-TR')
  .replace(/[^\p{L}\p{N}]/gu, '')
  .replace(/TURIZM|TURİZM|SEYAHAT|ACENTASI|ACENTESI|TRAVEL|TOURISM|LTD|STI|ŞTİ/g, '');
const existingName = new Set(
  (await sql`SELECT company_name FROM leads WHERE company_name IS NOT NULL`).map((r) => normName(r.company_name)),
);

const toInsert = [];
const atlanan = { mail_var: 0, isim_var: 0 };
for (const r of rows) {
  const email = (r['Email'] || '').toLowerCase();
  if (!email.includes('@')) continue;
  if (existingEmail.has(email)) { atlanan.mail_var++; continue; }
  const nn = normName(r['Acenta Adi']);
  if (nn && existingName.has(nn)) { atlanan.isim_var++; continue; }
  existingEmail.add(email);
  if (nn) existingName.add(nn);

  const tags = ['seg-unenriched', 'trust-unknown', 'mert-list-2020', 'ist-yeni', 'siteden-kazindi'];
  if (r['Guven'] === 'YÜKSEK') tags.push('guven-yuksek');
  if (r['TURSAB']) tags.push(`tursab-${r['TURSAB'].toLowerCase()}`);

  toInsert.push({
    company_name: r['Acenta Adi'].slice(0, 200),
    primary_contact_email: email,
    primary_contact_phone: r['Telefon'] || null,
    website: r['Domain'] ? `https://${r['Domain']}` : null,
    city: 'İstanbul',
    district: r['Ilce'] || null,
    tags,
  });
}

console.log(`eklenecek: ${toInsert.length}  |  atlanan: mail zaten var ${atlanan.mail_var}, isim zaten var ${atlanan.isim_var}`);
console.log('ornek:', toInsert.slice(0, 3).map((r) => `${r.company_name} <${r.primary_contact_email}> ${r.district}`));

if (DRY) { console.log('[DRY RUN] yazilmadi'); await sql.end(); process.exit(0); }

let ok = 0;
for (const r of toInsert) {
  try {
    await sql`
      INSERT INTO leads (company_name, primary_contact_email, primary_contact_phone, website,
                         city, district, tags, source, status, type, segment)
      VALUES (${r.company_name}, ${r.primary_contact_email}, ${r.primary_contact_phone}, ${r.website},
              ${r.city}, ${r.district}, ${r.tags}, 'mert-list-2020', 'new', 'agency', 'agroup_agency')`;
    ok++;
  } catch (e) {
    if (ok < 3) console.warn('hata:', e.message.slice(0, 120));
  }
}
console.log(`✓ CRM'e eklendi: ${ok}`);
await sql.end();
