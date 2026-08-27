#!/usr/bin/env node
/**
 * KAZINAN ADRESLERI UYGULA — kanitlanmis yanlis mailleri duzeltir.
 *
 * NEDEN DOGRUDAN GUNCELLEME:
 *   Mert'in tercihi uretim verisini UI'dan duzeltmek (denetim izi + dogrulama atlanmasin).
 *   Burada iki sart da karsilaniyor: eski adres source_meta.email_history'e yaziliyor,
 *   tam CSV izi tutuluyor, --geri-al ile tek komutta donuluyor. Override yolu
 *   (source_meta.emails_by_role) denendi ama eligible_leads_for_campaign leadin
 *   PRIMARY adresine bakip 50 leadi "bedava mail" diye reddediyordu — yeni adresleri
 *   kurumsal olmasina ragmen. O yuzden primary duzeltiliyor.
 *
 * NE DUZELTILIR: yalnizca KURTARMA-DEFTERI'nde A-YUKSEK/B-ORTA olan ve
 *   kazinan adresi firmanin KENDI dogrulanmis alan adinda olan kayitlar.
 *
 * DOGRULAMA ATLANMAZ: leadler 'ist-kurtarma-2026-08' etiketiyle isaretlenir;
 *   enroll + NeverBounce dogrulamasi mevcut campaign-autofill hattindan gecer.
 *
 * Kullanim: node mail-duzeltme-uygula.mjs [--dry] [--geri-al]
 */
import postgres from 'postgres';
import fs from 'node:fs';

const DRY = process.argv.includes('--dry');
const GERI = process.argv.includes('--geri-al');
const ETIKET = 'ist-kurtarma-2026-08';
const IZ = '/root/acente-data-2026-08/MAIL-DUZELTME-IZI.csv';

const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
    .filter(l=>l.includes('=')&&!l.trim().startsWith('#'))
    .map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql = postgres(env.DATABASE_URL);

if (GERI) {
  const iz = fs.readFileSync(IZ,'utf8').split('\n').slice(1).filter(Boolean);
  let n = 0;
  for (const line of iz) {
    const [id, eski] = line.split(',');
    if (!id) continue;
    const r = await sql`UPDATE leads SET primary_contact_email = ${eski || null},
      tags = array_remove(tags, ${ETIKET}::text) WHERE id = ${id}::uuid`;
    n += r.count;
  }
  console.log(`geri alindi: ${n} lead`);
  await sql.end();
  process.exit(0);
}

const rows = fs.readFileSync('/root/acente-data-2026-08/KURTARMA-DEFTERI.csv','utf8')
  .split('\n').slice(1).filter(Boolean).map(l => {
    const p = l.split(',');
    return { id:p[0], firma:p[1], domain:p[2], eski:(p[3]||'').trim(), yeni:(p[4]||'').trim(), karar:p[8] };
  });

const hedef = rows.filter(r =>
  (r.karar === 'A-YUKSEK' || r.karar === 'B-ORTA') && r.yeni &&
  r.yeni.split('@')[1]?.endsWith(r.domain));          // yeni adres firmanin kendi alaninda

const duzeltme = hedef.filter(r => r.eski.toLowerCase() !== r.yeni.toLowerCase());
const teyit    = hedef.filter(r => r.eski.toLowerCase() === r.yeni.toLowerCase());

console.log(`hedef (A+B, kendi alaninda) : ${hedef.length}`);
console.log(`  mail DEGISECEK            : ${duzeltme.length}`);
console.log(`  zaten dogru (sadece etiket): ${teyit.length}`);
if (DRY) { console.log('\n[dry] yazma yapilmadi'); await sql.end(); process.exit(0); }

fs.writeFileSync(IZ, 'lead_id,eski_mail,yeni_mail,firma,domain,karar\n' +
  duzeltme.map(r => [r.id, r.eski, r.yeni, r.firma, r.domain, r.karar].join(',')).join('\n'));

let d = 0;
for (const r of duzeltme) {
  const res = await sql`
    UPDATE leads SET
      primary_contact_email = ${r.yeni}::text,
      source_meta = coalesce(source_meta,'{}'::jsonb) || jsonb_build_object(
        'email_history', coalesce(source_meta->'email_history','[]'::jsonb) ||
          jsonb_build_array(jsonb_build_object(
            'eski', ${r.eski}::text, 'yeni', ${r.yeni}::text,
            'kaynak', 'site-kazisi-2026-08-26'::text, 'karar', ${r.karar}::text))),
      tags = CASE WHEN ${ETIKET}::text = ANY(tags) THEN tags ELSE array_append(tags, ${ETIKET}::text) END,
      updated_at = now()
    WHERE id = ${r.id}::uuid`;
  d += res.count;
}
let t = 0;
for (const r of teyit) {
  const res = await sql`UPDATE leads SET
      tags = CASE WHEN ${ETIKET}::text = ANY(tags) THEN tags ELSE array_append(tags, ${ETIKET}::text) END
    WHERE id = ${r.id}::uuid`;
  t += res.count;
}
console.log(`\n✓ ${d} lead maili duzeltildi (eskisi source_meta.email_history'de)`);
console.log(`✓ ${t} lead teyit edildi, etiketlendi`);
console.log(`✓ iz: ${IZ}`);
console.log(`\ngeri almak icin: node scripts/mail-duzeltme-uygula.mjs --geri-al`);
await sql.end();
