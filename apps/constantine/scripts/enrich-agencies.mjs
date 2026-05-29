#!/usr/bin/env node
/**
 * enrich-agencies.mjs — Google Places (New) ile agency lead enrichment
 *
 * seg-unenriched (3756 lead, google_primary_type yok) için:
 *   - company_name + "İstanbul" ile Places Text Search (New)
 *   - İlk eşleşmeden: type, rating, review_count, koordinat, adres, telefon, website
 *   - rating_tier hesapla (mevcut şemaya uyumlu: high/medium/low_trust)
 *   - source_meta'ya merge et (google_* alanları + enriched_at)
 *   - enrichment_status set et
 *
 * NOT: source_meta'yı sadece MERGE eder, mevcut alanları (btk, uye_no, scraped_*) korur.
 * Enrichment sonrası `node segment-agencies.mjs` yeniden çalıştırılmalı (seg-* tag güncelleme).
 *
 * API: Places API (New) — https://places.googleapis.com/v1/places:searchText
 *   FieldMask Pro SKU. ~$0.032/call. 3756 call ≈ $120 (Google $200/ay free credit + yeni hesap $300 trial içinde olabilir).
 *
 * Kullanım:
 *   GOOGLE_PLACES_API_KEY=xxx node enrich-agencies.mjs --dry-run        # coverage + maliyet tahmini, API call YOK
 *   GOOGLE_PLACES_API_KEY=xxx node enrich-agencies.mjs --limit 50       # ilk 50 lead'i enrich et (test)
 *   GOOGLE_PLACES_API_KEY=xxx node enrich-agencies.mjs --execute        # tüm 3756 lead
 *   ... --resume   # zaten enriched olanları atla (default davranış)
 */
import 'dotenv/config';
import postgres from 'postgres';

// Sunucu hem IPv4 (178.105.222.133) hem IPv6'ya sahip; Node varsayılan IPv6 seçiyor.
// Places API key IPv4 restricted. Çözüm: bu script'i ŞU FLAG ile çalıştır:
//   node --dns-result-order=ipv4first scripts/enrich-agencies.mjs ...
// (package.json'da da script tanımlı: pnpm enrich:agencies)

const DATABASE_URL = process.env.DATABASE_URL;
const PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || '';

