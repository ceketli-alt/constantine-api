/**
 * IST-ACENTE kuyrugundaki adresleri denetler:
 *  - sablon/placeholder adresler (youremail@, firstname@, admin@mail.com ...)
 *  - firmanin kendi domaininden BASKA bir domaine ait adresler
 *  - URL artigi (%20, .html)
 *  - ucretsiz saglayici (gmail vb.) -> sadece raporlanir, dusurulmez
 * --fix verilirse supheli olanlari kuyruktan duser (status='failed').
 */
import postgres from 'postgres';
import fs from 'node:fs';

const CAMPAIGN = 'cf291a24-25e5-4b68-98a4-6a621f425513';
const FIX = process.argv.includes('--fix');

const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sql = postgres(env.DATABASE_URL);

const PLACEHOLDER = /^(youremail|firstname|lastname|yourname|example|example\.mail|sample|admin|mail|email|user|adiniz|isim|test|ornek)$/i;
const FREE = new Set(['gmail.com', 'hotmail.com', 'yahoo.com', 'outlook.com', 'yandex.com',
  'icloud.com', 'msn.com', 'windowslive.com', 'mynet.com', 'hotmail.co.uk', 'yahoo.co.uk']);

// firma domaini ile mail domaini ayni "cekirdek"i paylasiyor mu?
const core = (d) => (d || '').toLowerCase().replace(/^www\./, '').split('.')[0];

const rows = await sql`
  SELECT ct.id, l.company_name, l.primary_contact_email AS email, l.website
  FROM campaign_targets ct JOIN leads l ON l.id = ct.lead_id
  WHERE ct.campaign_id = ${CAMPAIGN} AND ct.status = 'queued'`;

const bad = [], free = [], ok = [];
for (const r of rows) {
  const email = (r.email || '').toLowerCase();
  const [local, dom = ''] = email.split('@');
  const siteDom = (r.website || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  let reason = null;

  if (/%[0-9a-f]{2}/i.test(email) || /\.(html?|php|aspx?)$/i.test(email)) reason = 'url-artığı';
  else if (PLACEHOLDER.test(local)) reason = 'şablon-adres';
  else if (dom.includes('..') || dom.startsWith('.') || !dom.includes('.')) reason = 'bozuk-domain';
  else if (!FREE.has(dom) && siteDom && core(dom) !== core(siteDom)) reason = 'başka-firma-domaini';

  if (reason) bad.push({ ...r, reason });
  else if (FREE.has(dom)) free.push(r);
  else ok.push(r);
}

console.log(`kuyrukta ${rows.length} adres`);
console.log(`  temiz kurumsal : ${ok.length}`);
console.log(`  ücretsiz sağlayıcı (bırakılıyor): ${free.length}`);
console.log(`  ŞÜPHELİ : ${bad.length}`);
for (const b of bad) console.log(`    [${b.reason}] ${b.company_name} → ${b.email}  (site: ${b.website})`);
if (free.length) console.log('\n  ücretsiz:', free.map((f) => f.email).join(', '));

if (!FIX) { console.log('\n(--fix verilmedi, değişiklik yapılmadı)'); await sql.end(); process.exit(0); }

for (const b of bad) {
  await sql`UPDATE campaign_targets SET status='failed', error=${'audit:' + b.reason} WHERE id=${b.id}`;
}
console.log(`\n✓ ${bad.length} şüpheli adres kuyruktan düşürüldü`);
const [{ n }] = await sql`
  SELECT count(*)::int n FROM campaign_targets WHERE campaign_id=${CAMPAIGN} AND status='queued'`;
console.log(`kalan temiz kuyruk: ${n}`);
await sql.end();
