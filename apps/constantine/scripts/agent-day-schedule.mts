import 'dotenv/config';
import { sql } from '../src/db.js';
const CAMPAIGN_ID = 'cc7f3817-8dba-4436-ad70-cc1cf83bc46a';
const SCHEDULED = '2026-06-08 13:00:00+03';
const rows = await sql`
  UPDATE campaigns SET
    scheduled_at = ${SCHEDULED}::timestamptz,
    description  = description || E'\n\nLAUNCH PLANI: Pazartesi 2026-06-08 13:00 (TR) itibariyle. Mert manuel onayda status=running yapar.\nSend window 10:00-17:30 TR, daily_cap=20, warmup_enabled.'
  WHERE id = ${CAMPAIGN_ID}
  RETURNING id, name, status, scheduled_at, daily_cap, send_window_start, send_window_end
`;
const r = rows[0];
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('CAMPAIGN SCHEDULE GÜNCELLENDİ');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📋 ID            : ${r.id}`);
console.log(`📋 Name          : ${r.name}`);
console.log(`📋 Status        : ${r.status}  ← Mert manuel UPDATE ile 'running' yapacak`);
console.log(`⏰ Scheduled at  : ${new Date(r.scheduled_at).toISOString()} (UTC)`);
console.log(`⏰ TR saati      : ${new Date(r.scheduled_at).toLocaleString('tr-TR', {timeZone: 'Europe/Istanbul'})}`);
console.log(`📤 Daily cap     : ${r.daily_cap}`);
console.log(`📤 Send window   : ${r.send_window_start} - ${r.send_window_end} (TR)`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🚀 LAUNCH KOMUTU (Pzt 2026-06-08 12:55 civarı):');
console.log(`     UPDATE campaigns SET status='running', started_at=now() WHERE id='${CAMPAIGN_ID}';`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
await sql.end();
