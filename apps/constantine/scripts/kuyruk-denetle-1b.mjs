#!/usr/bin/env node
/**
 * 1B kuyrugu HAZIRAN'DAN kalma — kimlik/MX/freemail kapilarindan HIC gecmedi.
 * Kampanyayi acmadan once kuyrugu ayni kapilardan gecir; cunku bu kutu (outreach@)
 * zaten itibar sorunu yasadi, ilk gonderimlerin temiz olmasi kritik.
 * node kuyruk-denetle-1b.mjs [--uygula]
 */
import postgres from 'postgres'; import fs from 'node:fs';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
import { adAlanEslesmesi } from './lib/kimlik.mjs';
const calistir = promisify(execFile);
const KAMPANYA = '3c0e9cad-ea5f-4ff3-8df8-54365f113e4a';
const UYGULA = process.argv.includes('--uygula');
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const freemail=new Set((await sql`SELECT domain FROM free_email_domains`).map(r=>r.domain.toLowerCase()));

const hedefler = await sql`
  SELECT t.id tid, l.id lid, l.company_name firma, lower(l.primary_contact_email) mail, l.tags
  FROM campaign_targets t JOIN leads l ON l.id=t.lead_id
  WHERE t.campaign_id=${KAMPANYA} AND t.status='queued'`;

async function mxVar(d) {
  for (const res of ['@1.1.1.1','@8.8.8.8']) {
    try { const {stdout}=await calistir('dig',[res,'+short','+time=4','+tries=2','MX',d],{timeout:20000});
      if (stdout.split('\n').some(l=>l.trim().split(/\s+/).length===2)) return true; } catch {}
  }
  return false;
}
const cikmis=new Set((await sql`SELECT lower(identifier) i FROM unsubscribes WHERE channel='email'`).map(r=>r.i));

const sonuc=[];
for (const h of hedefler) {
  const d=(h.mail.split('@')[1]||'');
  let sebep=null;
  if (cikmis.has(h.mail)) sebep='cikmis/bastirilmis';
  else if (freemail.has(d)) sebep='bedava-mail (kurumsal kampanyaya giremez)';
  else if (adAlanEslesmesi(h.firma, d) !== 'tam') sebep=`adres firmayla ortusmuyor (${d})`;
  else if (!(await mxVar(d))) sebep='MX yok — kesin bounce';
  sonuc.push({...h, sebep});
}
const kalan=sonuc.filter(x=>!x.sebep), dusen=sonuc.filter(x=>x.sebep);
console.log(`1B kuyrugu: ${hedefler.length} lead\n`);
console.log(`GECEN (${kalan.length}):`);
for (const x of kalan) console.log(`  ✓ ${x.firma.slice(0,34).padEnd(34)} ${x.mail}`);
console.log(`\nDUSEN (${dusen.length}):`);
for (const x of dusen) console.log(`  ✗ ${x.firma.slice(0,34).padEnd(34)} ${x.mail.padEnd(28)} ${x.sebep}`);

if (UYGULA && dusen.length) {
  for (const x of dusen) {
    await sql`UPDATE campaign_targets SET status='failed', error=${'1b-kuyruk-denetimi: '+x.sebep}
      WHERE id=${x.tid}::uuid`;
  }
  console.log(`\n${dusen.length} hedef kuyruktan dusuruldu`);
} else if (dusen.length) console.log('\n(--uygula ile dusurulur)');
await sql.end();
