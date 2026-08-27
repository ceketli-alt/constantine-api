#!/usr/bin/env node
/**
 * ARAFTAKI LEADLER — Istanbul kazisindan gelen gercek adresler ama bedava-mail.
 * Istanbul kampanyasi kurumsal-only diye reddediyor, Canary de kuyrugu esigin
 * ustunde oldugu icin hic cekmiyor → kimse almiyordu.
 *
 * Karar: gmail olanlar Canary'ye (gmail hatti, saglikli: 7 gunde 30 teslim 0 bounce).
 * 'admin@mail.com' gibi jenerik yer tutucular ELENIR — gercek is kutusu degil.
 */
import postgres from 'postgres';
import fs from 'node:fs';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
  .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const CANARY='577169eb-d3d3-45e6-9d1e-4c6844b4e6d6';
const IST='cf291a24-25e5-4b68-98a4-6a621f425513';

// jenerik/yer tutucu adresler — gercek firma kutusu degil
const SAHTE=[/^admin@mail\.com$/i, /^info@mail\.com$/i, /^test@/i, /^example@/i, /@example\./i];

const rows=await sql`
  SELECT l.id, l.company_name, l.primary_contact_email mail FROM leads l
  WHERE 'ist-yeni'=ANY(l.tags) AND l.last_contacted_at IS NULL AND l.status='new'
    AND NOT EXISTS (SELECT 1 FROM campaign_targets t WHERE t.campaign_id=${IST} AND t.lead_id=l.id)`;

const sahte=rows.filter(r=>SAHTE.some(re=>re.test(r.mail)));
const gmail=rows.filter(r=>/@gmail\.com$/i.test(r.mail));
const diger=rows.filter(r=>!sahte.includes(r) && !gmail.includes(r));

console.log(`arafta: ${rows.length} | gmail: ${gmail.length} | sahte: ${sahte.length} | diger: ${diger.length}`);
sahte.forEach(r=>console.log(`  [ELENDI-SAHTE] ${r.company_name} ${r.mail}`));
diger.forEach(r=>console.log(`  [ARAMA LISTESI] ${r.company_name} ${r.mail}`));

if (gmail.length) {
  const ids=gmail.map(r=>r.id);
  const [{result}]=await sql`SELECT eligible_leads_for_campaign(${CANARY}::uuid, ${ids}::uuid[], NULL) AS result`;
  const el=Array.isArray(result?.eligible)?result.eligible:[];
  console.log(`\nCanary triaji: ${ids.length} aday → ${el.length} uygun`);
  if (el.length) {
    const ins=await sql`
      INSERT INTO campaign_targets (campaign_id, lead_id, status, sequence_step, variant)
      SELECT ${CANARY}::uuid, x::uuid, 'queued', 0,
        CASE WHEN (abs(hashtext(x::text)) % 2)=0 THEN 'a' ELSE 'b' END
      FROM unnest(${el}::uuid[]) x ON CONFLICT (campaign_id, lead_id) DO NOTHING RETURNING lead_id`;
    console.log(`✓ Canary'ye eklendi: ${ins.length} (A/B varyanti atandi)`);
  }
}
// sahte adresi olanı isaretle — bir daha havuza girmesin
for (const r of sahte) {
  await sql`UPDATE leads SET tags = CASE WHEN 'mail-sahte'::text = ANY(tags) THEN tags
    ELSE array_append(tags,'mail-sahte'::text) END WHERE id=${r.id}::uuid`;
}
await sql.end();
