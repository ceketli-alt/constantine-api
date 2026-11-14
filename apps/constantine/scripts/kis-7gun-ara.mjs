#!/usr/bin/env node
/**
 * KIŞ %25 — aynı firmaya 7 günden sık mail gitmesin (Mert 22 Eki 2026: "her gün mail atıyorsunuz demesin").
 * Kuyruktaki her hedefin scheduled_at'i, o firmaya giden SON mailden en az 7 gün sonraya çekilir.
 * Worker scheduled_at'ten önce göndermez (campaign-worker.ts: scheduled_at <= now()).
 * node kis-7gun-ara.mjs [--uygula]
 */
import postgres from 'postgres'; import fs from 'node:fs';
const UYGULA = process.argv.includes('--uygula');
const K = '8b13f5cf-f383-47a4-ba80-e7cdbce8a31f', GUN = 7;
const env = Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sql = postgres(env.DATABASE_URL);
const q = sql`
  WITH son AS (
    SELECT th.lead_id, max(m.sent_at) son FROM email_messages m JOIN email_threads th ON th.id=m.thread_id
    WHERE m.direction='outbound' AND m.sent_at IS NOT NULL GROUP BY 1)
  SELECT t.id, t.scheduled_at, s.son + make_interval(days => ${GUN}) yeni
  FROM campaign_targets t JOIN son s ON s.lead_id=t.lead_id
  WHERE t.campaign_id=${K} AND t.status='queued'
    AND s.son + make_interval(days => ${GUN}) > COALESCE(t.scheduled_at, now())`;
const r = await q;
console.log(`ertelenecek: ${r.length} hedef`);
const gun = {}; for (const x of r) { const d = new Date(x.yeni).toISOString().slice(0, 10); gun[d] = (gun[d] || 0) + 1; }
console.log(Object.entries(gun).sort().map(([d, n]) => `  ${d}: ${n}`).join('\n'));
if (UYGULA && r.length) {
  const u = await sql`
    WITH son AS (
      SELECT th.lead_id, max(m.sent_at) son FROM email_messages m JOIN email_threads th ON th.id=m.thread_id
      WHERE m.direction='outbound' AND m.sent_at IS NOT NULL GROUP BY 1)
    UPDATE campaign_targets t SET scheduled_at = s.son + make_interval(days => ${GUN})
    FROM son s WHERE s.lead_id=t.lead_id AND t.campaign_id=${K} AND t.status='queued'
      AND s.son + make_interval(days => ${GUN}) > COALESCE(t.scheduled_at, now())`;
  console.log(`${u.count} hedef ertelendi`);
} else if (r.length) console.log('(--uygula ile yazılır)');
await sql.end();
