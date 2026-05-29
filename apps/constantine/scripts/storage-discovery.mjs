#!/usr/bin/env node
/**
 * Storage discovery — DB'de hangi tablolarda storage URL'leri var,
 * kaç dosya, hangi bucket'lar, toplam tahmin.
 *
 * Çalıştır:
 *   cd /var/www/api/apps/constantine
 *   node --env-file=.env scripts/storage-discovery.mjs
 */
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 2 });

console.log('=== Storage Discovery ===\n');

// 1. boat_photos
const bpCount = await sql`SELECT count(*)::int AS n FROM boat_photos`;
console.log(`boat_photos: ${bpCount[0].n} kayıt`);

const bpSamples = await sql`
  SELECT url FROM boat_photos ORDER BY created_at DESC LIMIT 5
`;
console.log('  Örnek URL\'ler:');
for (const r of bpSamples) console.log(`    ${r.url}`);

// 2. Bucket dağılımı (hangi domain/bucket)
const bpDomains = await sql`
  SELECT
    regexp_replace(url, '^https?://([^/]+)/.*', '\\1') AS domain,
    count(*)::int AS n
  FROM boat_photos
  GROUP BY 1
  ORDER BY n DESC
`;
console.log('  Domain dağılımı:');
for (const r of bpDomains) console.log(`    ${r.domain}: ${r.n}`);

// 3. URL pattern (path örnekleri)
const bpPaths = await sql`
  SELECT DISTINCT regexp_replace(url, '^https?://[^/]+', '') AS path_part
  FROM boat_photos
  LIMIT 10
`;
console.log('  Path örnekleri:');
for (const r of bpPaths) console.log(`    ${r.path_part}`);

// 4. Diğer tablolar — storage URL içerebilecek text kolonları
console.log('\n=== Diğer tablolarda storage referansları ===');

const otherTables = [
  ['boats', 'photo_url'],
  ['profiles', 'avatar_url'],
  ['agencies', 'logo_url'],
];

for (const [table, col] of otherTables) {
  try {
    const r = await sql`
      SELECT count(*)::int AS n
      FROM ${sql(table)}
      WHERE ${sql(col)} IS NOT NULL
        AND ${sql(col)} LIKE '%supabase.co%'
    `;
    console.log(`${table}.${col}: ${r[0].n} supabase ref`);
  } catch (e) {
    console.log(`${table}.${col}: (kolon yok veya hata) ${e.message}`);
  }
}

// 5. Genel arama: text kolonlarında supabase URL geçen
console.log('\n=== Genel scan (information_schema) ===');
const textCols = await sql`
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND data_type IN ('text', 'varchar', 'character varying')
    AND column_name ~* '(url|photo|image|logo|avatar|file)'
  ORDER BY table_name
`;
console.log('  Storage olası text kolonlar:');
for (const r of textCols) console.log(`    ${r.table_name}.${r.column_name}`);

await sql.end();
