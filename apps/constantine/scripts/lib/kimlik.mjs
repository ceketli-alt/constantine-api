/**
 * KIMLIK ESLESTIRME — TEK KAYNAK.
 *
 * 26 Agu 2026 dersi: ayni mantik uc ayri dosyaya UC FARKLI sikilikta yazilmisti.
 * 'JBR TURIZM -> jbrtravel.com' bir dosyada eslesiyor, digerinde elenıyordu.
 * Kimlik/eslesme ile ilgili HER SEY buradan gelir. Yeni kural buraya yazilir,
 * kimlik-testleri.mjs ile dogrulanir.
 */

// Sektorde herkeste olan kelimeler — ayirt edici DEGIL.
// 'world/global/nova/wonder/delux' listeye 26 Agu'da eklendi: BENTE WORLD ile
// BATURES WORLD ikisi de worldtur.com'a baglanmisti, ortak olan tek sey 'world'du.
export const JENERIK = new Set([
  'turizm','tur','tour','tours','turizmi','seyahat','acenta','acentasi','acentesi',
  'travel','tourism','trip','trips','holiday','holidays','tatil','voyage','journey','journeys',
  'agency','ltd','sti','ltdsti','as','anonim','sirketi','limited','company','co','inc','llc',
  'group','grup','international','intl','global','world','dunya','istanbul','turkey','turkiye','tr',
  'hizmetleri','ticaret','tic','san','sanayi','ve','and','the','org','dmc','vip','transfer',
  'organizasyon','sube','sb','com','hotel','hotels','otel','online','resmi','web','sitesi',
  'saglik','health','wonder','nova','delux','deluxe','life','star','royal','prime','elite','elit',
  'king','kings','new','best','city','blue','sun','gold','golden','mavi','max','mega','plus','pro',
]);

/** Turkce harfleri sadelestirip alfanumerige indirger (buyuk I/i tuzagi dahil) */
export function norm(s) {
  return (s || '')
    .replace(/İ/g,'i').replace(/I/g,'i').replace(/ı/g,'i')
    .replace(/Ş/g,'s').replace(/ş/g,'s').replace(/Ğ/g,'g').replace(/ğ/g,'g')
    .replace(/Ü/g,'u').replace(/ü/g,'u').replace(/Ö/g,'o').replace(/ö/g,'o')
    .replace(/Ç/g,'c').replace(/ç/g,'c')
    .toLowerCase().replace(/[^a-z0-9]/g,'');
}

/** Firma adindan AYIRT EDICI kelimeler */
export function tokenlar(ad) {
  return (ad || '').split(/[\s.\-_/&,()]+/).map(norm)
    .filter(t => t.length >= 3 && !JENERIK.has(t));
}

/** Bosluksuz cekirdek — 'YESEVITUR' ile 'Yesevi Tur' esitlensin diye */
export function cekirdek(ad) {
  return tokenlar(ad).join('');
}

/** alan adinin ilk etiketi: 'jbrtravel.com.tr' -> 'jbrtravel' */
export function alanCekirdegi(domain) {
  return norm((domain || '').split('.')[0]);
}

/**
 * Firma adi <-> alan adi ortusmesi.
 * 'tam' | 'kismi' | 'yok'
 */
/**
 * Alan adi cekirdeginden JENERIK kelimeleri uclardan siyirir.
 * 'istanbultravel' -> ''   ·   'hillstravelgroup' -> 'hills'
 */
// UZUNDAN KISAYA: 'tur' once denenirse 'tourism'i yiyip geriye 'ism' birakiyor
// ve 'A-LEVEL TOURISM -> a-leveltourism.com' yanlislikla reddediliyordu (26 Agu).
const JENERIK_UZUN = [...JENERIK].filter(j => j.length >= 3).sort((a, b) => b.length - a.length);

function jenerikSiyir(s) {
  let degisti = true;
  while (degisti && s) {
    degisti = false;
    for (const j of JENERIK_UZUN) {
      if (s.startsWith(j)) { s = s.slice(j.length); degisti = true; }
      else if (s.endsWith(j)) { s = s.slice(0, -j.length); degisti = true; }
    }
  }
  return s;
}

/**
 * Firma kelimesi alan adinin ICINDE geciyor — ama alan adinda BASKA bir ayirt edici
 * kelime daha varsa bu BASKA BIR FIRMADIR.
 * 'SEVEN WALKER' -> sevenhillstravelgroup: 'seven' tutuyor ama geriye 'hills' kaliyor
 * -> Seven Hills Travel Group bambaska bir acente. (26 Agu, GOREV 2-B)
 * 'DREAM PATH' -> dreamistanbultravel: geriye sadece jenerik kaliyor -> ayni firma.
 */
function kalanTemiz(core, t, ts) {
  const i = core.indexOf(t);
  if (i < 0) return true;
  for (const parca of [core.slice(0, i), core.slice(i + t.length)]) {
    const kalan = jenerikSiyir(parca);
    if (kalan.length > 2 && !ts.some(x => x === kalan || kalan.includes(x))) return false;
  }
  return true;
}

