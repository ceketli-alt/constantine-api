#!/usr/bin/env node
/** Partideki ÇIKMIŞ (unsubscribe) leadleri isaretleyip cikarir. Mail atilmasi hem yanlis hem riskli. */
import postgres from 'postgres'; import fs from 'node:fs';
const ETIKET = process.argv[2] || 'ist-kurtarma-2026-08';
const UYGULA = process.argv.includes('--uygula');
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const r=await sql`
  SELECT l.id, l.company_name, l.primary_contact_email mail, u.created_at cikis
  FROM leads l JOIN unsubscribes u ON u.channel='email'
    AND lower(u.identifier)=lower(l.primary_contact_email)
  WHERE ${ETIKET}::text = ANY(l.tags)`;
for (const x of r) console.log(`  ${(x.company_name||'').slice(0,32).padEnd(32)} ${x.mail}  (cikis: ${x.cikis?.toISOString?.().slice(0,10)})`);
if (UYGULA) {
  for (const x of r) await sql`UPDATE leads SET tags = array_remove(
      CASE WHEN 'cikmis-liste' = ANY(tags) THEN tags ELSE array_append(tags,'cikmis-liste') END,
      ${ETIKET}::text), updated_at=now() WHERE id=${x.id}::uuid`;
  console.log(`\n${r.length} lead partiden cikarildi ('cikmis-liste')`);
} else console.log(`\n${r.length} lead — (--uygula ile cikarilir)`);
await sql.end();
