#!/usr/bin/env node
/**
 * import-validation-csv.mjs — NeverBounce sonuç CSV'sini DB'ye import et
 *
 * NeverBounce bulk sonuç CSV'si: orijinal kolonlar (lead_id, email) + result kolonu.
 * result değerleri: valid / invalid / disposable / catchall / unknown
 *
 * Her lead'e:
 *   - tags += email-{valid|invalid|risky|disposable|catchall|unknown}  (eski email-* temizlenir)
 *   - custom_fields.email_validation = { status, code, validated_at, source: 'neverbounce' }
 *
 * Kullanım:
 *   node import-validation-csv.mjs --file /tmp/neverbounce-result.csv --dry-run
 *   node import-validation-csv.mjs --file /tmp/neverbounce-result.csv
 */
import 'dotenv/config';
import postgres from 'postgres';
import { readFileSync } from 'fs';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL eksik'); process.exit(1); }

const fileIdx = process.argv.indexOf('--file');
const filePath = fileIdx > -1 ? process.argv[fileIdx + 1] : null;
const dryRun = process.argv.includes('--dry-run');
if (!filePath) { console.error('--file <path> gerekli'); process.exit(1); }

const sql = postgres(DATABASE_URL);

// NeverBounce result → tag
const RESULT_TAG = {
  valid: 'email-valid',
  invalid: 'email-invalid',
  disposable: 'email-disposable',
  catchall: 'email-catchall',
  accept_all: 'email-catchall',
  unknown: 'email-unknown',
};

// Basit CSV parser (tırnak destekli)
function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  for (const line of lines) {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { cells.push(cur); cur = ''; }
        else cur += c;
      }
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

function rebuildTags(existing, emailTag) {
  const kept = (existing ?? []).filter((t) => !t.startsWith('email-'));
  return [...kept, emailTag];
}

async function main() {
  console.log(`\n=== Validation Import ${dryRun ? '(DRY-RUN)' : ''} ===\n`);
  const text = readFileSync(filePath, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) { console.error('CSV boş veya başlık yok'); process.exit(1); }

  // Başlık → kolon index (esnek: lead_id, email, result/verification_result/status)
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idIdx = header.findIndex((h) => h === 'lead_id' || h === 'id');
  const emailIdx = header.findIndex((h) => h === 'email');
  const resultIdx = header.findIndex((h) =>
    h === 'result' || h === 'verification_result' || h === 'status' || h === 'neverbounce_result',
  );
  if (resultIdx === -1) {
    console.error(`result kolonu bulunamadı. Başlıklar: ${header.join(', ')}`);
    process.exit(1);
  }
  console.log(`Kolonlar: lead_id[${idIdx}], email[${emailIdx}], result[${resultIdx}]\n`);

  const counts = {};
  const updates = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const leadId = idIdx > -1 ? row[idIdx]?.trim() : null;
    const email = row[emailIdx]?.trim();
    const result = (row[resultIdx]?.trim() || 'unknown').toLowerCase();
    const tag = RESULT_TAG[result] ?? 'email-unknown';
    counts[result] = (counts[result] ?? 0) + 1;
    updates.push({ leadId, email, result, tag });
  }

  console.log('--- Sonuç dağılımı ---');
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${v}`);
  }
  const validCount = (counts.valid ?? 0);
  console.log(`\nGönderime uygun (valid): ${validCount} / ${updates.length}`);

  if (dryRun) {
    console.log('\n[DRY-RUN] DB değişmedi.\n');
    await sql.end();
    return;
  }

  console.log('\nDB güncelleniyor...');
  let done = 0, skipped = 0;
  for (const u of updates) {
    // lead_id varsa onunla, yoksa email ile eşleştir
    const rows2 = u.leadId
      ? await sql`SELECT id, tags, custom_fields FROM leads WHERE id = ${u.leadId}`
      : await sql`SELECT id, tags, custom_fields FROM leads WHERE primary_contact_email = ${u.email} LIMIT 1`;
    const lead = rows2[0];
    if (!lead) { skipped++; continue; }

    const newTags = rebuildTags(lead.tags, u.tag);
    const cf = { ...(lead.custom_fields ?? {}) };
    cf.email_validation = {
      status: u.result,
      validated_at: new Date().toISOString(),
      source: 'neverbounce',
    };
    await sql`UPDATE leads SET tags = ${newTags}, custom_fields = ${sql.json(cf)} WHERE id = ${lead.id}`;
    done++;
    if (done % 500 === 0) console.log(`  ${done}/${updates.length}`);
  }
  console.log(`\n✓ ${done} lead güncellendi, ${skipped} eşleşmedi.\n`);
  await sql.end();
}

main().catch((e) => { console.error('HATA:', e); process.exit(1); });
