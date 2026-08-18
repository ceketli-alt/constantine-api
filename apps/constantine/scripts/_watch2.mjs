import postgres from 'postgres'; import fs from 'node:fs';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()]}));
const sql=postgres(env.DATABASE_URL);
const IST='cf291a24-25e5-4b68-98a4-6a621f425513';
const deadline=Date.now()+5.5*60*60*1000;
let son=0;
while(Date.now()<deadline){
  const [t]=await sql`select count(*)::int n from campaign_targets where campaign_id=${IST} and sent_at::date=current_date`;
  if(t.n>son){
    for(const r of await sql`select to_char(ct.sent_at,'HH24:MI') s, l.company_name, l.primary_contact_email, l.district
      from campaign_targets ct join leads l on l.id=ct.lead_id
      where ct.campaign_id=${IST} and ct.sent_at::date=current_date order by ct.sent_at desc limit ${t.n-son}`)
      console.log(`  ${r.s}  ${r.company_name} (${r.district}) → ${r.primary_contact_email}`);
    son=t.n;
  }
  if(son>=3) break;
  await new Promise(r=>setTimeout(r,180000));
}
if(son){
  const [b]=await sql`select count(*)::int n from email_messages where bounced_at::date=current_date`;
  const [d]=await sql`select count(*)::int n from email_messages where delivered_at::date=current_date`;
  console.log(`\n✓ İSTANBUL KAMPANYASI BAŞLADI — ${son} mail çıktı`);
  console.log(`bugün genel: teslim ${d.n} · bounce ${b.n}`);
} else console.log('\n⚠️ İstanbul kampanyası hâlâ sıraya girmedi');
await sql.end();
