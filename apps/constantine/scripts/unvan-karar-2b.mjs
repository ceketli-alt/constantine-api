#!/usr/bin/env node
/**
 * GOREV 2-B artigi: 8. denetimin isaretledigi 16 lead icin RESMI AD karari.
 * Kanit BAGLAMIYLA okundu (UNVAN-BAGLAM.csv) — 'kelime sayfada geciyor' yetmez.
 * Kabul olcutu: sitenin BEYAN ETTIGI ad, firmanin AYIRT EDICI kelimesini icermeli
 * ve o kelime siradan bir sozluk kelimesi olmamali.
 */
import postgres from 'postgres'; import fs from 'node:fs';
const ETIKET = 'ist-kurtarma-2026-08';
const env = Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
  .filter(l=>l.includes('=')&&!l.trim().startsWith('#'))
  .map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql = postgres(env.DATABASE_URL);

const KABUL = {
  'raraavis.com.tr':            'JSON-LD legalName: "rara avis lab events turizm dis ticaret limited sirketi"',
  'thestoryhotelpera.com':      'site "The Story Hotel Pera" — Story Hotels markasinin oteli',
  'aizatravelhouse.com':        '"Aiza Travel House" — aiza ayirt edici, birebir',
  'hcws112.com':                'hcws kisaltmasi alan adinda ve site genelinde',
  'adiyamanunalturizm.com.tr':  '"Adiyaman Unal Turizm" — soyad + turizm',
  'calikiran.com.tr':           '"Calikiran Turizm" — Kiran soyadi + turizm, adres kendi alan adinda',
  'worldexpofair.com':          '"World Expo Fair" — iki kelimelik marka ortusmesi',
};
const RED = {
  'siirtbaykanjetturizm.com': 'BAYKA ≠ BAYKAN (Siirt ilcesi); farkli firma',
  'kasgumustravel.com':       'QARUH ≠ KAS; yalniz "gumus" ortak, soyad tesadufu olabilir',
  'axismunditravel.com':      'ASTRA MUNDI ≠ AXIS MUNDI; "mundi" Latince ortak kelime',
  'santralegitim.com':        'tek kanit "egitim" — jenerik kelime',
  'rotabizden.com':           'tek kanit "rota" ve o da bir CSS sinif adindan geldi',
  'fastbooktourism.com':      'tek kanit "fast"; site "Fastbook Travel", firma "Fast Snow Kar"',
  'istanbulatvarena.com':     '"Istanbul ATV Arena" — ATV turu isletmesi, ayri firma',
  'active.com.tr':            'resmi ad baglami hic bulunamadi',
  'modevent.com.tr':          'resmi ad baglami hic bulunamadi',
};

const leadler = await sql`SELECT id, company_name, primary_contact_email mail FROM leads
  WHERE ${ETIKET}::text = ANY(tags) AND primary_contact_email IS NOT NULL`;
let k=0, r=0;
for (const l of leadler) {
  const d = (l.mail.split('@')[1]||'').toLowerCase();
  if (KABUL[d]) {
    await sql`UPDATE leads SET tags = CASE WHEN 'unvan-dogrulandi' = ANY(tags) THEN tags
      ELSE array_append(tags,'unvan-dogrulandi') END, updated_at=now() WHERE id=${l.id}::uuid`;
    k++;
  } else if (RED[d]) {
    await sql`UPDATE leads SET tags = array_remove(
        CASE WHEN 'kimlik-dogrulanamadi' = ANY(tags) THEN tags ELSE array_append(tags,'kimlik-dogrulanamadi') END,
        ${ETIKET}::text), updated_at=now() WHERE id=${l.id}::uuid`;
    console.log(`  cikarildi: ${(l.company_name||'').slice(0,34).padEnd(34)} ${d} — ${RED[d]}`);
    r++;
  }
}
console.log(`\nunvan-dogrulandi: ${k}   ·   partiden cikarilan: ${r}`);
const [a] = await sql`SELECT count(*)::int n FROM leads WHERE ${ETIKET}::text = ANY(tags)`;
console.log(`parti toplam: ${a.n}`);
await sql.end();
