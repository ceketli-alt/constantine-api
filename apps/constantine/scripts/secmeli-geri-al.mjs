#!/usr/bin/env node
/**
 * SECMELI GERI ALMA — duzeltme denetiminde GERILEME cikan kayitlari eski haline dondurur.
 * H1: eski adres zaten firmanin alan adindaydi, baska alana tasinmisti
 * H2: ayni alan icinde isimli muhatap jenerik kutuya cevrilmisti (soguk erisimde kotu takas)
 * Etiket KORUNUR — leadler kurtarma partisinde kalmali, sadece adres geri doner.
 */
import postgres from 'postgres';
import fs from 'node:fs';
const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
    .filter(l=>l.includes('=')&&!l.trim().startsWith('#'))
    .map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql = postgres(env.DATABASE_URL);

const rows = fs.readFileSync('/root/acente-data-2026-08/GERI-ALINACAK.csv','utf8')
  .split('\n').slice(1).filter(Boolean).map(l=>{const p=l.split(','); return {tip:p[0],id:p[1],eski:p[2],yanlis:p[3]};});

let n=0;
for (const r of rows) {
  const res = await sql`
    UPDATE leads SET primary_contact_email = ${r.eski}::text,
      source_meta = coalesce(source_meta,'{}'::jsonb) || jsonb_build_object(
        'email_history', coalesce(source_meta->'email_history','[]'::jsonb) ||
          jsonb_build_array(jsonb_build_object(
            'geri_alindi', ${r.yanlis}::text, 'donulen', ${r.eski}::text,
            'sebep', ${r.tip}::text, 'tarih', '2026-08-26'::text))),
      updated_at = now()
    WHERE id = ${r.id}::uuid AND primary_contact_email = ${r.yanlis}::text`;
  n += res.count;
}
console.log(`geri alinan: ${n}/${rows.length}`);
const [a] = await sql`SELECT count(*)::int n FROM leads WHERE 'ist-kurtarma-2026-08'=ANY(tags)`;
console.log(`etiketli lead (degismemeli): ${a.n}`);
await sql.end();
