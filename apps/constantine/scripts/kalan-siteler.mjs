#!/usr/bin/env node
/** Hic dokunulmamis + siteli leadlerden HENUZ RENDER EDILMEMIS alan adlarini cikarir. */
import postgres from 'postgres'; import fs from 'node:fs';
const DIR='/root/acente-data-2026-08';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);

const dom = (u) => (u||'').trim().toLowerCase()
  .replace(/^https?:\/\//,'').split('/')[0].split(':')[0].replace(/^www\./,'');

const leadler = await sql`
  SELECT id, company_name, website, primary_contact_email, tags FROM leads
  WHERE website IS NOT NULL AND website<>'' AND status='new' AND last_contacted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM campaign_targets ct WHERE ct.lead_id=leads.id)
    AND NOT ('kimlik-dogrulanamadi'=ANY(tags) OR 'mx-riskli'=ANY(tags)
          OR 'coklu-atama'=ANY(tags) OR 'mail-sahte'=ANY(tags) OR 'seg-irrelevant'=ANY(tags)
          OR 'cikmis-liste'=ANY(tags) OR 'ist-kurtarma-2026-08'=ANY(tags))`;

const yapilan = new Set();
for (const f of ['RENDER-KAZI.csv','RENDER-ARAMA.csv']) {
  try { fs.readFileSync(`${DIR}/${f}`,'utf8').split(/\r?\n/).slice(1)
        .forEach(l => { const d=l.split(',')[0]; if (d) yapilan.add(d.trim().toLowerCase()); }); } catch {}
}
const satir=[], domainler=new Set();
for (const l of leadler) {
  const d = dom(l.website);
  if (!d || d.includes(' ') || !d.includes('.')) continue;
  if (yapilan.has(d)) continue;
  domainler.add(d);
  satir.push([l.id, l.company_name, d, l.primary_contact_email||'']);
}
const esc=v=>/[",\n]/.test(String(v??''))?`"${String(v).replace(/"/g,'""')}"`:String(v??'');
fs.writeFileSync(`${DIR}/KALAN-leadler.csv`,
  'lead_id,firma,domain,eski_mail\n'+satir.map(r=>r.map(esc).join(',')).join('\n')+'\n');
fs.writeFileSync(`${DIR}/KALAN-DOMAINLER.txt`, [...domainler].sort().join('\n')+'\n');
console.log(`dokunulmamis siteli lead: ${leadler.length}`);
console.log(`  daha once render edilmis alan adi atlandi`);
console.log(`  KALAN: ${satir.length} lead / ${domainler.size} tekil alan adi`);
await sql.end();
