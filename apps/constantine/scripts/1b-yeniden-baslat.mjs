#!/usr/bin/env node
/**
 * Phase 1B (outreach@constantineyachts.online) yeniden acilis — Mert karari 26 Agu.
 * Kutu 22 Haziran'dan beri sessiz (Microsoft'ta %91,5 spam yuzunden durdurulmustu).
 * Bu yuzden: TEMIZ partiden kucuk bir dilim + gunluk 3 tavan + gozlem.
 * node 1b-yeniden-baslat.mjs [--uygula] [adet]
 */
import postgres from 'postgres'; import fs from 'node:fs';
import { nbDogrula, RISKLI } from './lib/nb.mjs';
const KAMPANYA='3c0e9cad-ea5f-4ff3-8df8-54365f113e4a';
const ETIKET='ist-kurtarma-2026-08';
const UYGULA=process.argv.includes('--uygula');
const ADET=Number(process.argv.find(a=>/^\d+$/.test(a)) || 30);
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);

const aday = await sql`
  SELECT l.id, l.company_name, l.primary_contact_email mail FROM leads l
  WHERE ${ETIKET}::text = ANY(l.tags) AND l.status='new' AND l.last_contacted_at IS NULL
    AND l.primary_contact_email IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM campaign_targets ct WHERE ct.lead_id=l.id)
    AND NOT EXISTS (SELECT 1 FROM unsubscribes u WHERE u.channel='email'
                      AND lower(u.identifier)=lower(l.primary_contact_email))
  ORDER BY l.created_at DESC LIMIT ${ADET}`;
console.log(`1B icin aday: ${aday.length} (temiz partiden, hicbir kampanyada degil)`);
for (const a of aday.slice(0,6)) console.log(`  ${a.company_name.slice(0,34).padEnd(34)} ${a.mail}`);
if (aday.length>6) console.log(`  ... +${aday.length-6}`);

if (!UYGULA) { console.log('\n(--uygula ile enroll + kampanya baslatilir)'); await sql.end(); process.exit(0); }

const ids=aday.map(a=>a.id);
const [{ result }] = await sql`SELECT eligible_leads_for_campaign(${KAMPANYA}::uuid, ${ids}::uuid[], NULL) AS result`;
const uygun = Array.isArray(result?.eligible) ? result.eligible : [];
console.log(`\ntriaj sonrasi uygun: ${uygun.length}`);
if (result?.rejected?.length) console.log(`  reddedilen: ${result.rejected.length}`);

// NEVERBOUNCE KAPISI — 29 Agu: bu script eskiden bu adimi ATLIYORDU (autofill yapiyordu,
// elle enroll eden scriptler yapmiyordu) ve tavbilet@tav.aero o bosluktan gecip bounce etti.
const uygunLeadler = aday.filter(a => uygun.includes(a.id));
const { riskli, sayim } = await nbDogrula(uygunLeadler.map(a => a.mail), env.NEVERBOUNCE_API_KEY,
  { ilerleme: (i, n, r) => console.log(`  NB ${i}/${n} · riskli ${r}`) });
console.log('NeverBounce:', sayim);
const riskliSet = new Set(riskli);
const temiz = uygunLeadler.filter(a => !riskliSet.has((a.mail || '').toLowerCase()));
if (riskli.length) console.log(`  ${riskli.length} adres elendi (${[...RISKLI].join('/')}): ${riskli.slice(0,5).join(', ')}${riskli.length>5?' …':''}`);

const eklendi = await sql`
  INSERT INTO campaign_targets (campaign_id, lead_id, status, sequence_step)
  SELECT ${KAMPANYA}::uuid, x::uuid, 'queued', 0 FROM unnest(${temiz.map(a=>a.id)}::uuid[]) x
  ON CONFLICT (campaign_id, lead_id) DO NOTHING RETURNING lead_id`;
console.log(`enroll: ${eklendi.length}`);

await sql`UPDATE campaigns SET status='running' WHERE id=${KAMPANYA}::uuid`;
const [c] = await sql`SELECT name, status::text, daily_cap, sender_email FROM campaigns WHERE id=${KAMPANYA}::uuid`;
const [{n}] = await sql`SELECT count(*)::int n FROM campaign_targets WHERE campaign_id=${KAMPANYA}::uuid AND status='queued'`;
console.log(`\n${c.name}\n  durum: ${c.status} · gonderici: ${c.sender_email} · tavan: ${c.daily_cap}/gun · kuyruk: ${n}`);
await sql.end();
