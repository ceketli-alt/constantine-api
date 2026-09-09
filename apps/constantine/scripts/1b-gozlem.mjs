#!/usr/bin/env node
/**
 * 1B GOZLEM — outreach@ kutusu 22 Haz'dan beri sessizdi, 26 Agu'da temiz kuyrukla acildi.
 * Tek dis sinyalimiz bounce ve cevap (placement testi yok). Gunde bir bakmak yeter.
 * node 1b-gozlem.mjs
 */
import postgres from 'postgres'; import fs from 'node:fs';
const KAMPANYA='3c0e9cad-ea5f-4ff3-8df8-54365f113e4a';
const ACILIS='2026-08-26';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);

const [d] = await sql`
  SELECT count(*) FILTER (WHERE status='queued')::int kuyruk,
         count(*) FILTER (WHERE status='sent' AND sent_at::date >= ${ACILIS}::date)::int gonderilen,
         count(*) FILTER (WHERE status='replied')::int cevap,
         count(*) FILTER (WHERE status='failed' AND created_at::date >= ${ACILIS}::date)::int basarisiz
  FROM campaign_targets WHERE campaign_id=${KAMPANYA}`;
const olay = await sql`
  SELECT ev.event_type, count(*)::int n FROM email_events ev
  JOIN email_messages m ON m.id=ev.message_id
  WHERE m.campaign_id=${KAMPANYA} AND ev.occurred_at::date >= ${ACILIS}::date
  GROUP BY 1 ORDER BY 2 DESC`;
const [w] = await sql`SELECT paused_reason, paused_until, sent_today, bounce_count_24h
  FROM campaign_warmup_state WHERE campaign_id=${KAMPANYA}`;

console.log(`PHASE 1B — outreach@constantineyachts.online  (acilis ${ACILIS})`);
console.log(`  kuyruk ${d.kuyruk} · acilistan beri gonderilen ${d.gonderilen} · cevap ${d.cevap} · basarisiz ${d.basarisiz}`);
console.log(`  olaylar: ${olay.length ? olay.map(o=>`${o.event_type}=${o.n}`).join(' · ') : '(hic olay yok — Resend webhook gecikmesi olabilir)'}`);
console.log(`  warmup: bugun ${w?.sent_today ?? '?'} · bounce24h ${w?.bounce_count_24h ?? '?'}` +
            (w?.paused_reason ? ` · ⚠️ DURDU: ${w.paused_reason} → ${w.paused_until?.toISOString?.().slice(0,16)}` : ' · durdurma yok'));
const bounced = olay.find(o=>o.event_type==='bounced')?.n ?? 0;
if (d.gonderilen >= 10) {
  const oran = (bounced / d.gonderilen * 100).toFixed(1);
  console.log(`\n  bounce orani: %${oran} (${bounced}/${d.gonderilen})` +
    (bounced/d.gonderilen > 0.05 ? '  ← YUKSEK, kutuyu tekrar durdurmayi konus' : '  ← saglikli'));
} else {
  console.log(`\n  (henuz ${d.gonderilen} gonderim — oran yorumu icin en az 10 gerekli)`);
}
await sql.end();
