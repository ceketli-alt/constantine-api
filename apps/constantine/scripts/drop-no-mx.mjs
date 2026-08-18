/**
 * MX kaydi HIC OLMAYAN adresleri kuyruktan duser — bunlar kesin hard-bounce eder.
 * (YURTICI TURIZM dersi: MX yoksa ya da arkasinda posta servisi yoksa mail bounce eder,
 *  NeverBounce ve site kontrolu bunu yakalamiyor.)
 * Kullanim: node drop-no-mx.mjs <domain> [<domain>...]
 */
import postgres from 'postgres';
import fs from 'node:fs';

const CAMPAIGN = 'cf291a24-25e5-4b68-98a4-6a621f425513';
const domains = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!domains.length) { console.error('domain verilmedi'); process.exit(1); }

const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sql = postgres(env.DATABASE_URL);

let n = 0;
for (const d of domains) {
  const r = await sql`
    UPDATE campaign_targets ct SET status='failed', error='mx:posta sunucusu yok — kesin bounce'
    FROM leads l
    WHERE ct.lead_id = l.id AND ct.campaign_id = ${CAMPAIGN} AND ct.status = 'queued'
      AND lower(split_part(l.primary_contact_email,'@',2)) = ${d.toLowerCase()}`;
  console.log(`${r.count ? '✓' : '–'} ${d} (${r.count})`);
  n += r.count;
}
const [{ q }] = await sql`
  SELECT count(*)::int q FROM campaign_targets WHERE campaign_id=${CAMPAIGN} AND status='queued'`;
console.log(`\n${n} düşürüldü — kuyruk: ${q}`);
await sql.end();
