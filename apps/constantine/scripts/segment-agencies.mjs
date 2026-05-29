#!/usr/bin/env node
/**
 * segment-agencies.mjs — Agency lead segmentasyonu (google_primary_type + rating_tier → tags)
 *
 * 5616 agency lead'ine iki eksende tag ekler:
 *   - Segment tag (seg-*): google_primary_type bazlı (dmc/travel/health/transfer/mice/hotel-partner/irrelevant/other/unenriched)
 *   - Trust tag (trust-*): rating_tier.tier bazlı (high/medium/low/unknown)
 *
 * Idempotent: mevcut seg-* / trust-* tag'lerini temizler, yeniden yazar.
 * Diğer tag'leri (email-valid vb.) korur.
 *
 * Kullanım:
 *   node segment-agencies.mjs --dry-run     # sadece dağılım raporu, DB'ye yazmaz
 *   node segment-agencies.mjs               # uygula (DB'ye yaz)
 */
import 'dotenv/config';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL eksik (.env)');
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

const sql = postgres(DATABASE_URL);

// ─── Segment mapping: google_primary_type → seg-* ─────────────────
const SEGMENT_MAP = {
  // DMC / Tour Operator — yabancı turist kanalı
  tour_agency: 'seg-dmc',

  // Generic travel / tourism
  travel_agency: 'seg-travel',
  tourist_information_center: 'seg-travel',
  tourist_attraction: 'seg-travel',
  point_of_interest: 'seg-travel',

  // Sağlık turizmi
  health: 'seg-health',
  medical_clinic: 'seg-health',
  doctor: 'seg-health',
  dental_clinic: 'seg-health',
  medical_center: 'seg-health',
  hospital: 'seg-health',
  wellness_center: 'seg-health',

  // Transfer / ulaşım (Mert: ayrı segment, partner/komisyon)
  transportation_service: 'seg-transfer',
  car_rental: 'seg-transfer',
  chauffeur_service: 'seg-transfer',
  ferry_service: 'seg-transfer',
  airport_shuttle_service: 'seg-transfer',

  // Kurumsal / MICE
  corporate_office: 'seg-mice',
  consultant: 'seg-mice',
  event_venue: 'seg-mice',
  association_or_organization: 'seg-mice',

  // Otel ama agency type'ta görünmüş — partner adayı
  hotel: 'seg-hotel-partner',
  lodging: 'seg-hotel-partner',
  resort_hotel: 'seg-hotel-partner',
  inn: 'seg-hotel-partner',
};

// Yat ile alakasız (yanlış scrape) — seg-irrelevant (eleme adayı)
const IRRELEVANT_TYPES = new Set([
  'store', 'finance', 'restaurant', 'bank', 'school', 'real_estate_agency',
  'shopping_mall', 'place_of_worship', 'government_office', 'local_government_office',
  'educational_institution', 'jewelry_store', 'cafe', 'market', 'clothing_store',
  'womens_clothing_store', 'home_goods_store', 'department_store', 'building_materials_store',
  'auto_parts_store', 'electronics_store', 'hair_salon', 'barber_shop', 'beauty_salon',
  'car_repair', 'car_dealer', 'bakery', 'pastry_shop', 'buffet_restaurant', 'supplier',
  'wholesaler', 'manufacturer', 'insurance_agency', 'telecommunications_service_provider',
  'sports_club', 'sports_complex', 'sports_activity_location', 'comedy_club',
  'general_contractor', 'moving_company', 'storage', 'shipping_service', 'transit_depot',
  'bus_stop',
]);

// ─── Trust mapping: rating_tier.tier → trust-* ────────────────────
const TRUST_MAP = {
  high_trust: 'trust-high',
  medium_trust: 'trust-medium',
  low_trust: 'trust-low',
};

function classifySegment(meta) {
  const gtype = (meta?.google_primary_type ?? '').trim();
  if (!gtype) return 'seg-unenriched';
  if (SEGMENT_MAP[gtype]) return SEGMENT_MAP[gtype];
  if (IRRELEVANT_TYPES.has(gtype)) return 'seg-irrelevant';
  return 'seg-other'; // enriched ama tanımsız type (service vb.)
}

function classifyTrust(meta) {
  const tier = meta?.rating_tier?.tier ?? '';
  return TRUST_MAP[tier] ?? 'trust-unknown';
}

// Eski seg-* / trust-* tag'lerini temizle, yenilerini ekle (idempotent)
function rebuildTags(existing, segTag, trustTag) {
  const kept = (existing ?? []).filter(
    (t) => !t.startsWith('seg-') && !t.startsWith('trust-'),
  );
  return [...kept, segTag, trustTag];
}

async function main() {
  console.log(`\n=== Agency Segmentasyon ${dryRun ? '(DRY-RUN)' : '(UYGULAMA)'} ===\n`);

  const leads = await sql`
    SELECT id, source_meta, tags
    FROM leads
    WHERE type = 'agency'
  `;
  console.log(`Toplam agency lead: ${leads.length}\n`);

  const segCounts = {};
  const trustCounts = {};
  const crossCounts = {}; // seg × trust
  const updates = [];

  for (const lead of leads) {
    const meta = lead.source_meta ?? {};
    const segTag = classifySegment(meta);
    const trustTag = classifyTrust(meta);

    segCounts[segTag] = (segCounts[segTag] ?? 0) + 1;
    trustCounts[trustTag] = (trustCounts[trustTag] ?? 0) + 1;
    const ck = `${segTag} × ${trustTag}`;
    crossCounts[ck] = (crossCounts[ck] ?? 0) + 1;

    const newTags = rebuildTags(lead.tags, segTag, trustTag);
    updates.push({ id: lead.id, tags: newTags });
  }

  // ─── Rapor ───
  console.log('--- Segment dağılımı ---');
  for (const [k, v] of Object.entries(segCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
  console.log('\n--- Trust dağılımı ---');
  for (const [k, v] of Object.entries(trustCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
  console.log('\n--- En kaliteli outreach havuzu (seg × trust, high+medium) ---');
  for (const [k, v] of Object.entries(crossCounts).sort((a, b) => b[1] - a[1])) {
    if (k.includes('trust-high') || k.includes('trust-medium')) {
      console.log(`  ${k.padEnd(38)} ${v}`);
    }
  }

  if (dryRun) {
    console.log('\n[DRY-RUN] DB değişmedi. Uygulamak için --dry-run olmadan çalıştır.\n');
    await sql.end();
    return;
  }

  // ─── DB'ye yaz (batch) ───
  console.log('\nDB güncelleniyor...');
  let done = 0;
  for (const u of updates) {
    await sql`UPDATE leads SET tags = ${u.tags} WHERE id = ${u.id}`;
    done++;
    if (done % 500 === 0) console.log(`  ${done}/${updates.length}`);
  }
  console.log(`\n✓ ${done} agency lead segmentlendi.\n`);

  await sql.end();
}

main().catch((e) => {
  console.error('HATA:', e);
  process.exit(1);
});
