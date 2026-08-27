#!/usr/bin/env node
/**
 * Kimlik denetiminden GECEN leadleri kampanyaya enroll eder.
 *
 * Girdi: /root/acente-data-2026-08/1c-havuz-kimlik.csv (sinif=ESLESTI olanlar)
 * Kural: sadece ESLESTI yuklenir. KISMI/ESLESMEDI elde tutulur — bunlar
 *        NeverBounce'tan gecse bile BASKA sirkete ait olabilir.
 *
 * Ayrica IST-ACENTE kuyrugunu kalan ist-yeni havuzuyla tamamlar.
 * --dry ile yalnizca sayar, yazmaz.
 */
import postgres from 'postgres';
import fs from 'node:fs';

const DRY = process.argv.includes('--dry');
const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sql = postgres(env.DATABASE_URL);

const C1 = '018f99ba-cea8-4a1b-9bab-466801f5810f';
const IST = 'cf291a24-25e5-4b68-98a4-6a621f425513';

async function enroll(campaignId, label, leadIds) {
  if (!leadIds.length) { console.log(`${label}: enroll edilecek lead yok`); return 0; }
  const [{ result }] = await sql`
    SELECT eligible_leads_for_campaign(${campaignId}::uuid, ${leadIds}::uuid[], NULL) AS result`;
  const eligible = Array.isArray(result?.eligible) ? result.eligible : [];
  const dropped = leadIds.length - eligible.length;
  console.log(`${label}: aday=${leadIds.length} → triaj sonrasi uygun=${eligible.length} (elenen ${dropped})`);
  if (!eligible.length || DRY) return eligible.length;
  const ins = await sql`
    INSERT INTO campaign_targets (campaign_id, lead_id, status, sequence_step)
    SELECT ${campaignId}::uuid, x::uuid, 'queued', 0 FROM unnest(${eligible}::uuid[]) x
    ON CONFLICT (campaign_id, lead_id) DO NOTHING
    RETURNING lead_id`;
  console.log(`${label}: ✓ ${ins.length} lead kuyruga eklendi`);
  return ins.length;
}

// --- 1) Kimlik denetiminden gecen kurumsal havuz -> PHASE 1C
const csv = fs.readFileSync('/root/acente-data-2026-08/1c-havuz-kimlik.csv', 'utf8').split('\n').slice(1);
const verified = csv.filter(l => l.startsWith('ESLESTI,')).map(l => l.split(',').pop().trim()).filter(Boolean);
console.log(`kimlik denetiminden gecen (ESLESTI): ${verified.length}\n`);
await enroll(C1, 'PHASE-1C', verified);

// --- 2) IST-ACENTE kalan havuz
const rest = await sql`
  SELECT l.id FROM leads l
  WHERE 'ist-yeni' = ANY(l.tags) AND l.last_contacted_at IS NULL AND l.status='new'
    AND l.primary_contact_email IS NOT NULL AND l.primary_contact_email <> ''
    AND NOT EXISTS (SELECT 1 FROM unsubscribes u
      WHERE u.channel='email' AND lower(u.identifier)=lower(l.primary_contact_email))
    AND NOT EXISTS (SELECT 1 FROM campaign_targets ct WHERE ct.campaign_id=${IST} AND ct.lead_id=l.id)`;
console.log('');
await enroll(IST, 'IST-ACENTE', rest.map(r => r.id));

console.log('\n=== SON DURUM ===');
console.table(await sql`
  SELECT c.name, c.priority, c.daily_cap,
    (SELECT count(*)::int FROM campaign_targets t WHERE t.campaign_id=c.id AND t.status='queued') kuyruk
  FROM campaigns c WHERE c.status='running' ORDER BY c.priority`);
await sql.end();
