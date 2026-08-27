#!/usr/bin/env node
/**
 * HAVUZ-DISI-TAM.csv'deki leadleri kurtarma partisine alir.
 * Olcut: adres firmanin KENDI alan adinda (adAlanEslesmesi === 'tam') — 61+64 KORU
 * kararlarinda kullanilan olcutun AYNISI. Segment tamami `agroup_agency`, kaynak TURSAB.
 * KENDI grup sirketlerimiz haric tutulur.
 */
import postgres from 'postgres'; import fs from 'node:fs';
const UYGULA=process.argv.includes('--uygula');
const ETIKET='ist-kurtarma-2026-08';
const KENDI=/asttourism|acetes|bosphorussunset|constantine/i;   // kendi grubumuza mail atmayalim
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const satir=fs.readFileSync('/root/acente-data-2026-08/HAVUZ-DISI-TAM.csv','utf8').split(/\r?\n/).slice(1).filter(Boolean);
const ids=[], atlanan=[];
for (const l of satir) {
  const p=l.split(',');
  if (KENDI.test(l)) { atlanan.push(p[1]); continue; }
  if (p[0]?.length===36) ids.push(p[0]);
}
console.log(`aday: ${satir.length}  ·  kendi grubumuz diye atlanan: ${atlanan.length} ${atlanan.join(', ')}`);
console.log(`partiye alinacak: ${ids.length}`);
if (UYGULA) {
  const q=await sql`UPDATE leads SET tags = CASE WHEN ${ETIKET}::text = ANY(tags) THEN tags
    ELSE array_append(tags, ${ETIKET}::text) END, updated_at=now()
    WHERE id = ANY(${ids}::uuid[])`;
  console.log(`etiketlenen: ${q.count}`);
  const [a]=await sql`SELECT count(*)::int n FROM leads WHERE ${ETIKET}::text = ANY(tags)`;
  console.log(`parti toplam: ${a.n}`);
} else console.log('(--uygula ile yazilir)');
await sql.end();
