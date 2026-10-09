#!/usr/bin/env node
/**
 * TAKİP SAĞLIĞI — günlük özet maile girecek HTML bloğu (8 Eki 2026).
 *   1. Cevap toplayıcı çalışıyor mu? (nabız; 26 Eyl'de 5 gün kör kaldı, kimse görmedi)
 *   2. Eşleşmeyen gelen var mı? (artık atılmıyor, inbound_unmatched'a düşüyor)
 *   3. Açılma — POSTA SAĞLAYICISINA GÖRE. Google/Yandex resmi yükler: orada açılma
 *      düşükse mail spam'e gidiyor demektir. Microsoft resmi engeller: oranı yanıltıcıdır.
 * Yalnızca HTML gönderilmeye başladıktan sonra, takibi açık alan adından giden mailler sayılır.
 * Çıktı: stdout'a tek HTML bloğu. --metin ile düz metin.
 */
import postgres from 'postgres';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const calistir = promisify(execFile);

const METIN = process.argv.includes('--metin');
const HTML_BASLANGIC = '2026-10-08T20:20:00Z';            // 1C bu andan sonra HTML gönderiyor
const IZLENEN_ALAN = 'constantineyachts.online';           // Resend'de açılma takibi açık tek alan
const MAKINE_SN = 120;
const NABIZ_SAAT = 6;
const CACHE = '/root/monitor/mx-saglayici.json';

const env = Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sql = postgres(env.DATABASE_URL);
const satir = [];
const kirmizi = s => METIN ? `!! ${s}` : `<span style="color:#dc2626"><b>${s}</b></span>`;

// 1) Nabız
const nabizlar = await sql`SELECT key, value, updated_at FROM app_config WHERE key LIKE 'reply_poller_heartbeat:%'`;
if (!nabizlar.length) {
  satir.push(kirmizi('Cevap toplayıcı: hiç nabız yok — toplayıcı çalışmıyor olabilir'));
}
for (const n of nabizlar) {
  const v = JSON.parse(n.value);
  const saat = (Date.now() - new Date(v.at).getTime()) / 3600e3;
  const etiket = n.key.split(':')[1];
  if (saat > NABIZ_SAAT) satir.push(kirmizi(`Cevap toplayıcı (${etiket}): son başarılı tur ${saat.toFixed(0)} saat önce — gelen cevaplar okunmuyor`));
  else if (v.ok_mailboxes < v.total_mailboxes) satir.push(kirmizi(`Cevap toplayıcı (${etiket}): ${v.total_mailboxes} kutunun ${v.total_mailboxes - v.ok_mailboxes}'i hata veriyor — ${v.last_error ?? ''}`));
  else satir.push(`Cevap toplayıcı: ${v.ok_mailboxes}/${v.total_mailboxes} kutu sağlam · son tur ${Math.round(saat * 60)} dk önce`);
}

// 2) Eşleşmeyen gelen
const [{ n: eslesmeyen }] = await sql`SELECT count(*)::int n FROM inbound_unmatched WHERE reviewed_at IS NULL`;
if (eslesmeyen > 0) satir.push(kirmizi(`Eşleşmeyen gelen mail: ${eslesmeyen} — kayıtlı bir firmaya bağlanamadı, sabahki sıcak listede`));

// 3) Açılma — sağlayıcıya göre
const mailler = await sql`
  SELECT m.id, lower(split_part(m.to_email,'@',2)) alan,
    EXISTS (SELECT 1 FROM email_events e WHERE e.message_id=m.id AND e.event_type='delivered') teslim,
    EXISTS (SELECT 1 FROM email_events e WHERE e.message_id=m.id AND e.event_type='opened'
              AND e.occurred_at > m.sent_at + make_interval(secs => ${MAKINE_SN})) insan,
    EXISTS (SELECT 1 FROM email_events e WHERE e.message_id=m.id AND e.event_type='opened'
              AND e.occurred_at <= m.sent_at + make_interval(secs => ${MAKINE_SN})) makine
  FROM email_messages m
  WHERE m.direction='outbound' AND m.campaign_id IS NOT NULL
    AND lower(m.from_email) LIKE ${'%@' + IZLENEN_ALAN} AND m.created_at > ${HTML_BASLANGIC}`;

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch {}
async function saglayici(d) {
  if (cache[d]) return cache[d];
  let o = '';
  try { o = (await calistir('dig', ['@1.1.1.1', '+short', '+time=3', '+tries=2', 'MX', d], { timeout: 15000 })).stdout.toLowerCase(); } catch {}
  const s = /outlook\.com|protection\.outlook/.test(o) ? 'Microsoft'
          : /google\.com|googlemail/.test(o) ? 'Google'
          : /yandex/.test(o) ? 'Yandex'
          : o.trim() ? 'Kendi sunucusu' : 'Bilinmiyor';
  cache[d] = s; return s;
}
const grup = {};
for (const m of mailler) {
  if (!m.teslim) continue;
  const s = await saglayici(m.alan);
  (grup[s] ||= { teslim: 0, insan: 0, makine: 0 });
  grup[s].teslim++; if (m.insan) grup[s].insan++; else if (m.makine) grup[s].makine++;
}
try { fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch {}

const toplamTeslim = Object.values(grup).reduce((a, g) => a + g.teslim, 0);
if (toplamTeslim === 0) {
  satir.push('Açılma: HTML gönderim yeni başladı, henüz teslim edilmiş izlenen mail yok');
} else {
  const sira = ['Google', 'Yandex', 'Kendi sunucusu', 'Microsoft', 'Bilinmiyor'];
  const parcalar = sira.filter(s => grup[s]).map(s => {
    const g = grup[s]; const oran = Math.round(g.insan * 100 / g.teslim);
    const uyari = s === 'Microsoft' ? ' (resmi engeller, oran yanıltıcı)' : '';
    return `${s}: ${g.insan}/${g.teslim} = %${oran}${uyari}`;
  });
  const makine = Object.values(grup).reduce((a, g) => a + g.makine, 0);
  satir.push(`Açılma (izlenen ${toplamTeslim} teslim): ${parcalar.join(' · ')}` + (makine ? ` · ayıklanan makine açılması ${makine}` : ''));
  if (toplamTeslim < 50) satir.push('Not: 50 teslimden azken oranlar henüz yorumlanmaz.');
}

if (METIN) console.log(satir.join('\n'));
else console.log(`<div style="background:#f8fafc;border-radius:6px;padding:10px 12px;margin:12px 0;font-size:13px;line-height:1.6"><b>Takip sağlığı</b><br>${satir.join('<br>')}</div>`);
await sql.end();
