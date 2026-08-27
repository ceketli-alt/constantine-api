#!/usr/bin/env node
/**
 * GOREV 2-C — kimlik beyaniyla dogrulanan siteler; elde karara baglandi (26 Agu).
 * Cogunda MEVCUT adres zaten dogru cikti (site kimligi onu teyit etti) → sadece etiket.
 */
import postgres from 'postgres';
import fs from 'node:fs';
const ETIKET='ist-kurtarma-2026-08';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
  .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);

// site kimligi dogrulandi → mevcut adres korunur, lead partiye alinir
const KABUL_ETIKET=['alturkishtourism.com','phoenixtur.com','alharamainug.com','seagenesisgroup.com',
                    'bluemaptur.com','recitalhotels.com','eliteworldhotels.com.tr'];
// site kendini farkli bir marka olarak beyan ediyor → gercek duzeltme
const KABUL_DEGISTIR={'laturchia.com':'info@adelphiatours.com'};   // site "Adelphia Tours" diyor
// gerekceli redler
const RED={'essahra.com.tr':'site ev/dekorasyon isi beyan ediyor (essahrahome@), acente degil',
           'merkurgroup.com.tr':'Merkur Holding — turizm kolu oldugu kanitlanamadi',
           'atraxiahealthgroup.com':'uc ayri alan adi (atraxia.com/atraxiatr.com/…), hangisi dogru belirsiz',
           'ozdesturizm.com':'her iki adres de bedava-mail, kurumsal kampanyaya giremez'};

const rows=fs.readFileSync('/root/acente-data-2026-08/GOREV2-KARAR.csv','utf8').split(/\r?\n/).slice(1)
  .filter(Boolean).map(l=>{const p=l.split(','); return {id:p[0],firma:p[1],domain:p[2],eski:(p[3]||'').trim()};});

let t=0,d=0;
for (const r of rows) {
  if (KABUL_ETIKET.includes(r.domain)) {
    const q=await sql`UPDATE leads SET tags = CASE WHEN ${ETIKET}::text = ANY(tags) THEN tags
      ELSE array_append(tags,${ETIKET}::text) END WHERE id=${r.id}::uuid`;
    t+=q.count;
  } else if (KABUL_DEGISTIR[r.domain]) {
    const yeni=KABUL_DEGISTIR[r.domain];
    const q=await sql`UPDATE leads SET primary_contact_email=${yeni}::text,
      source_meta = coalesce(source_meta,'{}'::jsonb) || jsonb_build_object(
        'email_history', coalesce(source_meta->'email_history','[]'::jsonb) ||
          jsonb_build_array(jsonb_build_object('eski',${r.eski}::text,'yeni',${yeni}::text,
            'kaynak','gorev2c-site-kimligi-2026-08-26'::text))),
      tags = CASE WHEN ${ETIKET}::text = ANY(tags) THEN tags ELSE array_append(tags,${ETIKET}::text) END,
      updated_at=now() WHERE id=${r.id}::uuid`;
    d+=q.count;
    fs.appendFileSync('/root/acente-data-2026-08/MAIL-DUZELTME-IZI.csv',
      `\n${r.id},${r.eski},${yeni},${r.firma},${r.domain},GOREV2C`);
  }
}
console.log(`etiketlenen (mevcut adres dogrulandi): ${t}`);
console.log(`mail duzeltilen                      : ${d}`);
console.log(`gerekceyle reddedilen                : ${Object.keys(RED).length}`);
const [a]=await sql`SELECT count(*)::int n FROM leads WHERE ${ETIKET}::text = ANY(tags)`;
console.log(`parti toplam: ${a.n}`);
await sql.end();