export function adAlanEslesmesi(firma, domain) {
  const core = alanCekirdegi(domain);
  const ts = tokenlar(firma);
  if (!core || !ts.length) return 'yok';
  for (const t of ts) {
    if (t === core) return 'tam';
    if (t.length >= 4 && t.includes(core)) return 'tam';
    if (t.length >= 4 && core.includes(t) && kalanTemiz(core, t, ts)) return 'tam';
    // 3 harflik onek: alan adi "kisaltma + JENERIK kelime" kaliginda olmali
    // ('jbrtravel' = jbr + travel, 'fcmtravel' = fcm + travel).
    // Ayrica kisaltma GERCEKTEN kisaltma olmali: sesli harfi yoksa (jbr, fcm) ya da
    // firmanin tek ayirt edici kelimesiyse. Yoksa 'BIG EAGLE TOUR' -> bigtravel gibi
    // siradan kisa kelimeler her seyi eslerdi.
    if (t.length === 3 && core.startsWith(t) && JENERIK.has(core.slice(3))
        && (!/[aeiou]/.test(t) || ts.length === 1)) return 'tam';
  }
  // Firmanin BUTUN ayirt edici kelimeleri alan adinda geciyorsa, alan adinda fazladan
  // kelime olmasi sahipligi curutmez: 'ALİ GÜNEŞ TURİZM' -> aligunesagizvedis.com
  // (ayni kisinin klinigi). 'SEVEN WALKER' -> sevenhillstravelgroup'ta 'walker' YOK,
  // o yuzden bu kapidan gecmez.
  if (ts.length >= 2 && ts.every(t => core.includes(t))) return 'tam';

  const g = cekirdek(firma);
  if (g && core.length >= 5 && g.includes(core)) return 'tam';
  if (ts.some(t => t.length >= 5 && core.length >= 5 && t.slice(0,5) === core.slice(0,5))) return 'kismi';
  return 'yok';
}

/**
 * Firma adi <-> sitenin KENDI BEYANI (title/telif/unvan) ortusmesi.
 * Bosluksuz + CIFT YONLU: kisa olan uzunun icinde olmali.
 * 'SANTE PRIVEE' <-> 'LOSANTE' REDDEDILIR ('losante' firma adinda yok).
 */
export function beyanEslesmesi(firma, beyan) {
  const f = cekirdek(firma), b = cekirdek(beyan);
  if (!f || !b || f.length < 4) return false;
  const [kisa, uzun] = f.length <= b.length ? [f,b] : [b,f];
  if (kisa.length >= 5 && uzun.includes(kisa)) return true;
  // Yedek yol: jenerik kelimeler atilinca beyan cok kisaliyorsa HAM haliyle karsilastir.
  // 'FIBOTRAVEL MEDICAL' <-> 'Fibo Travel': 'travel' jenerik sayilip atilinca
  // beyandan geriye 'fibo' (4 harf) kaliyor ve esik alti dusuyordu.
  const fh = norm(firma), bh = norm(beyan);
  const [kh, uh] = fh.length <= bh.length ? [fh,bh] : [bh,fh];
  return kh.length >= 8 && uh.includes(kh);
}

/** Rol hesabi mi (info@, sales@...) yoksa isimli kisi mi */
export const ROL_HESAP = new Set(['info','bilgi','iletisim','contact','sales','satis','rezervasyon',
  'reservation','reservations','booking','operation','operasyon','muhasebe','destek','support',
  'office','admin','mail','hello','team','finance','finans','kurumsal','kalite','ticket']);
export const rolMu = (mail) => ROL_HESAP.has((mail || '').split('@')[0].toLowerCase());

/**
 * Mevcut adresi YENISIYLE degistirmeli miyiz?
 * {degistir:boolean, sebep:string}
 * H1  eski adres zaten firmanin alan adindaysa DOKUNMA
 * H2a ayni alan icinde isimli kisi -> jenerik kutu : ENGELLE
 * H2b ayni alan icinde jenerik -> isimli kisi      : IZIN VER
 */
export function degistirmeliMi(firma, eski, yeni) {
  const e = (eski || '').toLowerCase().trim(), y = (yeni || '').toLowerCase().trim();
  if (!y || !y.includes('@')) return { degistir:false, sebep:'yeni-adres-gecersiz' };
  if (!e) return { degistir:true, sebep:'eski-adres-yok' };
  if (e === y) return { degistir:false, sebep:'ayni-adres' };
  const eD = e.split('@')[1], yD = y.split('@')[1];
  if (eD === yD) {
    if (!rolMu(e) && rolMu(y)) return { degistir:false, sebep:'H2a-isimli-kisiden-jenerige' };
    return { degistir:true, sebep:'H2b-ayni-alan-iyilestirme' };
  }
  if (adAlanEslesmesi(firma, eD) === 'tam' && adAlanEslesmesi(firma, yD) !== 'tam')
    return { degistir:false, sebep:'H1-eski-adres-zaten-firmanin-alaninda' };
  return { degistir:true, sebep:'duzeltme' };
}
