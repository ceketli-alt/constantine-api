import 'dotenv/config';
import { sql } from '../src/db.js';
// Tag-based filter — daha doğru
const tagged = await sql`SELECT count(*)::int as c FROM leads WHERE 'agent-day-2026-06-04' = ANY(tags)`;
const camp = await sql`SELECT id, name, status, daily_cap, send_window_start, send_window_end FROM campaigns WHERE name='Warmup Batch — Agent Day 2026-06-04'`;
const targets = await sql`SELECT count(*)::int as c FROM campaign_targets WHERE campaign_id=${camp[0].id}`;
const byWarmup = await sql`
  SELECT
    CASE
      WHEN 'warmup-pzt' = ANY(tags) THEN 'Pzt 2026-06-08'
      WHEN 'warmup-sal' = ANY(tags) THEN 'Sal 2026-06-09'
      WHEN 'warmup-car' = ANY(tags) THEN 'Çar 2026-06-10'
      WHEN 'warmup-per' = ANY(tags) THEN 'Per 2026-06-11'
      WHEN 'warmup-cum' = ANY(tags) THEN 'Cum 2026-06-12'
      ELSE 'unknown'
    END as gun,
    count(*)::int as sayi
  FROM leads WHERE 'agent-day-2026-06-04' = ANY(tags)
  GROUP BY gun ORDER BY gun
`;
const byTemp = await sql`SELECT temperature, count(*)::int as c FROM leads WHERE 'agent-day-2026-06-04' = ANY(tags) GROUP BY temperature ORDER BY count(*)::int DESC`;
const mednificant = await sql`SELECT company_name, primary_contact_name, primary_contact_email, temperature, array_length(tags, 1) as tag_count, custom_fields->>'mail_subject' as subj FROM leads WHERE 'agent-day-2026-06-04' = ANY(tags) AND primary_contact_email='info@mednificant.com'`;
const all19 = await sql`SELECT company_name, primary_contact_name FROM leads WHERE 'agent-day-2026-06-04' = ANY(tags) ORDER BY company_name`;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('AGENT DAY 2026-06-04 — CRM Doğrulama (tag-based)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`🏷️  Agent Day tag'li lead              : ${tagged[0].c}   ${tagged[0].c === 19 ? '✅' : '❌'} (beklenen 19)`);
console.log(`📋 Campaign                          : ${camp[0].id}`);
console.log(`    name                             : ${camp[0].name}`);
console.log(`    status                           : ${camp[0].status}  (worker dokunmaz)`);
console.log(`    daily_cap                        : ${camp[0].daily_cap}`);
console.log(`    send_window                      : ${camp[0].send_window_start} - ${camp[0].send_window_end}`);
console.log(`🎯 Campaign target sayısı            : ${targets[0].c}   ${targets[0].c === 19 ? '✅' : '❌'} (beklenen 19)`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📅 Warmup gün dağılımı:');
byWarmup.forEach((r: any) => console.log(`     ${r.gun} : ${r.sayi} lead`));
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🌡️  Temperature:');
byTemp.forEach((r: any) => console.log(`     ${r.temperature.padEnd(5)} : ${r.c}`));
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔍 Mednificant özel kontrol:');
if (mednificant[0]) {
  const m = mednificant[0];
  console.log(`     ✅ Bulundu`);
  console.log(`     Firma   : ${m.company_name}`);
  console.log(`     Kişi    : ${m.primary_contact_name}`);
  console.log(`     Email   : ${m.primary_contact_email}`);
  console.log(`     Temp    : ${m.temperature}`);
  console.log(`     Tag sayısı: ${m.tag_count}`);
  console.log(`     Subject : ${m.subj}`);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📋 19 lead listesi (alfabetik):');
all19.forEach((r: any, i: number) => console.log(`  ${String(i+1).padStart(2,' ')}. ${r.company_name} — ${r.primary_contact_name}`));
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
await sql.end();
