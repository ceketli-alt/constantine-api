#!/usr/bin/env node
/**
 * Supabase → lokal JSON snapshot
 * Her tabloyu service role key ile REST API'den çeker, /root/dumps/<project>/<table>.json olarak yazar.
 *
 * Kullanım:
 *   PROJECT=constantine \
 *   SUPABASE_URL=https://gueseggrlelvcoihrpjh.supabase.co \
 *   SUPABASE_SERVICE_KEY=eyJ... \
 *   OUT_DIR=/root/dumps/constantine \
 *   node dump-from-supabase.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OUT_DIR = process.env.OUT_DIR || '/tmp/supabase-dump';
const PAGE_SIZE = 1000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FATAL: SUPABASE_URL ve SUPABASE_SERVICE_KEY env var\'ları lazım');
  process.exit(1);
}

const HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

async function listTables() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
    headers: { ...HEADERS, Accept: 'application/openapi+json' },
  });
  if (!res.ok) throw new Error(`OpenAPI fetch failed: ${res.status}`);
  const spec = await res.json();
  // View'ları da içerir — sadece tablolar lazım (view'ları atla, isimleri 'v_' ile başlar veya bilinen view'lar)
  const KNOWN_VIEWS = new Set([
    'v_hot_leads',
    'v_iys_latest',
    'v_pipeline_summary',
    'v_warmup_overview',
    'activity_user_totals',
    'public_boats',
    'bookings_cross_calendar',
  ]);
  const all = Object.keys(spec.definitions || {});
  return all.filter((t) => !KNOWN_VIEWS.has(t));
}

async function fetchAll(table) {
  const rows = [];
  let offset = 0;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?select=*&order=created_at.asc.nullsfirst`;
    // bazı tablolarda created_at yok — fallback
    let res = await fetch(url, {
      headers: {
        ...HEADERS,
        Range: `${offset}-${offset + PAGE_SIZE - 1}`,
        'Range-Unit': 'items',
        Prefer: 'count=exact',
      },
    });
    if (!res.ok) {
      // order=created_at başarısızsa, order'ı kaldır ve tekrar dene
      const url2 = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?select=*`;
      res = await fetch(url2, {
        headers: {
          ...HEADERS,
          Range: `${offset}-${offset + PAGE_SIZE - 1}`,
          'Range-Unit': 'items',
          Prefer: 'count=exact',
        },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${table} HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
    }
    const contentRange = res.headers.get('content-range') || '';
    const total = Number(contentRange.split('/')[1] || '0');
    const batch = await res.json();
    if (!Array.isArray(batch)) {
      throw new Error(`${table}: response not array: ${JSON.stringify(batch).slice(0, 200)}`);
    }
    rows.push(...batch);
    if (batch.length < PAGE_SIZE || rows.length >= total) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const tables = await listTables();
  console.log(`📋 ${tables.length} tablo bulundu, ${OUT_DIR}'a dökülüyor`);

  const summary = [];
  let totalRows = 0;
  for (const t of tables) {
    const t0 = Date.now();
    try {
      const rows = await fetchAll(t);
      const out = path.join(OUT_DIR, `${t}.json`);
      await fs.writeFile(out, JSON.stringify(rows));
      const dt = Date.now() - t0;
      const size = (await fs.stat(out)).size;
      totalRows += rows.length;
      console.log(`  ✓ ${t.padEnd(35)} ${String(rows.length).padStart(6)} row  ${(size / 1024).toFixed(1).padStart(7)} KB  ${dt}ms`);
      summary.push({ table: t, rows: rows.length, size_kb: Math.round(size / 1024), ms: dt });
    } catch (err) {
      console.log(`  ✗ ${t.padEnd(35)} HATA: ${err.message}`);
      summary.push({ table: t, error: err.message });
    }
  }

  await fs.writeFile(path.join(OUT_DIR, '_summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n📊 Toplam: ${totalRows} satır, ${tables.length} tablo`);
  console.log(`📁 ${OUT_DIR}/_summary.json yazıldı`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