if (!DATABASE_URL) {
  console.error('DATABASE_URL eksik (.env)');
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const execute = args.has('--execute');
const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx > -1 ? parseInt(process.argv[limitIdx + 1], 10) : null;

if (!dryRun && !execute && !limit) {
  console.error('Güvenlik: --dry-run, --limit N veya --execute belirt. (Maliyet kontrolü)');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.types',
  'places.primaryType',
  'places.rating',
  'places.userRatingCount',
  'places.location',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.businessStatus',
].join(',');

// İstanbul location bias (yanlış şehir eşleşmesini azaltır)
const ISTANBUL_BIAS = {
  circle: { center: { latitude: 41.0082, longitude: 28.9784 }, radius: 50000.0 },
};

const RATE_GAP_MS = 120; // ~8 req/s, Places default limit altında

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Mevcut şemaya uyumlu rating_tier hesabı (segment-agencies.mjs ile aynı eşik). */
function computeRatingTier(rating, reviewCount) {
  if (reviewCount == null || reviewCount === 0) return { tier: 'no_data', rating: rating ?? null, reviews: reviewCount ?? 0 };
  if (reviewCount >= 50 && rating >= 4.5) return { tier: 'high_trust', rating, reviews: reviewCount };
  if (reviewCount >= 10 && rating >= 4.0) return { tier: 'medium_trust', rating, reviews: reviewCount };
  return { tier: 'low_trust', rating: rating ?? null, reviews: reviewCount };
}

async function searchPlace(companyName) {
  const res = await fetch(PLACES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_API_KEY,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: `${companyName} İstanbul`,
      locationBias: ISTANBUL_BIAS,
      languageCode: 'tr',
      maxResultCount: 1,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Places ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.places?.[0] ?? null;
}

function buildMetaPatch(place) {
  if (!place) {
    return { enrichment_status: 'google_not_found', enriched_at: new Date().toISOString() };
  }
  const rating = place.rating ?? null;
  const reviewCount = place.userRatingCount ?? 0;
  return {
    google_place_id: place.id ?? null,
    google_display_name: place.displayName?.text ?? null,
    google_types: place.types ?? [],
    google_primary_type: place.primaryType ?? null,
    google_rating: rating,
    google_review_count: reviewCount,
    google_coords: place.location
      ? { lat: place.location.latitude, lng: place.location.longitude }
      : null,
    google_address: place.formattedAddress ?? null,
    google_phone: place.nationalPhoneNumber ?? null,
    google_website: place.websiteUri ?? null,
    google_business_status: place.businessStatus ?? null,
    rating_tier: { ...computeRatingTier(rating, reviewCount), tagged_at: new Date().toISOString() },
    enrichment_status: place.websiteUri ? 'enriched' : 'enriched_no_website',
    enriched_at: new Date().toISOString(),
  };
}

async function main() {
  console.log(`\n=== Agency Enrichment ${dryRun ? '(DRY-RUN)' : execute ? '(EXECUTE — TÜM)' : `(LIMIT ${limit})`} ===\n`);

  // seg-unenriched + henüz google_primary_type'ı olmayan agency lead'ler
  const rows = await sql`
    SELECT id, company_name, source_meta
    FROM leads
    WHERE type = 'agency'
      AND (source_meta->>'google_primary_type' IS NULL OR source_meta->>'google_primary_type' = '')
      AND (source_meta->>'enrichment_status' IS NULL OR source_meta->>'enrichment_status' NOT IN ('enriched','enriched_no_website','google_not_found'))
    ORDER BY company_name
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `;

  console.log(`Enrich edilecek lead: ${rows.length}`);
  console.log(`Tahmini maliyet: ~$${(rows.length * 0.032).toFixed(2)} (Places Text Search Pro SKU, $0.032/call)`);
  console.log(`Tahmini süre: ~${Math.ceil((rows.length * RATE_GAP_MS) / 1000 / 60)} dk\n`);

  if (dryRun) {
    console.log('İlk 10 örnek query:');
    rows.slice(0, 10).forEach((r) => console.log(`  "${r.company_name} İstanbul"`));
    console.log('\n[DRY-RUN] API call yapılmadı, DB değişmedi.\n');
    await sql.end();
    return;
  }

  if (!PLACES_API_KEY) {
    console.error('GOOGLE_PLACES_API_KEY eksik — gerçek enrichment için gerekli.');
    await sql.end();
    process.exit(1);
  }

  let found = 0, notFound = 0, errors = 0;
  for (let i = 0; i < rows.length; i++) {
    const lead = rows[i];
    try {
      const place = await searchPlace(lead.company_name);
      const patch = buildMetaPatch(place);
      const merged = { ...(lead.source_meta ?? {}), ...patch };
      await sql`UPDATE leads SET source_meta = ${sql.json(merged)} WHERE id = ${lead.id}`;
      if (place) found++; else notFound++;
      if ((i + 1) % 50 === 0) {
        console.log(`  ${i + 1}/${rows.length} (found ${found}, not_found ${notFound}, err ${errors})`);
      }
    } catch (e) {
      errors++;
      console.warn(`  ! ${lead.company_name}: ${e.message}`);
      if (e.message.includes('429') || e.message.includes('RESOURCE_EXHAUSTED')) {
        console.warn('  Rate limit — 5s bekle');
        await sleep(5000);
      }
    }
    await sleep(RATE_GAP_MS);
  }

  console.log(`\n✓ Enrichment bitti: found ${found}, not_found ${notFound}, errors ${errors}`);
  console.log(`Sonraki adım: node scripts/segment-agencies.mjs (yeni enriched lead'leri segmentle)\n`);
  await sql.end();
}

main().catch((e) => { console.error('HATA:', e); process.exit(1); });
