#!/usr/bin/env node
/**
 * Geçmiş giden maillerin SMTP Message-ID'sini email_events'teki Resend bildiriminden doldurur.
 * (8 Eki 2026: hiçbir giden mailde message_id_header yoktu → cevaplar maile bağlanamıyordu.)
 * Yalnızca boş olanları doldurur; idempotent.
 */
import postgres from 'postgres'; import fs from 'node:fs';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const r = await sql`
  UPDATE email_messages m SET message_id_header = x.mid
  FROM (
    SELECT DISTINCT ON (e.message_id) e.message_id,
           regexp_replace(e.raw_payload->'data'->>'message_id', '^[<\\s]+|[>\\s]+$', '', 'g') AS mid
    FROM email_events e WHERE e.raw_payload->'data'->>'message_id' IS NOT NULL
    ORDER BY e.message_id, e.occurred_at
  ) x
  WHERE m.id = x.message_id AND m.direction='outbound' AND m.message_id_header IS NULL`;
console.log(`doldurulan: ${r.count}`);
const [s] = await sql`SELECT count(*) FILTER (WHERE message_id_header IS NOT NULL)::int dolu, count(*)::int toplam
  FROM email_messages WHERE direction='outbound' AND campaign_id IS NOT NULL`;
console.log(`kampanya mailleri: ${s.dolu}/${s.toplam} Message-ID taşıyor`);
const [o] = await sql`SELECT message_id_header FROM email_messages WHERE direction='outbound' AND message_id_header IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
console.log('örnek (köşeli parantezsiz olmalı):', o?.message_id_header);
await sql.end();
