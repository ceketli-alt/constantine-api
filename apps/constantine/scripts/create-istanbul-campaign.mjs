/**
 * Istanbul acente kampanyasini kurar (site kazisiyla bulunan 164 lead icin).
 * Canary kampanyasinin satirini kopyalar, sadece gerekli alanlari degistirir.
 * Calistirma: node create-istanbul-campaign.mjs [--dry]
 */
import postgres from 'postgres';
import fs from 'node:fs';

const DRY = process.argv.includes('--dry');
const CANARY = '577169eb-d3d3-45e6-9d1e-4c6844b4e6d6';
const NAME = 'İstanbul Acente — Site Kazısı (16 Ağu)';

const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sql = postgres(env.DATABASE_URL);

const [dup] = await sql`SELECT id FROM campaigns WHERE name=${NAME}`;
if (dup) { console.log('zaten var:', dup.id); await sql.end(); process.exit(0); }

if (DRY) {
  const [c] = await sql`SELECT * FROM campaigns WHERE id=${CANARY}`;
  console.log('[DRY] kopyalanacak sablon kampanya:', c.name);
  console.log('[DRY] yeni ad:', NAME, '| cap 15 | exclude_free_email true | pool 4 kutu');
  await sql.end(); process.exit(0);
}

const [row] = await sql`
  INSERT INTO campaigns (
    name, description, status, cron_paused, channel, template_id,
    sender_email, sender_pool, exclude_free_email, segment_filter,
    daily_cap, max_new_leads_per_day, max_per_company_per_day,
    min_gap_seconds, random_gap_seconds, cooldown_days, respect_global_cooldown,
    prioritize_new_leads, send_days, send_window_start, send_window_end,
    send_text_only, first_email_text_only, warmup_enabled, follow_up_steps,
    stop_company_on_reply, auto_create_deal_on_hot_reply, auto_deal_min_confidence,
    ab_test_enabled, target_count, created_by, started_at
  )
  SELECT
    ${NAME},
    'Mert 2020 acente listesinden site kazisiyla bulunan gercek e-postali Istanbul acenteleri (tag: ist-yeni)',
    'running', false, channel, template_id,
    'mert@constantineboat.online',
    sender_pool, true,
    ${sql.json({ note: 'Istanbul acente - siteden kazinan gercek adresler, ist-yeni etiketli' })},
    15, 15, max_per_company_per_day,
    min_gap_seconds, random_gap_seconds, cooldown_days, respect_global_cooldown,
    prioritize_new_leads, send_days, send_window_start, send_window_end,
    send_text_only, first_email_text_only, warmup_enabled, follow_up_steps,
    stop_company_on_reply, auto_create_deal_on_hot_reply, auto_deal_min_confidence,
    ab_test_enabled, 0, created_by, now()
  FROM campaigns WHERE id=${CANARY}
  RETURNING id, name, status, daily_cap, sender_pool, template_id`;

console.log('✓ kampanya kuruldu');
console.log(JSON.stringify(row, null, 1));
await sql.end();
