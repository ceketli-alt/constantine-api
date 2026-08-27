#!/usr/bin/env node
/**
 * RENDER KARAR DEFTERI — render ile kazinan sitelerden cikan adresleri leadlere baglar.
 *
 * Kullanim:
 *   node render-karar.mjs                                  (GOREV 2-B varsayilani)
 *   node render-karar.mjs --render <csv> --leadler <csv> --cikti <csv>
 *
 * Neden ayri bir karar adimi var: CRM'deki `website` alani GUVENILIR DEGIL.
 * `ARÇIN TURİZM -> alkistur.com`, `BAKU TRAVEL -> instagram.com` gibi ornekler var;
 * o sitede bulunan adres o firmaya ait DEGIL. Bu yuzden her lead icin once
 * "bu site bu firmanin mi" sorusu cevaplaniyor (ad<->alan adi + sitenin kendi beyani).
 *
 * Karar turleri:
 *   KORU-ETIKETLE  mevcut adres zaten firmanin kendi alan adinda -> dokunma, partiye al
 *   DEGISTIR       mevcut adres yok/yanlis + site kimligi dogrulandi -> render'dan gelen adres
 *   RED-*          gerekceli red
 *
 * Cikti: /root/acente-data-2026-08/GOREV2B-KARAR.csv  (uygulama ayri scriptte)
 */
import fs from 'node:fs';
import postgres from 'postgres';
import { adAlanEslesmesi, beyanEslesmesi, rolMu, degistirmeliMi, norm } from './lib/kimlik.mjs';
import { gecerliMail } from './lib/mail.mjs';

const DIR = '/root/acente-data-2026-08';
const env = Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8')
  .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sql = postgres(env.DATABASE_URL);

const freemail = new Set((await sql`SELECT domain FROM free_email_domains`).map(r => r.domain.toLowerCase()));

// DAHA ONCE ELENMIS leadleri geri sizdirma. 26 Agu dersi: `eksik-kalanlari-ekle.mjs`
// yalnizca "etiketli mi" diye bakiyordu, ben de etiketleri kaldirmistim -> mx-riskli
// leadler partiye geri sizdi. Eleme sebebi leadin USTUNDE durur, CSV'de degil.
const elenmis = new Set((await sql`
  SELECT id::text FROM leads
  WHERE 'kimlik-dogrulanamadi' = ANY(tags) OR 'mx-riskli' = ANY(tags)
     OR 'coklu-atama' = ANY(tags) OR 'mail-sahte' = ANY(tags) OR 'seg-irrelevant' = ANY(tags)`).map(r => r.id));
const kampanyada = new Set((await sql`
  SELECT DISTINCT lead_id::text AS id FROM campaign_targets`).map(r => r.id));

// --- CSV okuma (tirnakli alanlari da tasiyabilen kucuk ayristirici)
function csvOku(yol) {
  const metin = fs.readFileSync(yol, 'utf8');
  const satir = [];
  let alan = '', kayit = [], tirnak = false;
  for (let i = 0; i < metin.length; i++) {
    const c = metin[i];
    if (tirnak) {
      if (c === '"') { if (metin[i + 1] === '"') { alan += '"'; i++; } else tirnak = false; }
      else alan += c;
    } else if (c === '"') tirnak = true;
    else if (c === ',') { kayit.push(alan); alan = ''; }
    else if (c === '\n') { kayit.push(alan.replace(/\r$/, '')); satir.push(kayit); kayit = []; alan = ''; }
    else alan += c;
  }
  if (alan || kayit.length) { kayit.push(alan); satir.push(kayit); }
  const bas = satir.shift();
  return satir.filter(r => r.length > 1).map(r => Object.fromEntries(bas.map((b, i) => [b, r[i] ?? ''])));
}

const bayrak = (ad) => { const i = process.argv.indexOf(ad); return i > 0 ? process.argv[i + 1] : null; };
const RENDER_CSV  = bayrak('--render')  || `${DIR}/RENDER-KAZI.csv`;
const LEAD_CSV    = bayrak('--leadler') || `${DIR}/GOREV2-leadler.csv`;
const CIKTI_CSV   = bayrak('--cikti')   || `${DIR}/GOREV2B-KARAR.csv`;

