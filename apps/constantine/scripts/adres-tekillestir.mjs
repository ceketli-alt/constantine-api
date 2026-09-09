#!/usr/bin/env node
/**
 * ADRES TEKILLESTIRME — bir posta kutusuna BIR mail.
 *
 * Sorun (26 Agu denetimi): CRM'de iki leadin `website` alani ayniysa ikisi de ayni
 * kazinmis adresi aliyordu. Kurtarma partisinde 12 adres 2-7 farkli firmaya atanmisti
 * (`info@nice-journey.com` → 7 firma). Kok sebep: 'world','global','wonder','nova',
 * 'delux' gibi JENERIK kelimeleri ayirt edici saymisim (BENTE WORLD ve BATURES WORLD
 * ikisi de worldtur.com'a baglanmis).
 *
 * Ayrica mesru vakada bile (ayni zincirin 3 oteli, tek rezervasyon kutusu) ayni gelen
 * kutusuna 3 kez mail atmak yanlis. Her iki durumda da cozum ayni: EN IYI eslesen
 * leadi tut, digerlerini cikar.
 *
 * Kullanim: node adres-tekillestir.mjs [--uygula]
 */
import postgres from 'postgres';
import fs from 'node:fs';
import { norm, tokenlar, alanCekirdegi } from './lib/kimlik.mjs';
const UYGULA=process.argv.includes('--uygula');
const ETIKET='ist-kurtarma-2026-08';
const C1='018f99ba-cea8-4a1b-9bab-466801f5810f';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
  .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);

// Jenerik kelime listesi ve normalizasyon TEK KAYNAKTAN gelir (lib/kimlik.mjs).
// 26 Agu dersi: bu dosyada AYRI bir liste vardi; kimlik.mjs'e eklenen kelimeler
// buraya yansimayinca ayni firma iki dosyada iki farkli sonuc veriyordu.

function puan(firma, mail) {
  const core=alanCekirdegi(mail.split('@')[1]||'');
  const ts=tokenlar(firma);
  if(!core||!ts.length) return 0;
  let p=0;
  for(const t of ts){
    if(t===core) return 100;                       // birebir
    if(t.length>=5 && core.includes(t)) p=Math.max(p,70);
    if(t.length>=4 && core.startsWith(t)) p=Math.max(p,60);
    if(t.length>=4 && core.includes(t)) p=Math.max(p,45);
  }
  const g=norm(firma);
  if(!p && core.length>=6 && g.includes(core)) p=55;
  return p;
}

async function tekillestir(etiketli) {
  const rows = etiketli
    ? await sql`SELECT id, company_name, lower(primary_contact_email) mail FROM leads
                WHERE ${ETIKET}::text = ANY(tags) AND primary_contact_email IS NOT NULL`
    : await sql`SELECT l.id, l.company_name, lower(l.primary_contact_email) mail
                FROM campaign_targets t JOIN leads l ON l.id=t.lead_id
                WHERE t.campaign_id=${C1} AND t.status='queued'`;
  const grup={};
  rows.forEach(r=>(grup[r.mail]=grup[r.mail]||[]).push(r));
  const cok=Object.entries(grup).filter(([,v])=>v.length>1);
  let cikarilacak=[];
  console.log(`\n${etiketli?'KURTARMA PARTISI':'1C KUYRUGU'} — coklu adres: ${cok.length}`);
  for (const [mail,ls] of cok) {
    const puanli=ls.map(l=>({...l,p:puan(l.company_name,mail)})).sort((a,b)=>b.p-a.p);
    console.log(`  ${mail}`);
    if (puanli[0].p === 0) {
      // HICBIRI adresle eslesmiyor → adres bunlarin hicbirine atfedilemez, HEPSINI cikar.
      // ('info@nice-journey.com' 7 alakasiz saglik-turizm firmasina atanmisti)
      puanli.forEach(x=>console.log(`     HEPSI-CIKAR[  0] ${x.company_name}`));
      cikarilacak.push(...puanli.map(x=>x.id));
      continue;
    }
    const tut=puanli[0], at=puanli.slice(1);
    console.log(`     TUT  [${String(tut.p).padStart(3)}] ${tut.company_name}`);
    at.forEach(x=>console.log(`     cikar[${String(x.p).padStart(3)}] ${x.company_name}`));
    cikarilacak.push(...at.map(x=>x.id));
  }
  if (!UYGULA || !cikarilacak.length) return cikarilacak.length;
  if (etiketli) {
    const r=await sql`UPDATE leads SET tags=array_append(array_remove(tags,${ETIKET}::text),'coklu-atama'::text)
      WHERE id = ANY(${cikarilacak}::uuid[])`;
    console.log(`  → partiden cikarilan: ${r.count}`);
  } else {
    const r=await sql`UPDATE campaign_targets SET status='failed', error='coklu-atama: ayni posta kutusuna baska lead gidiyor'
      WHERE campaign_id=${C1} AND status='queued' AND lead_id = ANY(${cikarilacak}::uuid[])`;
    console.log(`  → kuyruktan dusurulen: ${r.count}`);
  }
  return cikarilacak.length;
}

const a=await tekillestir(true);
const b=await tekillestir(false);
console.log(`\ntoplam ${a+b} fazladan gonderim engellendi${UYGULA?'':' (--uygula ile yaz)'}`);
const [n]=await sql`SELECT count(*)::int n FROM leads WHERE ${ETIKET}::text = ANY(tags)`;
console.log(`parti: ${n.n}`);
await sql.end();
