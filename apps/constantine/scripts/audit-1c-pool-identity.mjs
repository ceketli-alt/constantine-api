#!/usr/bin/env node
/**
 * PHASE-1C havuz kimlik denetimi.
 *
 * Sorun: 'email-valid' (NeverBounce) yalnizca "kutu var mi" der,
 * "kutu BU firmaya mi ait" demez. Istanbul turunda ayni desen
 * 145 leadin 61'ini yanlis sirkete baglamisti (PANDORA TRAVEL -> pandora.com).
 *
 * Bu script offline birinci elemedir: firma adindaki AYIRT EDICI kelimeler
 * ile mail alan adi ortusuyor mu? Ortusmuyorsa lead supheli, kampanyaya girmez.
 * Site dogrulamasi (ikinci elek) ayri adim.
 */
import postgres from 'postgres';
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sql = postgres(env.DATABASE_URL);

const C1 = '018f99ba-cea8-4a1b-9bab-466801f5810f';

// Turkce normalize — buyuk I/i tuzagi dahil
const norm = (s) => (s || '')
  .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i')
  .replace(/Ş/g, 's').replace(/ş/g, 's').replace(/Ğ/g, 'g').replace(/ğ/g, 'g')
  .replace(/Ü/g, 'u').replace(/ü/g, 'u').replace(/Ö/g, 'o').replace(/ö/g, 'o')
  .replace(/Ç/g, 'c').replace(/ç/g, 'c')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

// Sektorde HERKESTE olan kelimeler ayirt edici degil — atilir
const GENERIC = new Set([
  'turizm','tur','tour','tours','turizmi','seyahat','acenta','acentasi','acentesi',
  'travel','tourism','trip','trips','holiday','holidays','tatil','voyage','journey',
  'ltd','sti','ltdsti','as','anonim','sirketi','limited','company','co','inc','group','grup',
  'international','intl','global','world','dunya','istanbul','turkey','turkiye','tr',
  'hizmetleri','ticaret','tic','san','sanayi','ve','and','the','org','dmc','vip','transfer',
]);

const tokens = (name) => (name || '')
  .split(/[\s.\-_/&,()]+/)
  .map(norm)
  .filter(t => t.length >= 3 && !GENERIC.has(t));

const rows = await sql`
  SELECT l.id, l.company_name, l.primary_contact_email, l.website
  FROM leads l
  WHERE l.last_contacted_at IS NULL AND l.status='new'
    AND NOT ('seg-irrelevant' = ANY(l.tags))
    AND 'email-valid' = ANY(l.tags)
    AND NOT EXISTS (SELECT 1 FROM free_email_domains f
      WHERE lower(split_part(l.primary_contact_email,'@',2)) = f.domain)
    AND NOT EXISTS (SELECT 1 FROM unsubscribes u
      WHERE u.channel='email' AND lower(u.identifier)=lower(l.primary_contact_email))
    AND NOT EXISTS (SELECT 1 FROM campaign_targets ct
      WHERE ct.campaign_id=${C1} AND ct.lead_id=l.id)`;

const out = { ESLESTI: [], KISMI: [], ESLESMEDI: [], ADSIZ: [] };

for (const r of rows) {
  const dom = norm((r.primary_contact_email || '').split('@')[1]?.split('.')[0]);
  const toks = tokens(r.company_name);
  if (!toks.length || !dom) { out.ADSIZ.push(r); continue; }

  // tam kapsama: ayirt edici kelime alan adinin icinde geciyor mu (veya tersi)
  const full = toks.some(t => dom.includes(t) || t.includes(dom));
  // kismi: ilk 5 harf ortusmesi (kisaltma/ekleme toleransi)
  const part = toks.some(t => t.length >= 5 && dom.length >= 5 &&
    (dom.startsWith(t.slice(0, 5)) || t.startsWith(dom.slice(0, 5))));
  // firma adinin bitisik hali alan adini kapsiyor mu (BYE BYE -> byebye-group)
  const glued = norm(r.company_name);
  const glue = dom.length >= 4 && (glued.includes(dom) || dom.includes(glued.slice(0, 8)));

  if (full || glue) out.ESLESTI.push(r);
  else if (part) out.KISMI.push(r);
  else out.ESLESMEDI.push(r);
}

console.log(`toplam incelenen: ${rows.length}\n`);
for (const k of ['ESLESTI', 'KISMI', 'ESLESMEDI', 'ADSIZ']) {
  const pct = ((out[k].length / rows.length) * 100).toFixed(1);
  console.log(`${k.padEnd(10)} ${String(out[k].length).padStart(5)}  (%${pct})`);
}

const show = (k, n = 12) => {
  console.log(`\n--- ${k} ornekleri ---`);
  for (const r of out[k].slice(0, n)) {
    console.log(`  ${(r.company_name || '').slice(0, 34).padEnd(34)} | ${r.primary_contact_email}`);
  }
};
show('ESLESTI'); show('KISMI'); show('ESLESMEDI');

fs.writeFileSync('/root/acente-data-2026-08/1c-havuz-kimlik.csv',
  'sinif,firma,mail,site,lead_id\n' +
  Object.entries(out).flatMap(([k, rs]) => rs.map(r =>
    [k, JSON.stringify(r.company_name || ''), r.primary_contact_email, r.website || '', r.id].join(',')
  )).join('\n'));
console.log('\n→ /root/acente-data-2026-08/1c-havuz-kimlik.csv yazildi');
await sql.end();
