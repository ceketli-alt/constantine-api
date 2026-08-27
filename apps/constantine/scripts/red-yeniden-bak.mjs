#!/usr/bin/env node
/**
 * KURAL DUZELDIYSE ESKI REDLERI YENIDEN OKU.
 * `jenerikSiyir` hatasi ('tur' once denenince 'tourism'den geriye 'ism' kaliyordu) ve
 * "tum ayirt edici kelimeler alan adinda" kurali, 26 Agu aksami DAHA ONCE verilmis
 * redlerden sonra eklendi. Bozuk kuralla elenmis lead var mi diye bakar.
 */
import postgres from 'postgres'; import fs from 'node:fs';
import { adAlanEslesmesi } from './lib/kimlik.mjs';
const UYGULA = process.argv.includes('--uygula');
const ETIKET = 'ist-kurtarma-2026-08';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const freemail=new Set((await sql`SELECT domain FROM free_email_domains`).map(r=>r.domain.toLowerCase()));

const red = await sql`
  SELECT id, company_name, primary_contact_email mail, tags FROM leads
  WHERE 'kimlik-dogrulanamadi' = ANY(tags) AND primary_contact_email IS NOT NULL`;
console.log(`${red.length} 'kimlik-dogrulanamadi' leadi yeniden okunuyor`);

const geri = red.filter(l => {
  const d = (l.mail.split('@')[1]||'').toLowerCase();
  if (!d || freemail.has(d)) return false;
  return adAlanEslesmesi(l.company_name, d) === 'tam';   // duzelmis kuralla artik TUTUYOR
});
console.log(`\nduzelmis kuralla artik firmanin KENDI alan adinda gorunen: ${geri.length}`);
for (const l of geri) console.log(`  ${(l.company_name||'').slice(0,36).padEnd(36)} ${l.mail}`);

if (UYGULA && geri.length) {
  for (const l of geri) {
    await sql`UPDATE leads SET tags = array_remove(
        CASE WHEN ${ETIKET}::text = ANY(tags) THEN tags ELSE array_append(tags, ${ETIKET}::text) END,
        'kimlik-dogrulanamadi'), updated_at=now() WHERE id=${l.id}::uuid`;
  }
  console.log(`\n${geri.length} lead partiye geri alindi`);
} else if (geri.length) console.log('\n(--uygula ile geri alinir)');
await sql.end();
