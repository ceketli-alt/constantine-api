#!/usr/bin/env node
/** Bir kampanya kuyrugunun kimlik kalitesi — kredi harcamadan, yalnizca ad<->alan adi. */
import postgres from 'postgres'; import fs from 'node:fs';
import { adAlanEslesmesi } from './lib/kimlik.mjs';
const KAMPANYA = process.argv[2];
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const r = await sql`
  SELECT l.company_name firma, lower(l.primary_contact_email) mail, l.tags
  FROM campaign_targets t JOIN leads l ON l.id=t.lead_id
  WHERE t.campaign_id=${KAMPANYA} AND t.status='queued' AND l.primary_contact_email IS NOT NULL`;
const say={tam:0,kismi:0,yok:0}; const ornek=[];
for (const x of r) {
  if (x.tags?.includes('unvan-dogrulandi')) { say.tam++; continue; }
  const e = adAlanEslesmesi(x.firma, x.mail.split('@')[1]||'');
  say[e]++;
  if (e==='yok' && ornek.length<10) ornek.push(`${(x.firma||'').slice(0,30).padEnd(30)} ${x.mail}`);
}
const t=r.length;
console.log(`kuyruk ${t} · adres firmanin kendi alan adinda: ${say.tam} (%${(say.tam*100/t).toFixed(0)})`);
console.log(`  kismi ${say.kismi} · ORTUSMUYOR ${say.yok} (%${(say.yok*100/t).toFixed(0)})`);
console.log('\nortusmeyenlerden ornekler:');
ornek.forEach(o=>console.log('  '+o));
await sql.end();
