/**
 * WhatsApp'tan gelen mesajdaki takip kodunu cozer: hangi kampanya, hangi firma.
 * Kullanim: node whatsapp-kod-coz.mjs CF29-A1B2
 */
import postgres from 'postgres';
import fs from 'node:fs';

const kod = (process.argv[2] ?? '').trim().replace(/[\[\]]/g, '').toUpperCase();
const m = kod.match(/^([0-9A-F]{4})-([0-9A-F]{6})(?:-([AB]))?$/);
if (!m) {
  console.error('Kod formati: XXXX-XXXXXX[-A|-B]  (ornek: CF29-A1B2C3-B)');
  process.exit(1);
}
const kPre = m[1].toLowerCase();
const lPre = m[2].toLowerCase();
const variant = m[3] ?? null;

const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sql = postgres(env.DATABASE_URL);

const camps = await sql`SELECT id, name FROM campaigns WHERE replace(id::text,'-','') LIKE ${kPre + '%'}`;
const leads = await sql`
  SELECT id, company_name, primary_contact_email, primary_contact_phone, district, tags
  FROM leads WHERE replace(id::text,'-','') LIKE ${lPre + '%'}`;

console.log(`\n=== ${kod} ===`);
console.log('KAMPANYA:', camps.length ? camps.map((c) => c.name).join(' | ') : 'bulunamadi');
if (variant) console.log('VARYANT :', variant, '(A/B testi)');
if (!leads.length) {
  console.log('FİRMA   : bulunamadi');
} else {
  for (const l of leads) {
    console.log(`FİRMA   : ${l.company_name}`);
    console.log(`          ${l.primary_contact_email}  ${l.primary_contact_phone ?? ''}  ${l.district ?? ''}`);
    console.log(`          etiketler: ${(l.tags ?? []).join(', ')}`);
    const t = await sql`
      SELECT to_char(ct.sent_at,'YYYY-MM-DD HH24:MI') s, c.name
      FROM campaign_targets ct JOIN campaigns c ON c.id=ct.campaign_id
      WHERE ct.lead_id=${l.id} AND ct.sent_at IS NOT NULL ORDER BY ct.sent_at DESC LIMIT 3`;
    for (const x of t) console.log(`          gönderim: ${x.s} — ${x.name}`);
  }
}
if (leads.length > 1) console.log('\n(!) birden fazla eslesme — kod on-eki cakismis, e-postadan ayirt et');
await sql.end();
