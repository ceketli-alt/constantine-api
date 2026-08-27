#!/usr/bin/env node
/**
 * HAVUZ DISI leadler: hic dokunulmamis, maili var, elenmemis — ama `ist-yeni` /
 * `ist-kurtarma-2026-08` etiketi olmadigi icin autofill onlari HIC GORMUYOR.
 * Bunlarin cogunda site yok, dolayisiyla render edilemiyorlar. Ama site olmadan da
 * sorulabilecek bir soru var: ADRESIN KENDI ALAN ADI firma adiyla ortusuyor mu?
 * (`AKGE TURİZM -> mehmet@ilgiseyahat.com` ortusmez; `info@akgeturizm.com` ortusur.)
 */
import postgres from 'postgres'; import fs from 'node:fs';
import { adAlanEslesmesi } from './lib/kimlik.mjs';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const freemail=new Set((await sql`SELECT domain FROM free_email_domains`).map(r=>r.domain.toLowerCase()));

const r = await sql`
  SELECT id, company_name, primary_contact_email mail, website, city FROM leads l
  WHERE status='new' AND last_contacted_at IS NULL AND primary_contact_email IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM campaign_targets ct WHERE ct.lead_id=l.id)
    AND NOT EXISTS (SELECT 1 FROM unsubscribes u WHERE u.channel='email' AND lower(u.identifier)=lower(l.primary_contact_email))
    AND NOT ('ist-yeni'=ANY(tags) OR 'ist-kurtarma-2026-08'=ANY(tags))
    AND NOT ('kimlik-dogrulanamadi'=ANY(tags) OR 'mx-riskli'=ANY(tags) OR 'coklu-atama'=ANY(tags)
          OR 'mail-sahte'=ANY(tags) OR 'seg-irrelevant'=ANY(tags) OR 'cikmis-liste'=ANY(tags))`;

const say={tam:0,kismi:0,yok:0,bedava:0};
const tamlar=[];
for (const l of r) {
  const d=(l.mail.split('@')[1]||'').toLowerCase();
  if (freemail.has(d)) { say.bedava++; continue; }
  const e=adAlanEslesmesi(l.company_name,d);
  say[e]++;
  if (e==='tam') tamlar.push(l);
}
console.log(`havuz disi uygun lead: ${r.length}`);
console.log(`  bedava-mail (kurumsal kampanyaya giremez): ${say.bedava}`);
console.log(`  adres firmanin KENDI alan adinda ('tam') : ${say.tam}   <-- aday`);
console.log(`  kismi: ${say.kismi}   ortusmuyor: ${say.yok}`);
// ayni kutuya birden cok firma var mi?
const kutu={};
for (const l of tamlar) (kutu[l.mail.toLowerCase()] ||= []).push(l.company_name);
const coklu=Object.entries(kutu).filter(([,v])=>v.length>1);
console.log(`  bunlarin icinde ayni adresi paylasan: ${coklu.length} adres`);
console.log(`\nornekler:`);
for (const l of tamlar.slice(0,12)) console.log(`  ${(l.company_name||'').slice(0,34).padEnd(34)} ${l.mail}`);
const esc=v=>/[",\n]/.test(String(v??''))?`"${String(v).replace(/"/g,'""')}"`:String(v??'');
fs.writeFileSync('/root/acente-data-2026-08/HAVUZ-DISI-TAM.csv',
  'lead_id,firma,mail,site,sehir\n'+tamlar.map(l=>[l.id,l.company_name,l.mail,l.website||'',l.city||''].map(esc).join(',')).join('\n')+'\n');
console.log('\n-> HAVUZ-DISI-TAM.csv');
await sql.end();
