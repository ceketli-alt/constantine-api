#!/usr/bin/env node
/**
 * JSON snapshot → lokal Postgres restore (TEK TRANSACTION versiyonu)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const DUMP_DIR = process.env.DUMP_DIR || '/root/dumps/constantine';
const BATCH = Number(process.env.BATCH_SIZE || 500);

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL env var lazım');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, prepare: false, idle_timeout: 600 });

async function tableColumns(tx, table) {
  return tx`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position
  `;
}

async function main() {
  const summary = JSON.parse(await fs.readFile(path.join(DUMP_DIR, '_summary.json'), 'utf8'));
  const tables = summary.filter((s) => !s.error).map((s) => s.table);
  console.log(`📋 ${tables.length} tablo restore edilecek`);

  // Veri'yi RAM'e oku — IO bekleme transaction'ı uzatmasın
  const tableData = new Map();
  let totalRows = 0;
  for (const t of tables) {
    const file = path.join(DUMP_DIR, `${t}.json`);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const data = JSON.parse(raw);
      // unique id (duplicate atla)
      const seen = new Set();
      const unique = Array.isArray(data)
        ? data.filter((r) => {
            const id = r.id;
            if (id && seen.has(id)) return false;
            if (id) seen.add(id);
            return true;
          })
        : [];
      tableData.set(t, unique);
      totalRows += unique.length;
    } catch {
      tableData.set(t, []);
    }
  }
  console.log(`📦 ${totalRows} satır RAM'e yüklendi, transaction başlıyor...`);

  // TÜM RESTORE TEK TRANSACTION İÇİNDE
  const results = await sql.begin(async (tx) => {
    // Session-level: FK + trigger bypass
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx.unsafe(`SET session_replication_role = 'replica'`);

    // Pass 1: tüm tabloları truncate
    console.log(`🧹 TRUNCATE ${tables.length} tablo...`);
    const truncateList = tables.map((t) => `"${t}"`).join(', ');
    await tx.unsafe(`TRUNCATE TABLE ${truncateList} RESTART IDENTITY CASCADE`);

    // Pass 2: insert et
    console.log(`📥 INSERT...`);
    const out = [];
    for (const t of tables) {
      const rows = tableData.get(t) ?? [];
      if (rows.length === 0) {
        out.push({ table: t, status: 'empty', rows: 0, expected: 0 });
        continue;
      }
      // Kolonları al ve filtrele
      const cols = await tableColumns(tx, t);
      const colNames = new Set(cols.map((c) => c.column_name));
      const filtered = rows.map((row) => {
        const r = {};
        for (const [k, v] of Object.entries(row)) {
          if (colNames.has(k)) r[k] = v;
        }
        return r;
      });
      const insertCols = Object.keys(filtered[0]);

      let inserted = 0;
      for (let i = 0; i < filtered.length; i += BATCH) {
        const slice = filtered.slice(i, i + BATCH);
        try {
          await tx`INSERT INTO ${tx(t)} ${tx(slice, ...insertCols)} ON CONFLICT DO NOTHING`;
          inserted += slice.length;
        } catch (e) {
          console.log(`  ⚠ ${t} batch ${i}: ${e.message.slice(0, 120)}`);
        }
      }
      const [{ count }] = await tx`SELECT count(*)::int AS count FROM ${tx(t)}`;
      console.log(`  ✓ ${t.padEnd(35)} ${String(count).padStart(6)} row (JSON ${rows.length})`);
      out.push({ table: t, status: count === rows.length ? 'ok' : 'mismatch', rows: count, expected: rows.length });
    }

    // session_replication_role'u origin'e dönmüyoruz — transaction COMMIT'inde otomatik reset olur
    return out;
  });

  // Sequence senkronizasyon (ayrı transaction)
  console.log('\n🔧 Sequence senkronizasyon...');
  const seqs = await sql`
    SELECT pg_get_serial_sequence(table_schema || '.' || table_name, column_name) AS seqname,
           table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_default LIKE 'nextval%'
  `;
  for (const s of seqs) {
    if (!s.seqname) continue;
    try {
      await sql.unsafe(`SELECT setval('${s.seqname}', COALESCE((SELECT MAX("${s.column_name}") FROM "${s.table_name}"), 1))`);
    } catch {}
  }
  console.log(`  ${seqs.length} sequence güncellendi`);

  // Sanity check — transaction sonrası dış sayım
  console.log('\n🔎 COMMIT sonrası dış doğrulama:');
  for (const t of ['leads', 'lead_scores', 'bookings', 'activity_events', 'profiles']) {
    const [{ count }] = await sql.unsafe(`SELECT count(*)::int FROM "${t}"`);
    console.log(`  ${t.padEnd(20)} ${count}`);
  }

  const ok = results.filter((r) => r.status === 'ok').length;
  const mismatch = results.filter((r) => r.status === 'mismatch').length;
  const empty = results.filter((r) => r.status === 'empty').length;
  const totalActual = results.reduce((a, r) => a + (r.rows || 0), 0);

  console.log(`\n📊 ÖZET`);
  console.log(`  ✓ OK:        ${ok}`);
  console.log(`  ⚠ Mismatch:  ${mismatch}`);
  console.log(`  ⊘ Empty:     ${empty}`);
  console.log(`  Total rows:  ${totalActual}`);

  await sql.end();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
