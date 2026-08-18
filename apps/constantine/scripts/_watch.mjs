import postgres from 'postgres'; import fs from 'node:fs';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()]}));
const sql=postgres(env.DATABASE_URL);
const deadline=Date.now()+40*60*1000;
let son=0;
while(Date.now()<deadline){
  const [t]=await sql`select count(*)::int n from campaign_targets where sent_at::date=current_date`;
  if(t.n>son){
    son=t.n;
    for(const r of await sql`select c.name, l.company_name, l.primary_contact_email, to_char(ct.sent_at,'HH24:MI:SS') saat
      from campaign_targets ct join leads l on l.id=ct.lead_id join campaigns c on c.id=ct.campaign_id
      where ct.sent_at::date=current_date order by ct.sent_at desc limit 3`)
      console.log(`  ${r.saat}  [${r.name.split('—')[0].trim()}]  ${r.company_name} → ${r.primary_contact_email}`);
    console.log(`  --- bugün toplam: ${t.n}`);
  }
  if(son>=4) break;
  await new Promise(r=>setTimeout(r,45000));
}
console.log(son? `\n✓ gönderim başladı (${son})` : '\n⚠️ 40 dakikada hiç gönderim olmadı');
await sql.end();
