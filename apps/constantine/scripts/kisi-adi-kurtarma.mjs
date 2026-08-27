#!/usr/bin/env node
/**
 * KISI-ADI KURTARMASI — alan adi tutmuyor diye elenen leadleri ikinci sansa alir.
 *
 * Gerekce: "CAN DUMAN TRAVEL AGENCY -> can.duman@visitoria.com.tr" ornegi.
 * Alan adi firmayla uyusmuyor ama mailin YEREL kismi kisinin adi.
 * Bu, firmanin marka degistirdigi ya da kisinin gercek is adresi oldugu anlamina gelir;
 * yanlis-sirket vakasi degildir. Sadece alan adina bakan test bunlari haksiz eliyor.
 */
import postgres from 'postgres';
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
    .filter(l=>l.includes('=')&&!l.trim().startsWith('#'))
    .map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql = postgres(env.DATABASE_URL);

const norm=(s)=>(s||'').replace(/İ/g,'i').replace(/I/g,'i').replace(/ı/g,'i').replace(/Ş/g,'s')
  .replace(/ş/g,'s').replace(/Ğ/g,'g').replace(/ğ/g,'g').replace(/Ü/g,'u').replace(/ü/g,'u')
  .replace(/Ö/g,'o').replace(/ö/g,'o').replace(/Ç/g,'c').replace(/ç/g,'c')
  .toLowerCase().replace(/[^a-z0-9]/g,'');

// hat 6 ve 7: mail supheli olanlar
const lines = fs.readFileSync('/root/acente-data-2026-08/NUFUS-SAYIMI.csv','utf8').split('\n');
const ids = lines.filter(l=>l.startsWith('6-MAIL SUPHELI')||l.startsWith('7-MAIL SUPHELI'))
  .map(l=>l.split(',')[1]).filter(Boolean);

const rows = await sql`
  SELECT id, company_name, primary_contact_name, primary_contact_email
  FROM leads WHERE id = ANY(${ids}::uuid[])`;

const ROL = new Set(['info','bilgi','iletisim','contact','sales','satis','rezervasyon',
  'reservation','reservations','booking','operation','operasyon','muhasebe','destek',
  'support','office','admin','mail','hello','team','ticket','travel','turizm']);

const kurtarilan = [];
for (const r of rows) {
  const local = (r.primary_contact_email||'').split('@')[0] || '';
  const ln = norm(local);
  if (!ln || ROL.has(ln)) continue;                    // rol hesabi -> kisi sinyali yok

  // mailin yerel kismindaki parcalar
  const parcalar = local.split(/[._\-]+/).map(norm).filter(p=>p.length>=3);
  if (!parcalar.length) continue;

  const kisi = norm(r.primary_contact_name);
  const firmaTok = (r.company_name||'').split(/[\s.\-_/&,()]+/).map(norm).filter(t=>t.length>=3);

  let sebep = '';
  if (kisi && parcalar.every(p=>kisi.includes(p)) && parcalar.length>=2) sebep='kisi-adi-tam';
  else if (kisi && parcalar.some(p=>p.length>=4 && kisi.includes(p)))    sebep='kisi-adi-kismi';
  else if (parcalar.some(p=>p.length>=4 && firmaTok.some(t=>t===p)))     sebep='firma-kelimesi';
  if (!sebep) continue;

  kurtarilan.push({id:r.id, firma:r.company_name, kisi:r.primary_contact_name||'',
                   mail:r.primary_contact_email, sebep});
}

console.log(`incelenen supheli lead : ${rows.length}`);
console.log(`kisi sinyaliyle kurtarilan: ${kurtarilan.length}\n`);
const say = {};
kurtarilan.forEach(k=>say[k.sebep]=(say[k.sebep]||0)+1);
console.table(say);
console.log('--- ornekler ---');
kurtarilan.slice(0,15).forEach(k=>
  console.log(`  [${k.sebep}] ${(k.firma||'').slice(0,26).padEnd(26)} kisi="${(k.kisi||'').slice(0,18)}" ${k.mail}`));

fs.writeFileSync('/root/acente-data-2026-08/KISI-ADI-KURTARMA.csv',
  'lead_id,firma,kisi,mail,sebep\n'+kurtarilan.map(k=>
    [k.id,`"${(k.firma||'').replace(/"/g,'')}"`,`"${(k.kisi||'').replace(/"/g,'')}"`,k.mail,k.sebep].join(',')).join('\n'));
console.log('\n→ /root/acente-data-2026-08/KISI-ADI-KURTARMA.csv');
await sql.end();
