#!/usr/bin/env node
/**
 * JSON snapshot → lokal Postgres restore
 * /root/dumps/<project>/*.json okur, lokal DB'ye INSERT eder.
 * jsonb/uuid/timestamptz/array tiplerini postgres-js otomatik handle eder.
 *
 * Kullanım:
 *   DATABASE_URL=postgres://constantine_user:pass@127.0.0.1:5432/constantine \
 *   DUMP_DIR=/root/dumps/constantine \
 *   node restore-to-postgres.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const DUMP_DIR = process.env.DUMP_DIR || '/root/dumps/constantine';
const BATCH = Number(process.env.BATCH_SIZE || 500);
const TRUNCATE_FIRST = (process.env.TRUNCATE || 'true') === 'true';

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL env var lazım');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 4, prepare: false });

async function tableColumns(table) {
  const rows = await sql`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position
  `;
  return rows;
}

async function restoreTable(table) {
  const file = path.join(DUMP_DIR, `${table}.json`);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    console.log(`  ⊘  ${table.padEnd(35)} dosya yok, atlanıyor`);
    return { table, status: 'skipped', rows: 0 };
  }

  const data = JSON.parse(raw);
  if (!Array.isArray(data) || data.length === 0) {
    if (TRUNCATE_FIRST) {
      try { await sql`TRUNCATE TABLE ${sql(table)} RESTART IDENTITY CASCADE`; } catch {}
    }
    console.log(`  ⊘  ${table.padEnd(35)} 0 satır`);
    return { table, status: 'empty', rows: 0 };
  }

  // Tablo kolonlarını al — JSON'da olup tabloda olmayan kolonları (generated, removed) filtrele
  const cols = await tableColumns(table);
  if (cols.length === 0) {
    console.log(`  ✗  ${table.padEnd(35)} tablo lokalde yok`);
    return { table, status: 'no_table', rows: 0 };
  }
  const colNames = new Set(cols.map((c) => c.column_name));

  // JSON'daki anahtarları filtrele (tabloda olmayanları at)
  const filtered = data.map((row) => {
    const r = {};
    for (const [k, v] of Object.entries(row)) {
      if (colNames.has(k)) r[k] = v;
    }
    return r;
  });

  if (TRUNCATE_FIRST) {
    try {
      await sql`TRUNCATE TABLE ${sql(table)} RESTART IDENTITY CASCADE`;
    } catch (e) {
      console.log(`  ⚠  ${table.padEnd(35)} TRUNCATE hata: ${e.message.slice(0, 80)}`);
    }
  }

  // Batch insert — postgres-js sql(values, columns) helper'ı
  const insertCols = Object.keys(filtered[0]);
  let inserted = 0;
  for (let i = 0; i < filtered.length; i += BATCH) {
    const slice = filtered.slice(i, i + BATCH);
    try {
      await sql`INSERT INTO ${sql(table)} ${sql(slice, ...insertCols)} ON CONFLICT DO NOTHING`;
      inserted += slice.length;
    } catch (e) {
      console.log(`  ⚠  ${table} batch ${i}-${i + BATCH}: ${e.message.slice(0, 120)}`);
    }
  }

  // Gerçek satır sayısını kontrol et
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM ${sql(table)}`;
  console.log(`  ✓  ${table.padEnd(35)} ${String(count).padStart(6)} row (JSON ${data.length}, insert OK ${inserted})`);
  return { table, status: count === data.length ? 'ok' : 'mismatch', rows: count, expected: data.length };
}

async function main() {
  // Önce summary'den tablo listesi al
  const summary = JSON.parse(await fs.readFile(path.join(DUMP_DIR, '_summary.json'), 'utf8'));
  const tables = summary.filter((s) => !s.error).map((s) => s.table);
  console.log(`📋 ${tables.length} tablo restore edilecek`);

  // Topological order için: bağımlılığı az olan tabloları önce yükle
  // En basit yaklaşım: bağımsız tabloları + sonra FK'lı tabloları
  // Şimdilik tüm tabloları sırayla yükle, FK ihlali olursa hata yakalanır
  // (TRUNCATE CASCADE ile başlıyoruz, sonra insert)
  //
  // Disable triggers + FK constraints during load (session-level)
  await sql`SET session_replication_role = 'replica'`;

  const results = [];
  for (const t of tables) {
    const r = await restoreTable(t);
    results.push(r);
  }

  await sql`SET session_replication_role = 'origin'`;

  // Sequence'leri senkronize et (id auto-increment'ler için)
  console.log('\n🔧 Sequence senkronizasyon...');
  const seqs = await sql`
    SELECT
      pg_get_serial_sequence(table_name, column_name) AS seqname,
      table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_default LIKE 'nextval%'
  `;
  for (const s of seqs) {
    if (!s.seqname) continue;
    try {
      await sql.unsafe(`SELECT setval('${s.seqname}', COALESCE((SELECT MAX("${s.column_name}") FROM "${s.table_name}"), 1))`);
    } catch (e) {
      // ignore
    }
  }
  console.log(`  ${seqs.length} sequence güncellendi`);

  const ok = results.filter((r) => r.status === 'ok').length;
  const mismatch = results.filter((r) => r.status === 'mismatch').length;
  const empty = results.filter((r) => r.status === 'empty').length;
  const noTable = results.filter((r) => r.status === 'no_table').length;
  const totalRows = results.reduce((a, r) => a + (r.rows || 0), 0);

  console.log(`\n📊 ÖZET`);
  console.log(`  ✓ OK:        ${ok}`);
  console.log(`  ⚠ Mismatch:  ${mismatch}`);
  console.log(`  ⊘ Empty:     ${empty}`);
  console.log(`  ✗ No table:  ${noTable}`);
  console.log(`  Total rows:  ${totalRows}`);

  if (mismatch > 0) {
    console.log('\n⚠ Mismatch detayı:');
    for (const r of results.filter((r) => r.status === 'mismatch')) {
      console.log(`  - ${r.table}: lokal ${r.rows} / JSON ${r.expected}`);
    }
  }

  await sql.end();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
