/**
 * Tum lead + outreach datasini Drive paketi icin CSV'lere doker.
 * Cikti: /root/acente-data-2026-08/drive-export/*.csv
 */
import postgres from 'postgres';
import fs from 'node:fs';

const OUT = '/root/acente-data-2026-08/drive-export';
fs.mkdirSync(OUT, { recursive: true });

const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sql = postgres(env.DATABASE_URL);

const esc = (v) => {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join(' | ') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function write(file, rows) {
  if (!rows.length) { console.log(`${file}: bos, atlandi`); return; }
  const head = Object.keys(rows[0]);
  const lines = [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))];
  fs.writeFileSync(`${OUT}/${file}`, '﻿' + lines.join('\n'), 'utf8');
  console.log(`${file}: ${rows.length} satır`);
}

write('01-tum-leadler.csv', await sql`
  SELECT company_name AS "Firma", type AS "Tip", segment AS "Segment", status AS "Durum",
         primary_contact_name AS "Kişi", primary_contact_email AS "E-posta",
         primary_contact_phone AS "Telefon", website AS "Web",
         city AS "Şehir", district AS "İlçe", score AS "Skor", temperature AS "Sıcaklık",
         source AS "Kaynak", tags AS "Etiketler",
         to_char(last_contacted_at,'YYYY-MM-DD') AS "Son Temas",
         to_char(created_at,'YYYY-MM-DD') AS "Kayıt"
  FROM leads ORDER BY (city='İstanbul') DESC NULLS LAST, company_name`);

write('02-istanbul-leadler.csv', await sql`
  SELECT company_name AS "Firma", primary_contact_email AS "E-posta",
         primary_contact_phone AS "Telefon", website AS "Web", district AS "İlçe",
         status AS "Durum", tags AS "Etiketler",
         to_char(last_contacted_at,'YYYY-MM-DD') AS "Son Temas"
  FROM leads WHERE city='İstanbul' ORDER BY district, company_name`);

write('03-outreach-gecmisi.csv', await sql`
  SELECT c.name AS "Kampanya", l.company_name AS "Firma", l.primary_contact_email AS "E-posta",
         ct.status AS "Durum", ct.sequence_step AS "Adım",
         to_char(ct.sent_at,'YYYY-MM-DD HH24:MI') AS "Gönderim",
         to_char(ct.replied_at,'YYYY-MM-DD HH24:MI') AS "Cevap", ct.error AS "Hata"
  FROM campaign_targets ct
  JOIN campaigns c ON c.id=ct.campaign_id
  JOIN leads l ON l.id=ct.lead_id
  ORDER BY ct.sent_at DESC NULLS LAST`);

write('04-kampanya-ozeti.csv', await sql`
  SELECT c.name AS "Kampanya", c.status AS "Durum", c.sender_email AS "Gönderici",
         c.daily_cap AS "Günlük Tavan",
         count(*) FILTER (WHERE ct.status='sent')::int AS "Gönderildi",
         count(*) FILTER (WHERE ct.status='queued')::int AS "Kuyrukta",
         count(*) FILTER (WHERE ct.status='replied')::int AS "Cevap",
         count(*) FILTER (WHERE ct.status='failed')::int AS "Başarısız",
         to_char(c.started_at,'YYYY-MM-DD') AS "Başlangıç"
  FROM campaigns c LEFT JOIN campaign_targets ct ON ct.campaign_id=c.id
  GROUP BY c.id ORDER BY c.created_at DESC`);

write('05-segment-ozeti.csv', await sql`
  SELECT coalesce(city,'(şehir yok)') AS "Şehir", type AS "Tip", segment AS "Segment",
         count(*)::int AS "Adet",
         count(*) FILTER (WHERE primary_contact_email IS NOT NULL)::int AS "E-postalı",
         count(*) FILTER (WHERE last_contacted_at IS NOT NULL)::int AS "Temas Edilmiş"
  FROM leads GROUP BY 1,2,3 ORDER BY 4 DESC`);

write('06-etiket-dagilimi.csv', await sql`
  SELECT tag AS "Etiket", count(*)::int AS "Adet"
  FROM leads, unnest(tags) tag GROUP BY 1 ORDER BY 2 DESC`);

await sql.end();
console.log('\n✓ export tamam →', OUT);
