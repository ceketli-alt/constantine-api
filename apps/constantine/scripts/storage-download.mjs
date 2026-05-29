#!/usr/bin/env node
/**
 * Storage download — Supabase'den tüm boat_photos'u lokal disk'e indir.
 *
 * Hedef yapı: /var/www/storage/<bucket>/<path>
 *   örn: /var/www/storage/boat-photos/<boat_id>/<filename>
 *
 * Çalıştır:
 *   sudo mkdir -p /var/www/storage && sudo chown -R root:root /var/www/storage
 *   cd /var/www/api/apps/constantine
 *   node --env-file=.env scripts/storage-download.mjs
 */
import postgres from 'postgres';
import fs from 'node:fs/promises';
import path from 'node:path';

const STORAGE_ROOT = '/var/www/storage';
const sql = postgres(process.env.DATABASE_URL, { max: 2 });

// URL'den bucket + relative path çıkar
// https://X.supabase.co/storage/v1/object/public/<bucket>/<key>
function parseSupabaseUrl(url) {
  const m = url.match(/\/storage\/v1\/object\/(?:public\/)?([^/]+)\/(.+)$/);
  if (!m) return null;
  return { bucket: m[1], key: m[2] };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function downloadOne(url, destPath) {
  try {
    const st = await fs.stat(destPath).catch(() => null);
    if (st && st.size > 0) {
      return { ok: true, skipped: true };
    }
    const res = await fetch(url);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await ensureDir(path.dirname(destPath));
    await fs.writeFile(destPath, buf);
    return { ok: true, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function main() {
  await ensureDir(STORAGE_ROOT);

  // 1. boat_photos
  const photos = await sql`
    SELECT id, boat_id, url
    FROM boat_photos
    ORDER BY created_at DESC
  `;
  console.log(`boat_photos: ${photos.length} kayıt`);

  let ok = 0, skipped = 0, failed = 0, totalBytes = 0;
  const failures = [];

  for (const p of photos) {
    const parsed = parseSupabaseUrl(p.url);
    if (!parsed) {
      failed++;
      failures.push({ id: p.id, url: p.url, reason: 'URL parse fail' });
      continue;
    }
    const destPath = path.join(STORAGE_ROOT, parsed.bucket, parsed.key);
    const result = await downloadOne(p.url, destPath);
    if (result.ok) {
      if (result.skipped) skipped++;
      else { ok++; totalBytes += result.bytes; }
    } else {
      failed++;
      failures.push({ id: p.id, url: p.url, reason: result.error });
    }
    if ((ok + skipped + failed) % 10 === 0) {
      console.log(`  progress: ${ok + skipped + failed}/${photos.length} (ok=${ok}, skipped=${skipped}, failed=${failed})`);
    }
  }

  console.log(`\nboat_photos download complete:`);
  console.log(`  Downloaded: ${ok} (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  Already present: ${skipped}`);
  console.log(`  Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures.slice(0, 10)) console.log(`  ${f.id}: ${f.reason} (${f.url.slice(0, 80)})`);
  }

  // 2. Diğer kolonlar — boats.image_url, expenses.receipt_url
  for (const [table, col] of [['boats', 'image_url'], ['expenses', 'receipt_url']]) {
    try {
      const rows = await sql`
        SELECT id, ${sql(col)} AS url
        FROM ${sql(table)}
        WHERE ${sql(col)} IS NOT NULL
          AND ${sql(col)} LIKE '%supabase.co%'
      `;
      console.log(`\n${table}.${col}: ${rows.length} kayıt`);
      let okSub = 0, skippedSub = 0, failedSub = 0;
      for (const r of rows) {
        const parsed = parseSupabaseUrl(r.url);
        if (!parsed) { failedSub++; continue; }
        const destPath = path.join(STORAGE_ROOT, parsed.bucket, parsed.key);
        const result = await downloadOne(r.url, destPath);
        if (result.ok) {
          if (result.skipped) skippedSub++; else okSub++;
        } else {
          failedSub++;
        }
      }
      console.log(`  Downloaded: ${okSub}, skipped: ${skippedSub}, failed: ${failedSub}`);
    } catch (e) {
      console.log(`  Skipped ${table}.${col}: ${e.message}`);
    }
  }

  console.log('\nDone. Lokal dizin:');
  console.log(`  ${STORAGE_ROOT}/`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
