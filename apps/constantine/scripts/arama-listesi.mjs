#!/usr/bin/env node
/**
 * ARAMA LISTESI — maille ulasilamayan ama telefonu olan Istanbul acenteleri.
 *
 * Gerekce (olculmus): 851 soguk mail → 1 cevap (%0,1) · 28 taniyan temas → 6 cevap (%21).
 * Yani telefon/WhatsApp kanali mailden ~200 kat verimli. Microsoft adresli 332 lead
 * icin de dogru cevap bu: %91,5 spam'e dusen bir kanaldan mail atmak yerine aramak.
 *
 * Oncelik: TURSAB A grubu > sitesi var > ilcesi merkezi > guven etiketi.
 */
import postgres from 'postgres';
import fs from 'node:fs';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
  .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);

const MERKEZ=['beyoğlu','beyoglu','fatih','şişli','sisli','beşiktaş','besiktas','kadıköy','kadikoy','sarıyer','sariyer','bakırköy','bakirkoy'];

const rows=await sql`
  SELECT l.id, l.company_name, l.primary_contact_phone tel, coalesce(l.primary_contact_email,'') mail,
         coalesce(l.website,'') site, coalesce(l.city,'') sehir, coalesce(l.address,'') adres, l.tags
  FROM leads l
  WHERE NOT EXISTS (SELECT 1 FROM campaign_targets t WHERE t.lead_id=l.id)
    AND NOT ('seg-irrelevant'=ANY(l.tags))
    AND NOT ('ist-kurtarma-2026-08'=ANY(l.tags))
    AND l.primary_contact_phone IS NOT NULL AND l.primary_contact_phone <> ''`;

const MS=['hotmail.com','outlook.com','hotmail.com.tr','live.com','msn.com','windowslive.com','hotmail.de'];
const puanla=(r)=>{
  let p=0;
  if (r.tags?.includes('tursab-a')) p+=40;
  if (r.tags?.includes('guven-yuksek')||r.tags?.includes('trust-high')) p+=25;
  else if (r.tags?.includes('trust-medium')) p+=10;
  if (r.site) p+=15;
  const ad=(r.adres||'').toLowerCase();
  if (MERKEZ.some(m=>ad.includes(m))) p+=10;
  if (r.mail && MS.includes((r.mail.split('@')[1]||'').toLowerCase())) p+=8; // maille ulasilamiyor → arama tek yol
  return p;
};
const sirali=rows.map(r=>({...r,puan:puanla(r)})).sort((a,b)=>b.puan-a.puan);

const csv=['oncelik,puan,firma,telefon,mail,site,adres,lead_id'];
sirali.forEach((r,i)=>csv.push([
  i<300?'A-ONCE':i<900?'B':'C', r.puan,
  `"${(r.company_name||'').replace(/"/g,'')}"`, r.tel, r.mail, r.site,
  `"${(r.adres||'').replace(/"/g,'').slice(0,60)}"`, r.id].join(',')));
fs.writeFileSync('/root/acente-data-2026-08/ARAMA-LISTESI.csv', csv.join('\n'));

console.log(`arama listesi: ${sirali.length} lead`);
console.log(`  A-ONCE (ilk 300): puan ${sirali[299]?.puan ?? '-'} ve uzeri`);
console.log(`  sitesi olan     : ${sirali.filter(r=>r.site).length}`);
console.log(`  TURSAB A        : ${sirali.filter(r=>r.tags?.includes('tursab-a')).length}`);
console.log('\n--- ilk 12 ---');
sirali.slice(0,12).forEach(r=>console.log(`  ${String(r.puan).padStart(3)} ${(r.company_name||'').slice(0,32).padEnd(32)} ${r.tel}`));
console.log('\n→ /root/acente-data-2026-08/ARAMA-LISTESI.csv');
await sql.end();
