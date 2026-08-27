#!/usr/bin/env node
/**
 * MX KAPISI — bir partideki leadlerin posta alan adlarini DNS'ten dogrular.
 * MX kaydi yoksa ve A fallback'i da yoksa adres KESIN hard-bounce eder (YURTICI TURIZM dersi);
 * bu leadler `mx-riskli` etiketiyle isaretlenir, parti-denetle.mjs 4. kontrolu onlari yakalar.
 *
 * A-FALLBACK (MX yok ama A var) da riskli sayilir: RFC 5321'e gore mesru bir yol ama
 * arkasinda posta servisi olup olmadigini BURADAN dogrulayamiyoruz —
 * ⚠️ bu sunucudan 25. port DISA KAPALI (Hetzner), SMTP banner testi HER ZAMAN
 * 'baglanamadi' der; o testin sonucu delil DEGILDIR. NeverBounce de MX olmadigi icin
 * bu adreslere 'unknown' donuyor. Kuyruk bol oldugu surece dogru takas: cikar.
 *
 * Kullanim: node mx-etiketle.mjs <etiket> [--uygula]
 */
import postgres from 'postgres';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const calistir = promisify(execFile);

const ETIKET = process.argv[2];
const UYGULA = process.argv.includes('--uygula');
if (!ETIKET) { console.error('kullanim: node mx-etiketle.mjs <etiket> [--uygula]'); process.exit(1); }

const env = Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sql = postgres(env.DATABASE_URL);

const leadler = await sql`SELECT id, company_name, primary_contact_email, tags FROM leads
  WHERE ${ETIKET}::text = ANY(tags) AND primary_contact_email IS NOT NULL`;
const alanlar = [...new Set(leadler.map(l => (l.primary_contact_email.split('@')[1] || '').toLowerCase()).filter(Boolean))];
console.log(`${leadler.length} lead / ${alanlar.length} alan adi MX taranacak`);

async function mx(d) {
  const dig = async (tip) => {
    // iki ayri resolver + coklu deneme: tek sorgu flakiligi yanlis 'MX yok' uretiyordu
    for (const res of ['@1.1.1.1', '@8.8.8.8']) {
      try { const { stdout } = await calistir('dig', [res, '+short', '+time=4', '+tries=3', tip, d], { timeout: 20000 });
            if (stdout.trim()) return stdout.trim(); } catch { /* diger resolver */ }
    }
    return '';
  };
  const m = await dig('MX');
  if (m.split('\n').some(l => l.trim().split(/\s+/).length === 2)) return 'MX-VAR';
  return (await dig('A')) ? 'A-FALLBACK' : 'MX-YOK';
}

const sonuc = new Map();
const kuyruk = [...alanlar];
await Promise.all(Array.from({ length: 20 }, async () => {
  while (kuyruk.length) { const d = kuyruk.shift(); sonuc.set(d, await mx(d)); }
}));

const sayim = {};
for (const v of sonuc.values()) sayim[v] = (sayim[v] || 0) + 1;
console.log(sayim);

const riskli = leadler.filter(l => ['MX-YOK', 'A-FALLBACK']
  .includes(sonuc.get((l.primary_contact_email.split('@')[1] || '').toLowerCase())));
console.log(`\nMX-YOK / A-FALLBACK (bounce riski) ${riskli.length} lead:`);
for (const l of riskli.slice(0, 25)) console.log(`  ${l.company_name?.slice(0, 34).padEnd(34)} ${l.primary_contact_email}`);
if (riskli.length > 25) console.log(`  ... +${riskli.length - 25}`);

if (UYGULA && riskli.length) {
  for (const l of riskli) {
    // TEK atama: Postgres ayni kolona iki kez deger atamaya izin vermiyor
    await sql`UPDATE leads SET tags = array_remove(
        CASE WHEN 'mx-riskli' = ANY(tags) THEN tags ELSE array_append(tags,'mx-riskli') END,
        ${ETIKET}::text), updated_at=now()
      WHERE id=${l.id}::uuid`;
  }
  console.log(`\n${riskli.length} lead 'mx-riskli' isaretlendi ve partiden cikarildi`);
} else if (riskli.length) {
  console.log('\n(--uygula ile yazilir)');
}
await sql.end();
