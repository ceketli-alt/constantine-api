#!/usr/bin/env node
/**
 * PARTI DENETCISI — her toplu yazmadan SONRA kosulur.
 *
 * 26 Agu 2026: sekiz hatanin sekizi de "bakinca" bulundu, hicbiri kendiliginden
 * ortaya cikmadi. Bu dosya o bakislari SORULARA cevirir; artik her seferinde
 * ayni sorular sorulur. En degerlisi 7. soru — tek tek kayitlara bakarak asla
 * bulunamayacak olan CAPRAZ soru ("ayni adrese kac firma bagli?").
 *
 * Kullanim: node parti-denetle.mjs <etiket> [kampanya_id]
 */
import postgres from 'postgres';
import fs from 'node:fs';
import { adAlanEslesmesi } from './lib/kimlik.mjs';

const ETIKET = process.argv[2] || 'ist-kurtarma-2026-08';
const KAMPANYA = process.argv[3] || null;
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
  .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);

let hata=0, uyari=0;
const kontrol=(ad,n,seviye='HATA',detay='')=>{
  const ok=n===0;
  if(!ok && seviye==='HATA') hata++; if(!ok && seviye==='UYARI') uyari++;
  console.log(`  ${ok?'✓':(seviye==='HATA'?'✗':'!')} ${ad.padEnd(46)}${String(n).padStart(5)}${detay?'  '+detay:''}`);
};

const leadler = await sql`
  SELECT id, company_name, lower(primary_contact_email) mail, tags
  FROM leads WHERE ${ETIKET}::text = ANY(tags)`;
console.log(`\n=== PARTI DENETIMI: ${ETIKET} (${leadler.length} lead) ===\n`);

// 1 — bos/bozuk adres
kontrol('1. maili bos veya bozuk', leadler.filter(l=>!l.mail||!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(l.mail)).length);

// 2 — cikmis
const [c]=await sql`SELECT count(*)::int n FROM leads l WHERE ${ETIKET}::text=ANY(l.tags)
  AND EXISTS(SELECT 1 FROM unsubscribes u WHERE u.channel='email' AND lower(u.identifier)=lower(l.primary_contact_email))`;
kontrol('2. cikmis listesinde (unsubscribe)', c.n);

// 3 — zaten kampanyada
const [k]=await sql`SELECT count(*)::int n FROM leads l WHERE ${ETIKET}::text=ANY(l.tags)
  AND EXISTS(SELECT 1 FROM campaign_targets t WHERE t.lead_id=l.id)`;
kontrol('3. zaten bir kampanyada', k.n, 'UYARI');

// 4 — triaj disi durum
kontrol('4. mx-riskli isaretli oldugu halde partide', leadler.filter(l=>l.tags?.includes('mx-riskli')).length);
kontrol('5. coklu-atama isaretli oldugu halde partide', leadler.filter(l=>l.tags?.includes('coklu-atama')).length);
kontrol('6. mail-sahte isaretli oldugu halde partide', leadler.filter(l=>l.tags?.includes('mail-sahte')).length);

// 7 — CAPRAZ SORU: bir adres kac firmaya bagli?
const grup={}; leadler.forEach(l=>l.mail&&(grup[l.mail]=grup[l.mail]||[]).push(l.company_name));
const coklu=Object.entries(grup).filter(([,v])=>v.length>1);
kontrol('7. ayni adrese birden cok firma  ← CAPRAZ', coklu.length);
coklu.slice(0,5).forEach(([m,v])=>console.log(`        ${v.length}x ${m}  ${v.slice(0,3).join(' | ').slice(0,60)}`));

// 8 — adres firmayla ortusuyor mu (ornekleme degil, tamami)
// 'unvan-dogrulandi': marka adi ile ticaret unvani farkli ama RESMI AD sitede
// bulundu (KVKK/sozlesme sayfasindan). Turk acentelerinde rutin; uyari sayilmaz.
const uyumsuz=leadler.filter(l=>l.mail && !l.tags?.includes('unvan-dogrulandi')
  && adAlanEslesmesi(l.company_name,(l.mail.split('@')[1]||''))==='yok');
kontrol('8. adres firmayla ortusmuyor (unvan da yok)', uyumsuz.length, 'UYARI');
uyumsuz.slice(0,5).forEach(l=>console.log(`        ${(l.company_name||'').slice(0,34).padEnd(34)} ${l.mail}`));

// 9 — kampanya kuyrugu verildiyse orada da capraz sor
if (KAMPANYA) {
  const q=await sql`SELECT lower(l.primary_contact_email) mail, count(*)::int n
    FROM campaign_targets t JOIN leads l ON l.id=t.lead_id
    WHERE t.campaign_id=${KAMPANYA} AND t.status='queued'
    GROUP BY 1 HAVING count(*)>1`;
  kontrol('9. kampanya kuyrugunda coklu adres', q.length);
}

console.log(`\n${hata===0?'✅ HATA YOK':'❌ '+hata+' HATA'}${uyari?`  ·  ${uyari} uyari`:''}`);
await sql.end();
process.exit(hata ? 1 : 0);
