#!/usr/bin/env node
/**
 * validate-leads.mjs — Lead email validation pipeline
 *
 * 5844 lead'in primary_contact_email'ini batch'ler halinde validate eder.
 * Sonuç:
 *   - lead.custom_fields.email_validation = { status, validated_at, code, source }
 *   - lead.tags += [email-valid | email-invalid | email-risky | email-disposable]
 *
 * İki provider destekleniyor (env değişkeniyle seç):
 *   - PROVIDER=neverbounce  → NEVERBOUNCE_API_KEY gerekir
 *   - PROVIDER=bouncer      → BOUNCER_API_KEY gerekir (default)
 *
 * Kullanım:
 *   node validate-leads.mjs --dry-run            # sadece kaç lead'i etkileyeceğini göster
 *   node validate-leads.mjs --limit 100          # ilk 100 lead'i validate et
 *   node validate-leads.mjs --segment 5star_chain --resume
 *   node validate-leads.mjs --revalidate         # daha önce valide edilmişleri de yeniden gönder
 *
 * Cost (5844 lead):
 *   - NeverBounce: ~$47 (5844 × $0.008)
 *   - Bouncer:     ~$20 (5844 × $0.0035)
 */
import 'dotenv/config';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL eksik (.env)');
  process.exit(1);
}

const PROVIDER = (process.env.EMAIL_VALIDATOR_PROVIDER || 'bouncer').toLowerCase();
const NEVERBOUNCE_API_KEY = process.env.NEVERBOUNCE_API_KEY || '';
const BOUNCER_API_KEY = process.env.BOUNCER_API_KEY || '';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const revalidate = args.has('--revalidate');
const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx > -1 ? parseInt(process.argv[limitIdx + 1], 10) : null;
const segmentIdx = process.argv.indexOf('--segment');
const segment = segmentIdx > -1 ? process.argv[segmentIdx + 1] : null;

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 1000;

const sql = postgres(DATABASE_URL);

// ─── 1. Provider abstractions ─────────────────────────────────────

/** Verify a batch of emails. Returns: [{email, status, code, source}] */
async function verifyBatch(emails) {
  if (PROVIDER === 'neverbounce') return verifyNeverBounce(emails);
  if (PROVIDER === 'bouncer') return verifyBouncer(emails);
  throw new Error(`Unsupported provider: ${PROVIDER}`);
}

async function verifyNeverBounce(emails) {
  if (!NEVERBOUNCE_API_KEY) throw new Error('NEVERBOUNCE_API_KEY eksik');
  const results = [];
  for (const email of emails) {
    const url = new URL('https://api.neverbounce.com/v4/single/check');
    url.searchParams.set('key', NEVERBOUNCE_API_KEY);
    url.searchParams.set('email', email);
    const res = await fetch(url.toString());
    const data = await res.json();
    // NeverBounce result codes: valid, invalid, disposable, catchall, unknown
    results.push({
      email,
      status: mapNeverBounceStatus(data.result),
      code: data.result || 'error',
      source: 'neverbounce',
      raw: data,
    });
    await sleep(200); // 5 req/sec
  }
  return results;
}

function mapNeverBounceStatus(result) {
  switch (result) {
    case 'valid': return 'valid';
    case 'invalid': return 'invalid';
    case 'disposable': return 'disposable';
    case 'catchall': return 'risky';
    case 'unknown': return 'risky';
    default: return 'unknown';
  }
}

async function verifyBouncer(emails) {
  if (!BOUNCER_API_KEY) throw new Error('BOUNCER_API_KEY eksik');
  // Bouncer single email verification endpoint
  const results = [];
  for (const email of emails) {
    const res = await fetch(`https://api.usebouncer.com/v1.1/email/verify?email=${encodeURIComponent(email)}`, {
      headers: { 'x-api-key': BOUNCER_API_KEY },
    });
    const data = await res.json();
    // Bouncer status: deliverable, undeliverable, risky, unknown
    results.push({
      email,
      status: mapBouncerStatus(data.status),
      code: data.reason || data.status || 'error',
      source: 'bouncer',
      raw: data,
    });
    await sleep(200);
  }
  return results;
}

