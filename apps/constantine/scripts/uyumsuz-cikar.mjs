import postgres from 'postgres'; import fs from 'node:fs';
import { adAlanEslesmesi } from '/var/www/api/apps/constantine/scripts/lib/kimlik.mjs';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const r=await sql`SELECT id, company_name, primary_contact_email mail, website, tags FROM leads
  WHERE 'ist-kurtarma-2026-08'=ANY(tags) AND primary_contact_email IS NOT NULL`;
const u=r.filter(l=>!l.tags?.includes('unvan-dogrulandi')
  && adAlanEslesmesi(l.company_name,(l.mail.split('@')[1]||''))==='yok');
const esc=v=>/[",\n]/.test(String(v??''))?`"${String(v).replace(/"/g,'""')}"`:String(v??'');
fs.writeFileSync('/root/acente-data-2026-08/UYUMSUZ-leadler.csv',
 'lead_id,firma,domain,eski_mail\n'+u.map(l=>[l.id,l.company_name,(l.mail.split('@')[1]||''),l.mail].map(esc).join(',')).join('\n')+'\n');
console.log(`${u.length} uyumsuz lead -> UYUMSUZ-leadler.csv`);
for(const l of u) console.log('  ',(l.company_name||'').slice(0,36).padEnd(36), l.mail);
await sql.end();
