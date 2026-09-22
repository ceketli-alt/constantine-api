#!/usr/bin/env node
/**
 * ARAMA LISTESI v2 — telefon kanali (Mert karari 21 Eyl: "2'ye baslayalim").
 * Gerekce: 1.609 soguk mail -> 7 cevap (%0,4); 28 sicak temas -> 6 cevap (%21).
 *
 * Oncelik sirasi — en az soguk olandan en soguga:
 *   O1  mail attik, teslim edildi, cevap yok  -> "gecen hafta bir mail atmistik" acilisi var
 *   O2  nb-dogrulanamadi                       -> kimligi dogrulandi, kutusu dogrulanamadi
 *   O3  yalnizca telefonu olan                 -> tamamen soguk
 *
 * Cikti: CRM etiketi `arama-2026-09` + `arama-o1|o2|o3` (UI'da filtrelenir)
 *        + /root/acente-data-2026-08/ARAMA-LISTESI-v2.csv
 * node arama-listesi-v2.mjs [--uygula]
 */
import postgres from 'postgres'; import fs from 'node:fs';
const UYGULA = process.argv.includes('--uygula');
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);

const satirlar = await sql`
WITH bounce AS (SELECT DISTINCT lower(m.to_email) mail FROM email_messages m WHERE m.bounced_at IS NOT NULL),
son_mail AS (
  SELECT t.lead_id, max(t.sent_at) sent_at, max(c.sender_email) gonderici
  FROM campaign_targets t JOIN campaigns c ON c.id=t.campaign_id
  WHERE t.status='sent' AND c.name ~ 'İstanbul|1B' GROUP BY t.lead_id),
aday AS (
  SELECT l.id, l.company_name, l.primary_contact_name, l.primary_contact_phone, l.primary_contact_email, l.website, l.notes,
    sm.sent_at, sm.gonderici,
    CASE
      WHEN sm.lead_id IS NOT NULL AND lower(l.primary_contact_email) NOT IN (SELECT mail FROM bounce) THEN 1
      WHEN 'nb-dogrulanamadi' = ANY(l.tags) THEN 2
      WHEN l.status='new' AND l.last_contacted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM campaign_targets ct WHERE ct.lead_id=l.id) THEN 3
      ELSE NULL END AS oncelik
  FROM leads l LEFT JOIN son_mail sm ON sm.lead_id=l.id
  WHERE l.city='İstanbul' AND l.primary_contact_phone IS NOT NULL AND l.primary_contact_phone <> ''
    AND NOT ('seg-irrelevant' = ANY(l.tags)) AND NOT ('cikmis-liste' = ANY(l.tags))
    AND NOT EXISTS (SELECT 1 FROM unsubscribes u WHERE u.channel='email' AND lower(u.identifier)=lower(l.primary_contact_email)))
SELECT * FROM aday WHERE oncelik IS NOT NULL ORDER BY oncelik, sent_at ASC NULLS LAST, company_name`; // Ö1: en eski mail önce (yeni atılana hemen aramak tuhaf)

const sayim = {1:0,2:0,3:0};
for (const s of satirlar) sayim[s.oncelik]++;
console.log(`arama adayi: ${satirlar.length}  ·  Ö1 ${sayim[1]} · Ö2 ${sayim[2]} · Ö3 ${sayim[3]}`);

const esc=v=>/[",\n]/.test(String(v??''))?`"${String(v).replace(/"/g,'""')}"`:String(v??'');
const tarih=d=>d?new Date(d).toLocaleDateString('tr-TR',{day:'2-digit',month:'long'}):'';
const acilis = (s) => s.oncelik===1
  ? `${tarih(s.sent_at)} tarihinde ${s.primary_contact_email} adresine mail atmıştık`
  : s.oncelik===2 ? `mail adresi doğrulanamadı, ilk temas telefon` : `ilk temas`;
const bas=['oncelik','firma','yetkili','telefon','mail','site','son_mail_tarihi','acilis_notu','lead_id'];
const csv=[bas.join(',')].concat(satirlar.map(s=>[
  'Ö'+s.oncelik, s.company_name, s.primary_contact_name||'', s.primary_contact_phone, s.primary_contact_email||'',
  s.website||'', s.sent_at?new Date(s.sent_at).toISOString().slice(0,10):'', acilis(s), s.id].map(esc).join(','))).join('\n')+'\n';
fs.writeFileSync('/root/acente-data-2026-08/ARAMA-LISTESI-v2.csv', csv);
console.log('-> /root/acente-data-2026-08/ARAMA-LISTESI-v2.csv');

if (UYGULA) {
  for (const o of [1,2,3]) {
    const ids = satirlar.filter(s=>s.oncelik===o).map(s=>s.id);
    if (!ids.length) continue;
    await sql`UPDATE leads SET tags = (
        SELECT array_agg(DISTINCT x) FROM unnest(
          array_remove(array_remove(array_remove(tags,'arama-o1'),'arama-o2'),'arama-o3')
          || ARRAY['arama-2026-09', ${'arama-o'+o}]::text[]) x)
      WHERE id = ANY(${ids}::uuid[])`;
  }
  console.log(`CRM etiketlendi: arama-2026-09 + arama-o1/o2/o3 (${satirlar.length} lead)`);
} else console.log('(--uygula ile CRM etiketlenir)');
await sql.end();
