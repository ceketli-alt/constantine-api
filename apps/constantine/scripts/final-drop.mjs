/**
 * Son kontrol sonrasi kalan 4 hatali kaydi duser.
 * Karar gerekcesi her biri icin ayri yazildi — otomatik kural degil, tek tek degerlendirme.
 */
import postgres from 'postgres';
import fs from 'node:fs';

const CAMPAIGN = 'cf291a24-25e5-4b68-98a4-6a621f425513';
const DROP = {
  'sales@vipscuba.com': 'park-domain: site "domain for sale"',
  'domain@finans.com': 'park-domain: adres domain satis iletisimi, firma degil',
  'info@gallant.com': 'sitede hic Turkce icerik yok, jenerik domain — baska sirket',
  'info@srmtravel.com': 'mail sitede yok + firma adi gecmiyor + TR izi yok',
};
// KALANLAR (bilerek birakildi):
//  hamdidursun@birceturizm.com — site yapim asamasinda ama domain firma adiyla birebir, kutu gecerli
//  info@sahintas.com           — Turkce izi cok guclu (10), domain firma adi
//  info@frozen.com.tr          — .com.tr + TR telefon + Turkce, domain firma adi
//  reservations@ritmotravel.com— seyahat sinyali var, domain firma adi

const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sql = postgres(env.DATABASE_URL);

let n = 0;
for (const [email, reason] of Object.entries(DROP)) {
  const r = await sql`
    UPDATE campaign_targets ct SET status='failed', error=${'sonkontrol:' + reason}
    FROM leads l
    WHERE ct.lead_id = l.id AND ct.campaign_id = ${CAMPAIGN} AND ct.status = 'queued'
      AND lower(l.primary_contact_email) = ${email}`;
  console.log(`${r.count ? '✓' : '–'} ${email} — ${reason}`);
  n += r.count;
}
const [{ q }] = await sql`
  SELECT count(*)::int q FROM campaign_targets WHERE campaign_id=${CAMPAIGN} AND status='queued'`;
console.log(`\n${n} düşürüldü — NİHAİ TEMİZ KUYRUK: ${q}`);
await sql.end();
