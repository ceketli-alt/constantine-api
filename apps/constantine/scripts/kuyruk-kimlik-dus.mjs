#!/usr/bin/env node
/**
 * Kuyruktaki KIMLIK UYUSMAYAN hedefleri duser (adres baska sirkete ait).
 * 1C kuyrugu 14 Agu'da, kimlik calismasindan ONCE dolduruldu — hic kapidan gecmedi.
 * `unvan-dogrulandi` etiketli leadler korunur (marka adi != ticaret unvani).
 * node kuyruk-kimlik-dus.mjs <campaign_id> [--uygula]
 */
import postgres from 'postgres'; import fs from 'node:fs';
import { adAlanEslesmesi } from './lib/kimlik.mjs';
const KAMPANYA = process.argv[2];
const UYGULA = process.argv.includes('--uygula');
if (!KAMPANYA) { console.error('kampanya id gerekli'); process.exit(1); }
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const freemail=new Set((await sql`SELECT domain FROM free_email_domains`).map(r=>r.domain.toLowerCase()));
const r = await sql`
  SELECT t.id tid, l.id lid, l.company_name firma, lower(l.primary_contact_email) mail, l.tags
  FROM campaign_targets t JOIN leads l ON l.id=t.lead_id
  WHERE t.campaign_id=${KAMPANYA} AND t.status='queued' AND l.primary_contact_email IS NOT NULL`;
const dusen = r.filter(x => {
  if (x.tags?.includes('unvan-dogrulandi')) return false;
  const d = x.mail.split('@')[1]||'';
  if (freemail.has(d)) return false;              // bedava-mail'de ad<->alan zaten eslesmez
  return adAlanEslesmesi(x.firma, d) === 'yok';
});
console.log(`kuyruk ${r.length} · kimlik uyusmayan ${dusen.length}`);
for (const d of dusen.slice(0,8)) console.log(`  ${(d.firma||'').slice(0,32).padEnd(32)} ${d.mail}`);
if (dusen.length>8) console.log(`  ... +${dusen.length-8}`);
if (UYGULA && dusen.length) {
  for (const d of dusen) {
    await sql`UPDATE campaign_targets SET status='failed', error='kimlik:adres baska sirkete ait' WHERE id=${d.tid}::uuid`;
    await sql`UPDATE leads SET tags = CASE WHEN 'kimlik-dogrulanamadi' = ANY(tags) THEN tags
      ELSE array_append(tags,'kimlik-dogrulanamadi') END WHERE id=${d.lid}::uuid`;
  }
  console.log(`\n${dusen.length} hedef kuyruktan dusuruldu`);
} else if (dusen.length) console.log('\n(--uygula ile dusurulur)');
await sql.end();
