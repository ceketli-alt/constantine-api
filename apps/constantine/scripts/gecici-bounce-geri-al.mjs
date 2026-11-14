#!/usr/bin/env node
/**
 * Geçici (Transient) bounce yüzünden YANLIŞLIKLA bastırılan adresleri geri alır (15 Eki 2026).
 * Webhook eskiden her bounce'u kalıcı sayıp unsubscribes'e yazıyor + leadi opt-out yapıyordu.
 * Yalnızca ContentRejected: adresin SAĞLAM olduğu kanıtlı, reddedilen bizim içeriğimizdi.
 * MailboxFull/General geçici olsa da çoğu terk edilmiş kutudur — bastırılı kalmaları güvenli taraf.
 * Leadin status'u geri 'contacted' yapılır (opt-out öncesi zaten maillenmişti).
 * node gecici-bounce-geri-al.mjs [--uygula]
 */
import postgres from 'postgres'; import fs from 'node:fs';
const UYGULA = process.argv.includes('--uygula');
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const r = await sql`
  WITH b AS (
    SELECT lower(ev.raw_payload->'data'->'to'->>0) mail,
           bool_or(coalesce(ev.raw_payload->'data'->'bounce'->>'type','') <> 'Transient') kalici_var,
           max(ev.raw_payload->'data'->'bounce'->>'subType') alt_tur
    FROM email_events ev WHERE ev.event_type='bounced' GROUP BY 1)
  SELECT u.id uid, u.identifier, b.alt_tur, l.id lid, l.company_name, l.status::text durum, l.opted_out_reason
  FROM unsubscribes u JOIN b ON b.mail = lower(u.identifier)
  LEFT JOIN leads l ON lower(l.primary_contact_email) = lower(u.identifier)
  WHERE u.reason='hard_bounce' AND u.source='resend_webhook' AND NOT b.kalici_var AND b.alt_tur='ContentRejected'`;
console.log(`yanlışlıkla bastırılan: ${r.length}`);
for (const x of r) console.log(`  ${x.identifier.padEnd(34)} ${x.alt_tur.padEnd(16)} ${(x.company_name||'').slice(0,26).padEnd(26)} ${x.durum}`);
if (UYGULA) {
  for (const x of r) {
    await sql`DELETE FROM unsubscribes WHERE id=${x.uid}`;
    if (x.lid && x.durum === 'opted_out' && x.opted_out_reason === 'hard_bounce') {
      await sql`UPDATE leads SET status='contacted', opted_out_at=NULL, opted_out_channel=NULL, opted_out_reason=NULL WHERE id=${x.lid}`;
    }
  }
  console.log(`\n${r.length} adres bastırma listesinden çıkarıldı, leadler geri 'contacted'`);
} else console.log('\n(--uygula ile geri alınır)');
await sql.end();
