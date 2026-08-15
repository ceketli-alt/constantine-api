#!/usr/bin/env node
/**
 * Kampanya otomatik dolum — "sürekli sıkıntısız devam" (Mert, 2026-08-14).
 *
 * Her kampanya için: queued < LOW_WATER ise havuzdan yeni lead enroll eder,
 * NeverBounce ile doğrular, çürükleri düşürür + suppress eder.
 *
 * Cron: /etc/cron.d/constantine-mert-reminders → hafta içi 06:15 UTC (09:15 TR),
 * yani gönderim penceresi (09:30 TR) açılmadan hemen önce.
 *
 * Log: /root/monitor/campaign-autofill.log
 * Havuz tükenirse: uyarı maili (mert-reminder.sh pool-empty) + sessizce çıkar.
 *
 * NOT: node_modules çözümlemesi için bu dosya constantine/scripts altında durmalı.
 */
import postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const ENV_PATH = '/var/www/api/apps/constantine/.env';
const env = Object.fromEntries(
  fs.readFileSync(ENV_PATH, 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const sql = postgres(env.DATABASE_URL);
const NB_KEY = env.NEVERBOUNCE_API_KEY;

const CAMPAIGNS = [
  {
    id: '577169eb-d3d3-45e6-9d1e-4c6844b4e6d6',
    label: 'CANARY (gmail)',
    lowWater: 60,
    batch: 250,
    poolFilter: sql`l.primary_contact_email ILIKE '%@gmail.com'`,
  },
  {
    id: '018f99ba-cea8-4a1b-9bab-466801f5810f',
    label: 'PHASE-1C (kurumsal)',
    lowWater: 30,
    batch: 150,
    poolFilter: sql`
      l.primary_contact_email IS NOT NULL
      AND 'email-valid' = ANY(l.tags)
      AND NOT EXISTS (SELECT 1 FROM free_email_domains f
        WHERE lower(split_part(l.primary_contact_email,'@',2)) = f.domain)`,
  },
];

const log = (m) => {
  const line = `${new Date().toISOString()} ${m}`;
  console.log(line);
  try { fs.appendFileSync('/root/monitor/campaign-autofill.log', line + '\n'); } catch {}
};

async function neverbounce(emails) {
  const out = {};
  for (const email of emails) {
    try {
      const u = new URL('https://api.neverbounce.com/v4/single/check');
      u.searchParams.set('key', NB_KEY);
      u.searchParams.set('email', email);
      const d = await (await fetch(u)).json();
      out[email] = d.status === 'success' ? (d.result || 'error') : 'error';
    } catch { out[email] = 'error'; }
    await new Promise(r => setTimeout(r, 200));
  }
  return out;
}

const anyPoolEmpty = [];

for (const c of CAMPAIGNS) {
  const [{ status }] = await sql`SELECT status FROM campaigns WHERE id=${c.id}`;
  const [{ n: queued }] = await sql`
    SELECT count(*)::int n FROM campaign_targets WHERE campaign_id=${c.id} AND status='queued'`;

  if (queued >= c.lowWater) { log(`${c.label}: queued=${queued} (eşik ${c.lowWater}) — dolum gerekmiyor`); continue; }

  const candidates = await sql`
    SELECT l.id FROM leads l
    WHERE l.last_contacted_at IS NULL AND l.status='new'
      AND NOT ('seg-irrelevant' = ANY(l.tags))
      AND ${c.poolFilter}
      AND NOT EXISTS (SELECT 1 FROM unsubscribes u
        WHERE u.channel='email' AND lower(u.identifier)=lower(l.primary_contact_email))
      AND NOT EXISTS (SELECT 1 FROM campaign_targets ct
        WHERE ct.campaign_id=${c.id} AND ct.lead_id=l.id)
    ORDER BY (CASE WHEN 'trust-high'=ANY(l.tags) THEN 0
                   WHEN 'trust-medium'=ANY(l.tags) THEN 1 ELSE 2 END),
             l.created_at DESC
    LIMIT ${c.batch}`;

  if (candidates.length === 0) {
    log(`${c.label}: ⚠️ HAVUZ BOŞ — queued=${queued}, enroll edilecek lead yok`);
    anyPoolEmpty.push(`${c.label} (kalan kuyruk: ${queued})`);
    continue;
  }

  const ids = candidates.map(r => r.id);
  const [{ result }] = await sql`
    SELECT eligible_leads_for_campaign(${c.id}::uuid, ${ids}::uuid[], NULL) AS result`;
  const eligible = Array.isArray(result?.eligible) ? result.eligible : [];
  if (eligible.length === 0) { log(`${c.label}: triaj sonrası uygun lead yok`); continue; }

  const inserted = await sql`
    INSERT INTO campaign_targets (campaign_id, lead_id, status, sequence_step)
    SELECT ${c.id}::uuid, x::uuid, 'queued', 0 FROM unnest(${eligible}::uuid[]) x
    ON CONFLICT (campaign_id, lead_id) DO NOTHING
    RETURNING lead_id`;
  log(`${c.label}: +${inserted.length} enroll (queued ${queued} → ${queued + inserted.length})`);

  if (NB_KEY && inserted.length) {
    const fresh = await sql`
      SELECT ct.id, lower(l.primary_contact_email) AS email
      FROM campaign_targets ct JOIN leads l ON l.id=ct.lead_id
      WHERE ct.campaign_id=${c.id} AND ct.status='queued'
        AND ct.lead_id = ANY(${inserted.map(r => r.lead_id)}::uuid[])`;
    const verdicts = await neverbounce([...new Set(fresh.map(r => r.email))]);
    let dropped = 0;
    for (const r of fresh) {
      const v = verdicts[r.email];
      if (v === 'invalid' || v === 'disposable') {
        await sql`UPDATE campaign_targets SET status='failed', error=${'neverbounce:' + v} WHERE id=${r.id}`;
        await sql`INSERT INTO unsubscribes (channel, identifier, reason, source)
          SELECT 'email', ${r.email}, ${'neverbounce_' + v}, 'neverbounce'
          WHERE NOT EXISTS (SELECT 1 FROM unsubscribes WHERE channel='email' AND lower(identifier)=${r.email})`;
        dropped++;
      }
    }
    log(`${c.label}: NeverBounce → ${dropped} çürük düşürüldü`);
  }

  if (status === 'completed') {
    await sql`UPDATE campaigns SET status='running', completed_at=NULL WHERE id=${c.id}`;
    log(`${c.label}: completed → running (diriltildi)`);
  }
  await sql`UPDATE campaigns SET target_count=(
    SELECT count(*) FROM campaign_targets WHERE campaign_id=${c.id}) WHERE id=${c.id}`;
}

if (anyPoolEmpty.length) {
  try {
    execFileSync('/root/monitor/mert-reminder.sh', ['pool-empty'], {
      env: { ...process.env, POOL_EMPTY_DETAIL: anyPoolEmpty.join(' · ') },
    });
    log(`havuz-boş uyarı maili gönderildi: ${anyPoolEmpty.join(' · ')}`);
  } catch (e) { log(`uyarı maili gönderilemedi: ${e.message}`); }
}

await sql.end();
log('autofill tamam');
