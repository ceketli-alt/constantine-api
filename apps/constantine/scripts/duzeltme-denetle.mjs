#!/usr/bin/env node
/**
 * KENDI DUZELTMEMI DENETLE — hangi degisiklikler aslinda GERILEME?
 *
 * Iki hata deseni tespit edildi:
 *  H1) Eski adres zaten firmanin KENDI alan adindaydi, ben baska alana tasidim.
 *      (TRAVEL BY POWER: gucseyahat@travelbypower.com.tr -> info@thabtravel.com)
 *      Sebep: CRM'deki website alani yanlisti, siteyi mailin kanitina tercih ettim.
 *  H2) Ayni alan adi icinde rol degistirdim (reservation@ -> info@).
 *      Bu duzeltme degil; isimli/ozel muhatabi kaybettiriyor.
 */
import postgres from 'postgres';
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
    .filter(l=>l.includes('=')&&!l.trim().startsWith('#'))
    .map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql = postgres(env.DATABASE_URL);

const GENERIC = new Set(['turizm','tur','tour','tours','seyahat','acenta','acentasi','acentesi',
 'travel','tourism','trip','holiday','holidays','tatil','journey','journeys','agency','ltd','sti',
 'as','group','grup','international','global','world','istanbul','turkey','turkiye','hotel','hotels',
 'com','tic','san','ve','and','the','dmc','vip','transfer','clinic','health','saglik','estetik']);
const norm=(s)=>(s||'').replace(/İ/g,'i').replace(/I/g,'i').replace(/ı/g,'i').replace(/Ş/g,'s')
  .replace(/ş/g,'s').replace(/Ğ/g,'g').replace(/ğ/g,'g').replace(/Ü/g,'u').replace(/ü/g,'u')
  .replace(/Ö/g,'o').replace(/ö/g,'o').replace(/Ç/g,'c').replace(/ç/g,'c')
  .toLowerCase().replace(/[^a-z0-9]/g,'');
const toks=(n)=>(n||'').split(/[\s.\-_/&,()]+/).map(norm).filter(t=>t.length>=3&&!GENERIC.has(t));
const eslesir=(firma,dom)=>{
  const core=norm((dom||'').split('.')[0]); const ts=toks(firma); const glued=norm(firma);
  if(!core||!ts.length) return false;
  return ts.some(t=>core.includes(t)||t.includes(core)) || (core.length>=5&&glued.includes(core));
};

const iz = fs.readFileSync('/root/acente-data-2026-08/MAIL-DUZELTME-IZI.csv','utf8')
  .split('\n').slice(1).filter(Boolean).map(l=>{
    const p=l.split(','); return {id:p[0],eski:p[1],yeni:p[2],firma:p[3],domain:p[4]};
  });

const h1=[], h2=[], ok=[];
for (const r of iz) {
  const eskiDom=(r.eski.split('@')[1]||'').toLowerCase();
  const yeniDom=(r.yeni.split('@')[1]||'').toLowerCase();
  if (eskiDom && eskiDom===yeniDom) { h2.push(r); continue; }
  if (eskiDom && eslesir(r.firma, eskiDom) && !eslesir(r.firma, yeniDom)) { h1.push(r); continue; }
  ok.push(r);
}
console.log(`toplam degisiklik : ${iz.length}`);
console.log(`  H1 GERILEME (eski alan adi firmayla uyuyordu) : ${h1.length}`);
console.log(`  H2 ayni alan, sadece rol degisti              : ${h2.length}`);
console.log(`  saglam duzeltme                                : ${ok.length}`);

console.log('\n--- H1 ornekleri (geri alinmali) ---');
h1.slice(0,12).forEach(r=>console.log(`  ${r.firma.slice(0,26).padEnd(26)} ${r.eski.padEnd(34)} → ${r.yeni}`));
console.log('\n--- H2 ornekleri (geri alinmali) ---');
h2.slice(0,10).forEach(r=>console.log(`  ${r.firma.slice(0,26).padEnd(26)} ${r.eski.padEnd(34)} → ${r.yeni}`));

fs.writeFileSync('/root/acente-data-2026-08/GERI-ALINACAK.csv',
  'tip,lead_id,eski_mail,yanlis_yeni,firma\n'+
  [...h1.map(r=>['H1',r.id,r.eski,r.yeni,r.firma].join(',')),
   ...h2.map(r=>['H2',r.id,r.eski,r.yeni,r.firma].join(','))].join('\n'));
console.log('\n→ /root/acente-data-2026-08/GERI-ALINACAK.csv');
await sql.end();