const render = csvOku(RENDER_CSV);
const siteBilgi = new Map();     // domain -> { mailler:[{mail,yontem,sayfa}], beyan }
for (const r of render) {
  const d = r.domain.trim().toLowerCase();
  if (!siteBilgi.has(d)) siteBilgi.set(d, { mailler: [], beyan: '' });
  const s = siteBilgi.get(d);
  if (r.beyan && r.beyan.length > s.beyan.length) s.beyan = r.beyan;
  // kazi anindaki dogrulamayi BURADA TEKRAR uygula: kural sonradan sikilasabilir,
  // elimizdeki ham CSV eski kurala gore yazilmis olabilir
  const temiz = gecerliMail(r.mail);
  if (temiz) s.mailler.push({ mail: temiz, yontem: r.yontem, sayfa: r.sayfa });
}

// kategori sutunu varsa B'ye filtrele; yoksa dosyanin tamami hedeftir
const hamLeadler = csvOku(LEAD_CSV);
const leadler = hamLeadler[0] && 'kategori' in hamLeadler[0]
  ? hamLeadler.filter(r => r.kategori === 'B-MAIL-YOK-FORM-VAR') : hamLeadler;

// PAYLASILAN ALAN ADI — sahibi TEK olmali.
// Ayni siteyi birden cok lead sahipleniyorsa soru "kac tane?" degil, "hangisi?"dir:
//   · tam olarak BIR lead ad<->alan adi eslesmesi tutturuyorsa site onundur, digerleri duser
//     (`phoenixtur.com` uc leadden yalnizca PHOENIX'e ait)
//   · HIC KIMSE tutturamiyorsa site baskasinindir (`etstur.com`'a alti ayri acente bagli)
//   · BIRDEN COK lead tutturuyorsa ayirt edilemez: marka merkezi ya da ortak jenerik kelime
//     (`hilton.com` 18 otel, `anatoliatravel.com` dort ayri ANATOLIA* acentesi)
// Son iki durumda hepsi reddedilir — zincir merkezinin kutusuna yerel acente gibi mail
// atmak zaten yanlis muhatap. (26 Agu, telefon listesi turu)
const siteClaim = {};
for (const L of leadler) {
  const d = (L.domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!d) continue;
  (siteClaim[d] ||= []).push(L);
}
const siteSahibi = {};   // domain -> lead_id | null
for (const [d, grup] of Object.entries(siteClaim)) {
  if (grup.length < 2) continue;
  const tutan = grup.filter(L => adAlanEslesmesi(L.firma, d) === 'tam');
  siteSahibi[d] = tutan.length === 1 ? tutan[0].lead_id : null;
}

const alanAdi = (m) => (m || '').split('@')[1] || '';
const kokAyni = (a, b) => {
  a = a.replace(/^www\./, ''); b = b.replace(/^www\./, '');
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
};

/** Aday adresler icinden en iyisini sec: once sitenin KENDI alan adi, sonra rol hesabi. */
function enIyiMail(mailler, siteDomain) {
  const puan = (m) => {
    let p = 0;
    if (kokAyni(alanAdi(m.mail), siteDomain)) p += 100;      // sitenin kendi kutusu
    if (rolMu(m.mail)) p += 30;                              // info@/iletisim@ — sogukta dogru muhatap
    if (m.yontem === 'mailto') p += 10;                      // tiklanabilir link en guvenilir kaynak
    if (m.yontem === 'form-endpoint' || m.yontem === 'form-hidden') p += 8;
    if (m.yontem === 'obfuske') p -= 5;
    if (freemail.has(alanAdi(m.mail))) p -= 60;              // kurumsal kampanyaya giremez
    if (/^(webmaster|postmaster|abuse|noreply|no-reply|hostmaster)@/.test(m.mail)) p -= 80;
    return p;
  };
  return [...mailler].sort((a, b) => puan(b) - puan(a))[0];
}

