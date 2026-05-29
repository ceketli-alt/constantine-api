#!/usr/bin/env node
/**
 * Storage URL update — Supabase URL'lerini lokal serving URL'lerine çevir.
 *
 * Eski: https://gueseggrlelvcoihrpjh.supabase.co/storage/v1/object/public/<bucket>/<key>
 * Yeni: https://api.constantineyachts.com/storage/v1/object/public/<bucket>/<key>
 *
 * nginx config /storage/v1/object/public/* → /var/www/storage/* alias yapacak,
 * yani path aynı kalır, sadece domain değişir.
 *
 * Çalıştır:
 *   cd /var/www/api/apps/constantine
 *   node --env-file=.env scripts/storage-update-urls.mjs [--dry-run]
 */
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const OLD = 'https://gueseggrlelvcoihrpjh.supabase.co';
const NEW = 'https://api.constantineyachts.com';
const DRY = process.argv.includes('--dry-run');

console.log(`=== Storage URL update ===`);
console.log(`Eski domain: ${OLD}`);
console.log(`Yeni domain: ${NEW}`);
console.log(`Mode: ${DRY ? 'DRY RUN (sadece sayım)' : 'GERÇEK UPDATE'}\n`);

const tables = [
  { table: 'boat_photos', col: 'url' },
  { table: 'boats', col: 'image_url' },
  { table: 'expenses', col: 'receipt_url' },
];

let totalUpdated = 0;
for (const { table, col } of tables) {
  try {
    const countRows = await sql`
      SELECT count(*)::int AS n FROM ${sql(table)}
      WHERE ${sql(col)} LIKE ${OLD + '%'}
    `;
    const n = countRows[0].n;
    console.log(`${table}.${col}: ${n} kayıt Supabase'e bağlı`);

    if (n > 0 && !DRY) {
      const updRows = await sql`
        UPDATE ${sql(table)}
        SET ${sql(col)} = replace(${sql(col)}, ${OLD}, ${NEW})
        WHERE ${sql(col)} LIKE ${OLD + '%'}
        RETURNING id
      `;
      console.log(`  → ${updRows.length} update edildi`);
      totalUpdated += updRows.length;
    } else if (n > 0 && DRY) {
      const sample = await sql`
        SELECT ${sql(col)} AS old_url,
               replace(${sql(col)}, ${OLD}, ${NEW}) AS new_url
        FROM ${sql(table)}
        WHERE ${sql(col)} LIKE ${OLD + '%'}
        LIMIT 2
      `;
      for (const r of sample) {
        console.log(`  OLD: ${r.old_url}`);
        console.log(`  NEW: ${r.new_url}`);
      }
    }
  } catch (e) {
    console.log(`  ${table}.${col}: skip (${e.message})`);
  }
}

console.log(`\nToplam ${totalUpdated} URL update edildi.`);
if (DRY) console.log('(DRY RUN, gerçek değişiklik yok. --dry-run çıkar ve tekrar çalıştır.)');
await sql.end();
