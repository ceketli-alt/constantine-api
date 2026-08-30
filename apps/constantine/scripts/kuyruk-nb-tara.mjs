#!/usr/bin/env node
/**
 * KUYRUK NEVERBOUNCE TARAMASI — kuyrukta bekleyen hedefleri gonderilmeden once dogrular.
 *
 * 29 Agu bulgusu: Istanbul kampanyasinin haftalik bounce orani %10,6. Kuyruktan alinan
 * 25 kisilik ornekte %40 catch-all, %20 unknown cikti. Autofill yalnizca `invalid` ve
 * `disposable` dusuruyor; `unknown` oldugu gibi geciyordu.
 *
 * Politika: invalid / disposable / unknown -> kuyruktan dus.
 *           valid / catchall            -> kalsin (catch-all gondermeden cozulemez).
 *
 * Kullanim: node kuyruk-nb-tara.mjs <campaign_id> [--uygula]
 */
import postgres from 'postgres'; import fs from 'node:fs';
const KAMPANYA = process.argv[2];
const UYGULA = process.argv.includes('--uygula');
if (!KAMPANYA) { console.error('kullanim: node kuyruk-nb-tara.mjs <campaign_id> [--uygula]'); process.exit(1); }
const DUSUR = new Set(['invalid', 'disposable', 'unknown']);

const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const KEY=env.NEVERBOUNCE_API_KEY;
if (!KEY) { console.error('NEVERBOUNCE_API_KEY yok'); process.exit(1); }

const hedefler = await sql`
  SELECT t.id tid, l.id lid, l.company_name firma, lower(l.primary_contact_email) mail
  FROM campaign_targets t JOIN leads l ON l.id=t.lead_id
  WHERE t.campaign_id=${KAMPANYA} AND t.status='queued' AND l.primary_contact_email IS NOT NULL
  ORDER BY t.created_at`;
console.log(`${hedefler.length} kuyruk hedefi taranacak (politika: ${[...DUSUR].join('/')} dusurulur)`);

async function nb(mail) {
  try {
    const u = new URL('https://api.neverbounce.com/v4/single/check');
    u.searchParams.set('key', KEY); u.searchParams.set('email', mail);
    const d = await (await fetch(u)).json();
    return d.status === 'success' ? (d.result || 'hata') : 'hata';
  } catch { return 'hata'; }
}

const sayim = {}; const dusenler = [];
for (let i = 0; i < hedefler.length; i++) {
  const h = hedefler[i];
  const r = await nb(h.mail);
  sayim[r] = (sayim[r] || 0) + 1;
  if (DUSUR.has(r)) dusenler.push({ ...h, sonuc: r });
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${hedefler.length} · dusen ${dusenler.length}`);
  await new Promise(r => setTimeout(r, 200));
}
console.log('\nsonuc:', sayim);
console.log(`dusurulecek: ${dusenler.length}`);
for (const d of dusenler.slice(0, 20)) console.log(`  ${d.sonuc.padEnd(9)} ${(d.firma||'').slice(0,32).padEnd(32)} ${d.mail}`);
if (dusenler.length > 20) console.log(`  ... +${dusenler.length - 20}`);

if (UYGULA && dusenler.length) {
  for (const d of dusenler) {
    await sql`UPDATE campaign_targets SET status='failed', error=${'neverbounce:' + d.sonuc}
      WHERE id=${d.tid}::uuid`;
    // 'unknown' dogrulanamadi demek, kotu adres demek DEGIL -> leadi silmiyoruz, isaretliyoruz
    await sql`UPDATE leads SET tags = CASE WHEN 'nb-dogrulanamadi' = ANY(tags) THEN tags
      ELSE array_append(tags,'nb-dogrulanamadi') END WHERE id=${d.lid}::uuid`;
  }
  console.log(`\n${dusenler.length} hedef kuyruktan dusuruldu, leadler 'nb-dogrulanamadi' isaretlendi`);
} else if (dusenler.length) console.log('\n(--uygula ile dusurulur)');
await sql.end();
