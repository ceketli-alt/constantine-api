#!/usr/bin/env node
/**
 * DÜZ METİN ETİKETİ — Yandex alıcılarına HTML gitmesin (15 Eki 2026).
 *
 * 8 Eki'de 1C'yi HTML'e (açılma ölçümü için) geçirdik. 12-14 Eki'de 4 içerik reddi geldi
 * (Transient/ContentRejected) — 4'ü de Yandex. Bu bounce türü öncesinde HİÇ yoktu ve
 * Yandex'ten açılma da 0/5. Düz metin Yandex'ten geçiyordu.
 * Bu script çalışan kampanyaların kuyruğundaki leadlerin MX'ine bakar; Yandex olanları
 * `duz-metin` etiketler. email-send.ts bu etiketi görünce HTML parçasını göndermez.
 *
 * node duz-metin-etiketle.mjs [--uygula]
 */
import postgres from 'postgres'; import fs from 'node:fs';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
const calistir = promisify(execFile);
const UYGULA = process.argv.includes('--uygula');
const ETIKET = 'duz-metin';
const CACHE = '/root/monitor/mx-saglayici.json';

const env = Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sql = postgres(env.DATABASE_URL);

const leadler = await sql`
  SELECT DISTINCT l.id, l.company_name, lower(l.primary_contact_email) mail, l.tags
  FROM campaign_targets t JOIN campaigns c ON c.id=t.campaign_id JOIN leads l ON l.id=t.lead_id
  WHERE c.status='running' AND t.status='queued' AND l.primary_contact_email IS NOT NULL`;

let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch {}
async function yandexMi(d) {
  if (cache[d]) return cache[d] === 'Yandex';
  let o = '';
  try { o = (await calistir('dig', ['@1.1.1.1', '+short', '+time=3', '+tries=2', 'MX', d], { timeout: 15000 })).stdout.toLowerCase(); } catch {}
  const s = /outlook\.com|protection\.outlook/.test(o) ? 'Microsoft' : /google\.com|googlemail/.test(o) ? 'Google'
          : /yandex/.test(o) ? 'Yandex' : o.trim() ? 'Kendi sunucusu' : 'Bilinmiyor';
  cache[d] = s; return s === 'Yandex';
}
const alanlar = [...new Set(leadler.map(l => l.mail.split('@')[1]).filter(Boolean))];
const kuyruk = [...alanlar]; const yandex = new Set();
await Promise.all(Array.from({ length: 20 }, async () => {
  while (kuyruk.length) { const d = kuyruk.shift(); if (await yandexMi(d)) yandex.add(d); }
}));
try { fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch {}

const hedef = leadler.filter(l => yandex.has(l.mail.split('@')[1]) && !(l.tags || []).includes(ETIKET));
console.log(`kuyruktaki lead: ${leadler.length} · Yandex alan adı: ${yandex.size} · etiketlenecek: ${hedef.length}`);
for (const l of hedef.slice(0, 6)) console.log(`  ${(l.company_name || '').slice(0, 32).padEnd(32)} ${l.mail}`);
if (UYGULA && hedef.length) {
  await sql`UPDATE leads SET tags = CASE WHEN ${ETIKET}::text = ANY(tags) THEN tags ELSE array_append(tags, ${ETIKET}::text) END
            WHERE id = ANY(${hedef.map(l => l.id)}::uuid[])`;
  console.log(`\n${hedef.length} lead '${ETIKET}' etiketlendi`);
} else if (hedef.length) console.log('\n(--uygula ile yazılır)');
await sql.end();