function mapBouncerStatus(status) {
  switch (status) {
    case 'deliverable': return 'valid';
    case 'undeliverable': return 'invalid';
    case 'risky': return 'risky';
    case 'disposable': return 'disposable';
    case 'unknown': return 'risky';
    default: return 'unknown';
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── 2. Lead fetch ────────────────────────────────────────────────

async function fetchPendingLeads() {
  const where = [];
  if (!revalidate) where.push(sql`NOT (custom_fields ? 'email_validation')`);
  if (segment) where.push(sql`segment = ${segment}`);
  where.push(sql`primary_contact_email IS NOT NULL AND primary_contact_email != ''`);

  const whereClause = where.length
    ? sql`WHERE ${where.reduce((acc, w, i) => i === 0 ? w : sql`${acc} AND ${w}`)}`
    : sql``;

  const limitClause = limit ? sql`LIMIT ${limit}` : sql``;

  return sql`
    SELECT id, primary_contact_email, company_name, segment, tags
    FROM leads
    ${whereClause}
    ORDER BY score DESC NULLS LAST, created_at ASC
    ${limitClause}
  `;
}

// ─── 3. Write results back ────────────────────────────────────────

async function writeResult(lead, result) {
  const validationObj = {
    status: result.status,
    code: result.code,
    source: result.source,
    validated_at: new Date().toISOString(),
  };

  // Tag mapping
  const tagsToRemove = ['email-valid', 'email-invalid', 'email-risky', 'email-disposable'];
  const newTag = `email-${result.status}`;
  const currentTags = lead.tags || [];
  const updatedTags = [...currentTags.filter(t => !tagsToRemove.includes(t)), newTag];

  await sql`
    UPDATE leads
    SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || ${sql.json({ email_validation: validationObj })},
        tags = ${updatedTags},
        updated_at = now()
    WHERE id = ${lead.id}
  `;
}

// ─── 4. Main ──────────────────────────────────────────────────────

async function main() {
  console.log(`\n📧 Lead Validation — Provider: ${PROVIDER}`);
  console.log(`   Mode: ${dryRun ? 'DRY-RUN' : 'LIVE'}, Segment: ${segment || 'all'}, Limit: ${limit || 'none'}, Revalidate: ${revalidate}\n`);

  const pending = await fetchPendingLeads();
  console.log(`   Pending leads: ${pending.length}`);

  if (dryRun) {
    const bySegment = pending.reduce((acc, l) => {
      acc[l.segment] = (acc[l.segment] || 0) + 1;
      return acc;
    }, {});
    console.log('   Distribution by segment:');
    Object.entries(bySegment).forEach(([s, n]) => console.log(`     ${s}: ${n}`));
    const estCost = PROVIDER === 'neverbounce' ? pending.length * 0.008 : pending.length * 0.0035;
    console.log(`\n   Estimated cost: $${estCost.toFixed(2)}\n`);
    await sql.end();
    return;
  }

  if (PROVIDER === 'neverbounce' && !NEVERBOUNCE_API_KEY) {
    console.error('NEVERBOUNCE_API_KEY eksik. .env\'e ekleyin.');
    process.exit(1);
  }
  if (PROVIDER === 'bouncer' && !BOUNCER_API_KEY) {
    console.error('BOUNCER_API_KEY eksik. .env\'e ekleyin.');
    process.exit(1);
  }

  let processed = 0;
  let stats = { valid: 0, invalid: 0, risky: 0, disposable: 0, unknown: 0, error: 0 };

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const emails = batch.map(l => l.primary_contact_email);

    try {
      const results = await verifyBatch(emails);
      for (let j = 0; j < results.length; j++) {
        const lead = batch[j];
        const result = results[j];
        await writeResult(lead, result);
        stats[result.status] = (stats[result.status] || 0) + 1;
        processed++;
      }
      const pct = ((processed / pending.length) * 100).toFixed(1);
      console.log(`   [${pct}%] ${processed}/${pending.length} — valid:${stats.valid} invalid:${stats.invalid} risky:${stats.risky} disposable:${stats.disposable}`);
    } catch (e) {
      console.error(`   Batch ${i} HATA:`, e.message);
      stats.error += batch.length;
      processed += batch.length;
    }

    await sleep(BATCH_DELAY_MS);
  }

  console.log('\n✅ Tamamlandı:');
  console.log(`   Valid:      ${stats.valid}`);
  console.log(`   Invalid:    ${stats.invalid}`);
  console.log(`   Risky:      ${stats.risky}`);
  console.log(`   Disposable: ${stats.disposable}`);
  console.log(`   Unknown:    ${stats.unknown}`);
  console.log(`   Errors:     ${stats.error}`);
  const usableRate = ((stats.valid / processed) * 100).toFixed(1);
  console.log(`\n   Usable rate: ${usableRate}%\n`);

  await sql.end();
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
