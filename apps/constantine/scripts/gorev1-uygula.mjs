#!/usr/bin/env node
/**
 * GOREV 1 sonucunu uygular — elde dogrulanan 49 aday alan adi.
 *
 * Koruma kurallari (H1/H2), H2 bu sefer YONLU:
 *   H1  eski adres zaten firmanin alan adindaysa DOKUNMA
 *   H2a ayni alan icinde ISIMLI kisi → jenerik kutu  : ENGELLE (soguk erisimde kotu takas)
 *   H2b ayni alan icinde jenerik → ISIMLI kisi       : IZIN VER (iyilestirme)
 */
import postgres from 'postgres';
import fs from 'node:fs';
const ETIKET='ist-kurtarma-2026-08';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
  .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);

const ROL=new Set(['info','bilgi','iletisim','contact','sales','satis','rezervasyon','reservation',
 'reservations','booking','operation','operasyon','muhasebe','destek','support','office','admin',
 'mail','hello','team','finance','finans','kurumsal','kalite']);
const GEN=new Set(['turizm','tur','tour','tours','seyahat','acenta','acentasi','acentesi','travel',
 'tourism','trip','holiday','holidays','tatil','journey','agency','ltd','sti','as','group','grup',
 'international','global','world','istanbul','turkey','turkiye','hotel','hotels','com','health','tourism']);
const norm=s=>(s||'').replace(/İ/g,'i').replace(/I/g,'i').replace(/ı/g,'i').replace(/Ş/g,'s').replace(/ş/g,'s')
 .replace(/Ğ/g,'g').replace(/ğ/g,'g').replace(/Ü/g,'u').replace(/ü/g,'u').replace(/Ö/g,'o').replace(/ö/g,'o')
 .replace(/Ç/g,'c').replace(/ç/g,'c').toLowerCase().replace(/[^a-z0-9]/g,'');
const eslesir=(firma,dom)=>{
  const core=norm((dom||'').split('.')[0]); const g=norm(firma);
  const ts=(firma||'').split(/[\s.\-_/&,()]+/).map(norm).filter(t=>t.length>=3&&!GEN.has(t));
  if(!core||!ts.length) return false;
  for(const t of ts){ if(t===core) return true;
    if(t.length>=4&&(t.includes(core)||core.includes(t))) return true;
    if(t.length===3&&core.startsWith(t)) return true; }
  return core.length>=5&&g.includes(core);
};

const rows=fs.readFileSync('/root/acente-data-2026-08/GOREV1-SONUC.csv','utf8').split(/\r?\n/).slice(1)
  .filter(Boolean).map(l=>{const p=l.split(','); return {id:p[0],firma:p[1],domain:p[2],eski:(p[3]||'').trim(),yeni:(p[4]||'').trim(),karar:p[5]};})
  .filter(r=>r.karar==='EVET' && r.yeni);

const mxRiskli=new Set((await sql`SELECT id FROM leads WHERE 'mx-riskli'::text = ANY(tags)`).map(r=>r.id));
let d=0,t=0,blok=0;
for (const r of rows) {
  if (mxRiskli.has(r.id)) { blok++; continue; }
  const eD=(r.eski.split('@')[1]||'').toLowerCase(), yD=(r.yeni.split('@')[1]||'').toLowerCase();
  const eL=(r.eski.split('@')[0]||'').toLowerCase(), yL=(r.yeni.split('@')[0]||'').toLowerCase();
  let degistir = r.eski.toLowerCase()!==r.yeni.toLowerCase();
  if (degistir && eD===yD) {                       // ayni alan → yonlu kural
    const eskiIsimli=!ROL.has(eL), yeniIsimli=!ROL.has(yL);
    if (eskiIsimli && !yeniIsimli) { degistir=false; blok++; }   // H2a: isimli→jenerik ENGELLE
  }
  if (degistir && eD && eslesir(r.firma,eD) && !eslesir(r.firma,yD)) { degistir=false; blok++; } // H1

  if (!degistir) {
    const q=await sql`UPDATE leads SET tags = CASE WHEN ${ETIKET}::text = ANY(tags) THEN tags
      ELSE array_append(tags,${ETIKET}::text) END WHERE id=${r.id}::uuid`;
    t+=q.count; continue;
  }
  const q=await sql`
    UPDATE leads SET primary_contact_email=${r.yeni}::text,
      source_meta = coalesce(source_meta,'{}'::jsonb) || jsonb_build_object(
        'email_history', coalesce(source_meta->'email_history','[]'::jsonb) ||
          jsonb_build_array(jsonb_build_object('eski',${r.eski}::text,'yeni',${r.yeni}::text,
            'kaynak','gorev1-elde-dogrulama-2026-08-26'::text,'domain',${r.domain}::text))),
      tags = CASE WHEN ${ETIKET}::text = ANY(tags) THEN tags ELSE array_append(tags,${ETIKET}::text) END,
      updated_at=now() WHERE id=${r.id}::uuid`;
  d+=q.count;
  fs.appendFileSync('/root/acente-data-2026-08/MAIL-DUZELTME-IZI.csv',
    `\n${r.id},${r.eski},${r.yeni},${r.firma},${r.domain},GOREV1`);
}
console.log(`EVET satiri: ${rows.length}`);
console.log(`  mail duzeltildi : ${d}`);
console.log(`  sadece etiket   : ${t}`);
console.log(`  koruma engelledi: ${blok}`);
const [a]=await sql`SELECT count(*)::int n FROM leads WHERE ${ETIKET}::text = ANY(tags)`;
console.log(`parti toplam: ${a.n}`);
await sql.end();
