#!/usr/bin/env node
/**
 * s1_match duzeltmesinden sonra A/B'ye yukselen ama partide olmayan leadleri ekler.
 * Ayni koruma kurallari uygulanir:
 *   H1 eski adres zaten firmanin alan adindaysa DOKUNMA
 *   H2 ayni alan icinde rol takasi YAPMA
 */
import postgres from 'postgres';
import fs from 'node:fs';
const ETIKET='ist-kurtarma-2026-08';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
  .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);

const GENERIC=new Set(['turizm','tur','tour','tours','seyahat','acenta','acentasi','acentesi','travel',
 'tourism','trip','holiday','holidays','tatil','journey','journeys','agency','ltd','sti','as','group',
 'grup','international','global','world','istanbul','turkey','turkiye','hotel','hotels','com','tic','san',
 've','and','the','dmc','vip','transfer','clinic','health','saglik','estetik']);
const norm=(s)=>(s||'').replace(/İ/g,'i').replace(/I/g,'i').replace(/ı/g,'i').replace(/Ş/g,'s').replace(/ş/g,'s')
 .replace(/Ğ/g,'g').replace(/ğ/g,'g').replace(/Ü/g,'u').replace(/ü/g,'u').replace(/Ö/g,'o').replace(/ö/g,'o')
 .replace(/Ç/g,'c').replace(/ç/g,'c').toLowerCase().replace(/[^a-z0-9]/g,'');
const toks=(n)=>(n||'').split(/[\s.\-_/&,()]+/).map(norm).filter(t=>t.length>=3&&!GENERIC.has(t));
const eslesir=(firma,dom)=>{const core=norm((dom||'').split('.')[0]);const ts=toks(firma);const g=norm(firma);
 if(!core||!ts.length)return false;
 for(const t of ts){if(t===core)return true;if(t.length>=4&&(t.includes(core)||core.includes(t)))return true;
   if(t.length===3&&core.startsWith(t))return true;}
 return core.length>=5&&g.includes(core);};

const led=fs.readFileSync('/root/acente-data-2026-08/KURTARMA-DEFTERI.csv','utf8').split('\n').slice(1)
  .filter(Boolean).map(l=>{const p=l.split(',');return {id:p[0],firma:p[1],domain:p[2],eski:(p[3]||'').trim(),yeni:(p[4]||'').trim(),karar:p[8]};});

const ab=led.filter(r=>(r.karar==='A-YUKSEK'||r.karar==='B-ORTA')&&r.yeni&&r.yeni.split('@')[1]?.endsWith(r.domain));
const mevcut=new Set((await sql`SELECT id FROM leads WHERE ${ETIKET}::text = ANY(tags)`).map(r=>r.id));
// MX denetiminde elenenler GERI ALINMAZ — etiketleri kaldirildigi icin "yeni" gorunurler.
// (26 Agu: 6 mx-riskli lead bu yuzden partiye geri sizmisti.)
const mxRiskli=new Set((await sql`SELECT id FROM leads WHERE 'mx-riskli'::text = ANY(tags)`).map(r=>r.id));
const yeniler=ab.filter(r=>!mevcut.has(r.id) && !mxRiskli.has(r.id));
console.log(`A+B toplam: ${ab.length} | partide olan: ${mevcut.size} | YENI: ${yeniler.length}`);

let d=0,t=0,atla=0;
for (const r of yeniler) {
  const eDom=(r.eski.split('@')[1]||'').toLowerCase(), yDom=(r.yeni.split('@')[1]||'').toLowerCase();
  const ayniAlan = eDom && eDom===yDom;
  const eskiIyi  = eDom && eslesir(r.firma,eDom) && !eslesir(r.firma,yDom);
  if (ayniAlan || eskiIyi || r.eski.toLowerCase()===r.yeni.toLowerCase()) {
    // adrese DOKUNMA, sadece partiye al
    const res=await sql`UPDATE leads SET tags = CASE WHEN ${ETIKET}::text = ANY(tags) THEN tags ELSE array_append(tags,${ETIKET}::text) END WHERE id=${r.id}::uuid`;
    t+=res.count; if(ayniAlan||eskiIyi) atla++;
    continue;
  }
  const res=await sql`
    UPDATE leads SET primary_contact_email=${r.yeni}::text,
      source_meta = coalesce(source_meta,'{}'::jsonb) || jsonb_build_object(
        'email_history', coalesce(source_meta->'email_history','[]'::jsonb) ||
          jsonb_build_array(jsonb_build_object('eski',${r.eski}::text,'yeni',${r.yeni}::text,
            'kaynak','site-kazisi-2026-08-26-ek'::text,'karar',${r.karar}::text))),
      tags = CASE WHEN ${ETIKET}::text = ANY(tags) THEN tags ELSE array_append(tags,${ETIKET}::text) END,
      updated_at=now() WHERE id=${r.id}::uuid`;
  d+=res.count;
  fs.appendFileSync('/root/acente-data-2026-08/MAIL-DUZELTME-IZI.csv',
    `\n${r.id},${r.eski},${r.yeni},${r.firma},${r.domain},${r.karar}`);
}
console.log(`  mail duzeltildi : ${d}`);
console.log(`  sadece etiket   : ${t}  (${atla} tanesi koruma kurali geregi adrese dokunulmadi)`);
const [a]=await sql`SELECT count(*)::int n FROM leads WHERE ${ETIKET}::text = ANY(tags)`;
console.log(`parti toplam: ${a.n}`);
await sql.end();