const cikti = [];
let sayim = {};
const say = (k) => sayim[k] = (sayim[k] || 0) + 1;

for (const L of leadler) {
  const firma = L.firma, site = (L.domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (elenmis.has(L.lead_id)) { say('RED-onceden-elenmis'); continue; }
  if (kampanyada.has(L.lead_id)) { say('RED-zaten-kampanyada'); continue; }
  const eski = (L.eski_mail || '').trim().toLowerCase();
  const bilgi = siteBilgi.get(site) || { mailler: [], beyan: '' };
  const beyan = bilgi.beyan;

  const ekle = (karar, yeni, gerekce) => {
    cikti.push({ lead_id: L.lead_id, firma, site, eski_mail: eski, yeni_mail: yeni || '',
                 karar, gerekce, beyan });
    say(karar);
  };

  // 1) Mevcut adres zaten firmanin KENDI alan adinda mi? (H1: dokunma)
  if (eski && adAlanEslesmesi(firma, alanAdi(eski)) === 'tam') {
    if (freemail.has(alanAdi(eski))) { ekle('RED-freemail', '', 'mevcut adres bedava-mail, kurumsal kampanyaya giremez'); continue; }
    ekle('KORU-ETIKETLE', '', `mevcut adres firmanin kendi alan adinda (${alanAdi(eski)})`);
    continue;
  }

  if (site in siteSahibi && siteSahibi[site] !== L.lead_id) {
    const n = siteClaim[site].length;
    ekle('RED-paylasilan-site', '', siteSahibi[site]
      ? `siteyi ${n} firma sahipleniyor; ad-alan eslesmesi baska leadde`
      : `siteyi ${n} firma sahipleniyor, hicbiri tek basina sahiplenemiyor — zincir/portal`);
    continue;
  }

  // 2) Site bu firmaya mi ait? Iki bagimsiz kanit: ad<->alan adi, sitenin kendi beyani
  const adAlan = adAlanEslesmesi(firma, site);
  const beyanTut = beyan ? beyan.split('|').some(p => beyanEslesmesi(firma, p.split(':').slice(1).join(':'))) : false;
  if (adAlan !== 'tam' && !beyanTut) {
    ekle('RED-kimlik', '', `site firmayla eslesmiyor (ad-alan=${adAlan}, beyan=${beyan ? 'var-tutmadi' : 'yok'})`);
    continue;
  }

  // 3) Sitede adres var mi?
  if (!bilgi.mailler.length) { ekle('RED-mail-yok', '', 'render sonrasi da adres cikmadi'); continue; }
  const secim = enIyiMail(bilgi.mailler, site);
  if (freemail.has(alanAdi(secim.mail))) { ekle('RED-freemail', secim.mail, 'sitede yalnizca bedava-mail var'); continue; }
  if (!kokAyni(alanAdi(secim.mail), site) && adAlanEslesmesi(firma, alanAdi(secim.mail)) !== 'tam') {
    ekle('RED-yabanci-kutu', secim.mail, `adres ne sitenin ne firmanin alan adinda (${alanAdi(secim.mail)})`);
    continue;
  }
  if (eski) {
    const k = degistirmeliMi(firma, eski, secim.mail);
    if (!k.degistir) { ekle('KORU-ETIKETLE', '', `degistirme korumasi: ${k.sebep}`); continue; }
  }
  ekle('DEGISTIR', secim.mail, `kimlik: ${adAlan === 'tam' ? 'ad-alan' : 'beyan'} · kaynak: ${secim.yontem}${secim.sayfa ? ' ' + secim.sayfa : ''}`);
}

const esc = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const bas = ['lead_id', 'firma', 'site', 'eski_mail', 'yeni_mail', 'karar', 'gerekce', 'beyan'];
fs.writeFileSync(CIKTI_CSV,
  bas.join(',') + '\n' + cikti.map(r => bas.map(b => esc(r[b])).join(',')).join('\n') + '\n');

console.log(`${leadler.length} lead karara baglandi:`);
for (const [k, v] of Object.entries(sayim).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${v}`);
console.log(`\n-> ${CIKTI_CSV}`);
await sql.end();
