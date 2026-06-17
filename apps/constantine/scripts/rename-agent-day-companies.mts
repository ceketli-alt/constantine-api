/**
 * 2026-06-06 — Agent Day 2026-06-04 follow-up
 *
 * 9 mevcut lead (NeverBounce/Places enrich ile yıllar önce gelmiş) `company_name`
 * Agent Day kartvizitindeki doğru ada güncellenir.
 *
 * Eşleşme: lower(primary_contact_email) — Mert kart bilgisinden ÖZNE_ KİŞİ_MAİLİ ile
 * import etti; primary_email zaten güncel.
 *
 * Modlar:
 *   dry   → SELECT + tablo (no write)
 *   apply → UPDATE company_name + audit notes append
 *
 * Kullanım:
 *   npx tsx scripts/rename-agent-day-companies.mts           # dry
 *   npx tsx scripts/rename-agent-day-companies.mts apply     # write
 */
import 'dotenv/config';
import { sql } from '../src/db.js';

const MODE = (process.argv[2] ?? 'dry').toLowerCase();
if (MODE !== 'dry' && MODE !== 'apply') {
  console.error(`Geçersiz mod: ${MODE}. Beklenen: dry | apply`);
  process.exit(2);
}

interface Rename {
  email: string;
  to: string;        // Agent Day kart'ta görünen marka
  legal_name?: string; // varsa tüzel ad (CRM legal_name alanı)
}

const RENAMES: Rename[] = [
  { email: 'esat@carattours.com',             to: 'Carat Tours',     legal_name: 'CARAT TURİZM' },
  { email: 'murat.kartal@presenttour.com.tr', to: 'Present Tour',    legal_name: 'PRESENT TOUR TURİZM' },
  { email: 'fatih@mygo.pro',                  to: 'myGO Worldwide',  legal_name: 'ALPHAROOMS TURİZM SEYAHAT ACENTASI' },
  { email: 'kezban@zesatravel.com',           to: 'Zesa Travel',     legal_name: 'ZESA TURİZM' },
  { email: 'info@ottoman-ht.com',             to: 'Ottoman HT',      legal_name: 'WORLD LIFE TURİZM' },
  { email: 'info@ayfaclinic.com',             to: 'Ayfa Clinic',     legal_name: 'BARIFA SAĞLIK VE TURİZM SEYAHAT ACENTASI' },
  { email: 'info@mednificant.com',            to: 'Mednificant',     legal_name: 'ŞANSEL TURİZM' },
  { email: 'info@anturizm.com',               to: 'AN Turizm',       legal_name: 'CITYLINE TURİZM' },
  { email: 'info@tatilciniz.com.tr',          to: 'Tatilciniz',      legal_name: 'TATİLCİNİZ TURİZM' },
];

console.log(`=== Agent Day company_name rename — mod: ${MODE.toUpperCase()} ===\n`);
console.log(`Toplam ${RENAMES.length} rename hedeflendi.\n`);

let renamed = 0;
let alreadyOk = 0;
let notFound = 0;

for (const r of RENAMES) {
  const rows = await sql<{ id: string; company_name: string; legal_name: string | null }[]>`
    SELECT id, company_name, legal_name
    FROM leads
    WHERE lower(primary_contact_email) = ${r.email.toLowerCase()}
    LIMIT 1
  `;
  if (!rows.length) {
    console.log(`  ⚠️  Bulunamadı:        ${r.email}`);
    notFound++;
    continue;
  }
  const lead = rows[0]!;
  if (lead.company_name === r.to) {
    console.log(`  ✓   Zaten doğru:      ${r.email.padEnd(42)} | ${r.to}`);
    alreadyOk++;
    continue;
  }
  const oldName = lead.company_name;
  console.log(`  ${MODE === 'apply' ? '✏️ ' : '🔍'}  ${MODE === 'apply' ? 'Güncelleniyor:' : 'Güncellenecek:'} ${r.email.padEnd(38)} | ${oldName.padEnd(50)} → ${r.to}`);

  if (MODE === 'apply') {
    await sql`
      UPDATE leads
      SET
        company_name = ${r.to},
        legal_name   = COALESCE(NULLIF(legal_name, ''), ${r.legal_name ?? null}),
        notes        = COALESCE(notes, '') ||
                       E'\n\n--- 2026-06-06 firma adı güncelleme ---\n' ||
                       'Eski ad (NeverBounce/Places enrich): ' || ${oldName} || E'\n' ||
                       'Yeni ad (Agent Day 2026-06-04 kartvizit): ' || ${r.to} ||
                       (CASE WHEN ${r.legal_name ?? ''} <> '' AND legal_name IS NULL
                             THEN E'\nLegal name kaydedildi: ' || ${r.legal_name ?? ''}
                             ELSE '' END),
        updated_at   = NOW()
      WHERE id = ${lead.id}
    `;
  }
  renamed++;
}

console.log(`\n=== Özet ===`);
console.log(`  ✏️  ${renamed} ${MODE === 'apply' ? 'güncellendi' : 'güncellenecek'}`);
console.log(`  ✓   ${alreadyOk} zaten doğru`);
console.log(`  ⚠️  ${notFound} bulunamadı`);

if (MODE === 'dry') {
  console.log(`\nUygulamak için:`);
  console.log(`  npx tsx scripts/rename-agent-day-companies.mts apply\n`);
}

await sql.end();
