#!/usr/bin/env node
/**
 * AÇILMA TAKİBİ TEŞHİS HAVUZU (24 Eyl 2026)
 *
 * Sorun: boat.online ve yacht.online domainlerinde açılma takibi API'den AÇILMIYOR —
 * PATCH 200 dönüyor ama değer yapışmıyor (hesap seviyesinde kilit, panelden açılması gerekiyor).
 * 21 Eyl'den beri giden 123 mailin 103'ü tam o iki domainden çıktı, yani teşhis penceresi boş.
 *
 * Çözüm: takibi AÇIK olan `mert@constantineyachts.online` gönderici havuzuna eklenir.
 * Worker lead_id hash'ine göre seçtiği için gönderimlerin ~1/5'i izlenebilir olur;
 * diğer dört kutu yeni domainleri ısıtmaya devam eder. Hacim değişmez.
 *
 * node izleme-havuzu.mjs [--uygula] [--geri-al]
 */
import postgres from 'postgres'; import fs from 'node:fs';
const IZLENEN = 'mert@constantineyachts.online';
const UYGULA = process.argv.includes('--uygula');
const GERI = process.argv.includes('--geri-al');
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);

const kampanyalar = await sql`
  SELECT id, name, sender_pool FROM campaigns
  WHERE status='running' AND sender_pool::jsonb ? 'mert@constantineboat.online' ORDER BY priority`;

for (const k of kampanyalar) {
  const havuz = Array.isArray(k.sender_pool) ? k.sender_pool : JSON.parse(k.sender_pool || '[]');
  const var_ = havuz.includes(IZLENEN);
  const yeni = GERI ? havuz.filter(x => x !== IZLENEN) : (var_ ? havuz : [...havuz, IZLENEN]);
  console.log(`${k.name.slice(0,30).padEnd(30)} ${havuz.length} kutu -> ${yeni.length} kutu`);
  if (UYGULA && yeni.length !== havuz.length) {
    await sql`UPDATE campaigns SET sender_pool = ${sql.json(yeni)} WHERE id=${k.id}::uuid`;
  }
}
if (UYGULA) {
  const son = await sql`SELECT left(name,30) ad, sender_pool FROM campaigns WHERE status='running' ORDER BY priority`;
  console.log('\nson durum:');
  for (const s of son) {
    const h = Array.isArray(s.sender_pool) ? s.sender_pool : JSON.parse(s.sender_pool||'[]');
    console.log(`  ${s.ad.padEnd(32)} ${h.length} kutu · izlenen ${h.includes(IZLENEN) ? 'VAR' : 'yok'}`);
  }
} else console.log('\n(--uygula ile yazılır · --geri-al ile çıkarılır)');
await sql.end();
