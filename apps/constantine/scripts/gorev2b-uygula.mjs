#!/usr/bin/env node
/**
 * GOREV 2-B uygulama — GOREV2B-KARAR.csv'deki kararlari CRM'e yazar.
 *   KORU-ETIKETLE  sadece etiket (mevcut adres dogru)
 *   DEGISTIR       primary_contact_email guncellenir; ESKI ADRES source_meta.email_history'de kalir
 * Geri alma: node gorev2b-uygula.mjs --geri-al
 */
import postgres from 'postgres';
import fs from 'node:fs';
const DIR = '/root/acente-data-2026-08';
const ETIKET = 'ist-kurtarma-2026-08';
const KAYNAK = 'gorev2b-render-2026-08-26';
const GERI = process.argv.includes('--geri-al');
const env = Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sql = postgres(env.DATABASE_URL);

function csvOku(yol) {
  const metin = fs.readFileSync(yol, 'utf8'); const satir = [];
  let alan = '', kayit = [], tirnak = false;
  for (let i = 0; i < metin.length; i++) { const c = metin[i];
    if (tirnak) { if (c === '"') { if (metin[i+1] === '"') { alan += '"'; i++; } else tirnak = false; } else alan += c; }
    else if (c === '"') tirnak = true;
    else if (c === ',') { kayit.push(alan); alan = ''; }
    else if (c === '\n') { kayit.push(alan.replace(/\r$/, '')); satir.push(kayit); kayit = []; alan = ''; }
    else alan += c; }
  if (alan || kayit.length) { kayit.push(alan); satir.push(kayit); }
  const bas = satir.shift();
  return satir.filter(r => r.length > 1).map(r => Object.fromEntries(bas.map((b, i) => [b, r[i] ?? ''])));
}

const kararlar = csvOku(`${DIR}/GOREV2B-KARAR.csv`);

if (GERI) {
  let n = 0;
  for (const r of kararlar.filter(x => x.karar === 'DEGISTIR')) {
    const q = await sql`UPDATE leads SET primary_contact_email=${r.eski_mail || null},
      tags = array_remove(tags, ${ETIKET}::text), updated_at=now()
      WHERE id=${r.lead_id}::uuid AND primary_contact_email=${r.yeni_mail}::text`;
    n += q.count;
  }
  for (const r of kararlar.filter(x => x.karar === 'KORU-ETIKETLE')) {
    await sql`UPDATE leads SET tags = array_remove(tags, ${ETIKET}::text) WHERE id=${r.lead_id}::uuid`;
  }
  console.log(`geri alinan mail: ${n}`); await sql.end(); process.exit(0);
}

let t = 0, d = 0;
for (const r of kararlar) {
  if (r.karar === 'KORU-ETIKETLE') {
    const q = await sql`UPDATE leads SET tags = CASE WHEN ${ETIKET}::text = ANY(tags) THEN tags
      ELSE array_append(tags, ${ETIKET}::text) END, updated_at=now() WHERE id=${r.lead_id}::uuid`;
    t += q.count;
  } else if (r.karar === 'DEGISTIR' && r.yeni_mail) {
    const q = await sql`UPDATE leads SET primary_contact_email=${r.yeni_mail}::text,
      source_meta = coalesce(source_meta,'{}'::jsonb) || jsonb_build_object(
        'email_history', coalesce(source_meta->'email_history','[]'::jsonb) ||
          jsonb_build_array(jsonb_build_object('eski', ${r.eski_mail || ''}::text,
            'yeni', ${r.yeni_mail}::text, 'kaynak', ${KAYNAK}::text))),
      tags = CASE WHEN ${ETIKET}::text = ANY(tags) THEN tags ELSE array_append(tags, ${ETIKET}::text) END,
      updated_at=now() WHERE id=${r.lead_id}::uuid`;
    d += q.count;
    fs.appendFileSync(`${DIR}/MAIL-DUZELTME-IZI.csv`,
      `\n${r.lead_id},${r.eski_mail},${r.yeni_mail},"${r.firma.replace(/"/g,'""')}",${r.site},GOREV2B`);
  }
}
console.log(`etiketlenen (mevcut adres dogrulandi): ${t}`);
console.log(`mail duzeltilen (render'dan)         : ${d}`);
const [a] = await sql`SELECT count(*)::int n FROM leads WHERE ${ETIKET}::text = ANY(tags)`;
console.log(`parti toplam: ${a.n}`);
await sql.end();
