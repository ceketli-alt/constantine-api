#!/usr/bin/env node
/**
 * NUFUS SAYIMI — bostaki (hic kampanyaya girmemis) her lead nereye ait?
 *
 * Amac: "hicbir sey kacmasin". Her lead tek bir kurtarma hattina dusuruur,
 * hicbiri sinifsiz kalmaz. Toplam mutlaka evrene esit olmalidir.
 */
import postgres from 'postgres';
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sql = postgres(env.DATABASE_URL);

const GENERIC = new Set(['turizm','tur','tour','tours','turizmi','seyahat','acenta','acentasi',
 'acentesi','travel','tourism','trip','trips','holiday','holidays','tatil','voyage','journey',
 'agency','ltd','sti','ltdsti','as','anonim','sirketi','limited','company','co','inc','group',
 'grup','international','intl','global','world','dunya','istanbul','turkey','turkiye','tr',
 'hizmetleri','ticaret','tic','san','sanayi','ve','and','the','org','dmc','vip','transfer']);

const norm = (s) => (s || '')
  .replace(/İ/g,'i').replace(/I/g,'i').replace(/ı/g,'i').replace(/Ş/g,'s').replace(/ş/g,'s')
  .replace(/Ğ/g,'g').replace(/ğ/g,'g').replace(/Ü/g,'u').replace(/ü/g,'u')
  .replace(/Ö/g,'o').replace(/ö/g,'o').replace(/Ç/g,'c').replace(/ç/g,'c')
  .toLowerCase().replace(/[^a-z0-9]/g,'');
const toks = (n) => (n||'').split(/[\s.\-_/&,()]+/).map(norm).filter(t=>t.length>=3 && !GENERIC.has(t));

function adEslesme(firma, mail) {
  const dom = norm((mail||'').split('@')[1]?.split('.')[0]);
  const ts = toks(firma);
  if (!dom || !ts.length) return 'bilinmiyor';
  const glued = norm(firma);
  if (ts.some(t => dom.includes(t) || t.includes(dom))) return 'eslesti';
  if (dom.length>=4 && (glued.includes(dom) || dom.includes(glued.slice(0,8)))) return 'eslesti';
  if (ts.some(t => t.length>=5 && dom.length>=5 && (dom.startsWith(t.slice(0,5))||t.startsWith(dom.slice(0,5))))) return 'kismi';
  return 'eslesmedi';
}

const rows = await sql`
  SELECT l.id, l.company_name, coalesce(l.primary_contact_email,'') mail,
         coalesce(l.website,'') site, coalesce(l.primary_contact_phone,'') tel,
         coalesce(l.city,'') city, l.tags
  FROM leads l
  WHERE NOT EXISTS (SELECT 1 FROM campaign_targets t WHERE t.lead_id=l.id)
    AND NOT ('seg-irrelevant' = ANY(l.tags))`;

const freeDoms = new Set((await sql`SELECT domain FROM free_email_domains`).map(r=>r.domain));
const unsub = new Set((await sql`SELECT lower(identifier) i FROM unsubscribes WHERE channel='email'`).map(r=>r.i));

const hat = {};
const push = (k, r) => (hat[k] = hat[k] || []).push(r);

for (const r of rows) {
  const mail = r.mail.trim().toLowerCase();
  const mailDom = mail.split('@')[1] || '';
  const bedava = freeDoms.has(mailDom);
  const siteVar = !!r.site.trim();

  if (mail && unsub.has(mail))        { push('0-CIKMIS (dokunma)', r); continue; }
  if (!mail &&  siteVar)              { push('1-MAILSIZ + site var → kazi', r); continue; }
  if (!mail && !siteVar && r.tel)     { push('2-MAILSIZ + sadece telefon → arama listesi', r); continue; }
  if (!mail && !siteVar && !r.tel)    { push('3-VERI YOK (olu kayit)', r); continue; }

  const es = adEslesme(r.company_name, mail);
  if (bedava)                         { push(`4-BEDAVA MAIL (${es}) → Canary hatti`, r); continue; }
  if (es === 'eslesti')               { push('5-MAIL SAGLAM (ad uyuyor)', r); continue; }
  if (siteVar)                        { push('6-MAIL SUPHELI + site var → kazi ile duzelt', r); continue; }
  push('7-MAIL SUPHELI + site YOK → domain bulunmali', r);
}

console.log(`BOSTAKI TOPLAM: ${rows.length}\n`);
const ks = Object.keys(hat).sort();
let t = 0;
for (const k of ks) { console.log(`  ${k.padEnd(46)} ${String(hat[k].length).padStart(5)}`); t += hat[k].length; }
console.log(`  ${'TOPLAM'.padEnd(46)} ${String(t).padStart(5)}  ${t === rows.length ? '✓ evrenle uyusuyor' : '✗ KAYIP VAR'}`);

fs.writeFileSync('/root/acente-data-2026-08/NUFUS-SAYIMI.csv',
  'hat,lead_id,firma,mail,site,tel,sehir\n' +
  ks.flatMap(k => hat[k].map(r => [k, r.id, `"${(r.company_name||'').replace(/"/g,'')}"`,
    r.mail, r.site, r.tel, r.city].join(','))).join('\n'));
console.log('\n→ /root/acente-data-2026-08/NUFUS-SAYIMI.csv');
await sql.end();
