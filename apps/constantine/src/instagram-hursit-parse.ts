/**
 * instagram-hursit-parse.ts — Hurşit'in içerik mailini yapısal veriye çevirir.
 *
 * Hurşit (hursit@marriageproposal.com.tr) ayrı bir AI agent; her gün 08:00 TR'de
 * iki tipten birini gönderiyor. Mail HEM caption'ı HEM dosya adını HEM doğrudan
 * indirme linkini taşıdığı için medya↔caption eşleştirmesi tahmine dayanmıyor:
 * tek maildeki alanları okumak yeterli.
 *
 *   Tip 1 "Constantine Yachts Reel - YYYY-MM-DD"  → tek video (REELS)
 *   Tip 2 "5 Yeni Constantine Post - YYYY-MM-DD"  → 5 foto + TEK caption (CAROUSEL)
 *
 * Tip 2'nin tek caption'ı Instagram'ın carousel modeline birebir oturuyor:
 * carousel'de de zaten gönderi başına tek caption var.
 *
 * NEDEN SAF FONKSİYON: Ağ, IMAP ve DB burada yok. Mail gövdesi metin olarak
 * girer, nesne çıkar. Böylece gerçek mail gövdeleriyle test edilebiliyor
 * (__tests__/instagram-hursit-parse.test.ts gerçek 18 Kasım ve 17 Kasım
 * maillerinin birebir kopyasını kullanıyor).
 *
 * ── GÜVENLİK: BURADAN GELEN HİÇBİR ŞEY GÜVENİLİR DEĞİL ────────────────────
 * Mail gövdesi dış girdi. Ondan gelen iki değer sonradan TEHLİKELİ yerlerde
 * kullanılacak, o yüzden ayrıştırma anında doğrulanıyorlar:
 *
 *  1. DOSYA ADI → diske yazılıp nginx ile PUBLIC servis edilecek. Doğrulanmazsa
 *     "../../etc/cron.d/x" gibi bir ad dizin dışına yazma denemesine dönüşür.
 *     Bu yüzden ad katı bir desene uymak zorunda (harf/rakam/._- ve uzantı).
 *
 *  2. İNDİRME ADRESİ → sunucumuz o adrese GİDİP indirecek ve içeriği KENDİ
 *     alan adımızdan yayınlayacak. Host doğrulanmazsa, maili taklit eden biri
 *     bize istediği dosyayı indirtip api.constantineyachts.com üzerinden
 *     servis ettirebilir (ve oradan Instagram'a bastırabilir). Host allow-list
 *     dışındaysa medya kabul edilmiyor.
 *
 * Mail imzalı/doğrulanmış değil; allow-list bu yüzden tek savunma hattı.
 */

/** Hurşit'in indirme sunucusu. Düz HTTP ve çıplak IP — TLS yok, yani yol
 *  üstündeki biri içeriği değiştirebilir. Adres değişirse burası güncellenmeli;
 *  sabit tutulması bilinçli, "her host olur" demek allow-list'i anlamsız kılar. */
export const ALLOWED_MEDIA_HOSTS = ['185.149.103.5'];

/** Dosya adı deseni: yalnız harf/rakam/nokta/alt çizgi/tire + bilinen uzantı.
 *  Dizin ayıracı ve ".." kabul edilmiyor (bkz. yukarıdaki 1. madde). */
const SAFE_FILENAME = /^[A-Za-z0-9._-]+\.(mp4|mov|jpg|jpeg|png|webp)$/;

export type HursitKind = 'REELS' | 'CAROUSEL';

export interface HursitMedia {
  filename: string;
  url: string;
}

export interface HursitPost {
  kind: HursitKind;
  /** YYYY-MM-DD — mailin *Tarih:* alanı, konu başlığı değil. */
  date: string;
  /** *Baslik:* — tekrar tespitinin anahtarı. Hurşit şablon havuzunu 20 günde
   *  bir döngüye alıyor (ölçüldü 2026-11-18: 5 başlıkta 5 tekrar), bu yüzden
   *  başlık yayın geçmişiyle karşılaştırılıp aynısı iki kez atılmıyor. */
  title: string;
  /** Instagram'a gidecek nihai metin (başlık + gövde + etiketler). */
  caption: string;
  hashtags: string[];
  media: HursitMedia[];
  /** Allow-list dışı host ya da güvensiz ad yüzünden ELENEN medya. Boş
   *  olmaması sessizce yutulmamalı — çağıran taraf uyarmalı. */
  rejectedMedia: { raw: string; reason: string }[];
}

/** Satır başındaki "*Alan:*" etiketinin değerini döndürür. */
function field(body: string, label: string): string | null {
  const re = new RegExp(`\\*${label}:\\*\\s*(.*)`, 'i');
  const m = body.match(re);
  return m?.[1]?.trim() || null;
}

/** Markdown link: [metin](url) → tüm eşleşmeler. */
function markdownLinks(body: string): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push({ text: m[1]!.trim(), url: m[2]!.trim() });
  }
  return out;
}

/**
 * Bir medya adayını allow-list ve ad desenine göre doğrular.
 * Dönen `null` = kabul; string = ret sebebi.
 */
export function rejectMediaReason(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'geçersiz URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `beklenmeyen protokol: ${parsed.protocol}`;
  }
  if (!ALLOWED_MEDIA_HOSTS.includes(parsed.hostname)) {
    return `allow-list dışı host: ${parsed.hostname}`;
  }
  const filename = parsed.pathname.split('/').pop() ?? '';
  if (!SAFE_FILENAME.test(filename)) {
    return `güvensiz dosya adı: ${filename}`;
  }
  return null;
}

function collectMedia(urls: string[]): Pick<HursitPost, 'media' | 'rejectedMedia'> {
  const media: HursitMedia[] = [];
  const rejectedMedia: { raw: string; reason: string }[] = [];
  for (const url of urls) {
    const reason = rejectMediaReason(url);
    if (reason) {
      rejectedMedia.push({ raw: url, reason });
      continue;
    }
    const filename = new URL(url).pathname.split('/').pop()!;
    // Aynı dosya iki kez listelenirse tekrar indirme.
    if (!media.some((m) => m.filename === filename)) media.push({ filename, url });
  }
  return { media, rejectedMedia };
}

/**
 * Caption gövdesini çıkarır: başlangıç etiketinden *Etiketler:* satırına kadar.
 * Gövde Hurşit'in yazdığı haliyle AYNEN korunuyor — "@constantineyachts" imza
 * satırı dahil. Markanın kendi gönderisinde kendini etiketlemesi tuhaf durabilir
 * ama bu bir içerik kararı; ayrıştırıcı metni sessizce değiştirmez.
 */
function captionBody(body: string, startLabel: string): string {
  const startRe = new RegExp(`\\*${startLabel}:\\*\\s*`, 'i');
  const startMatch = body.match(startRe);
  if (!startMatch || startMatch.index === undefined) return '';
  let rest = body.slice(startMatch.index + startMatch[0].length);
  // Tip 1'de başlık ile gövde aynı bloktan gelir; başlığın kendi satırı atılır.
  if (startLabel === 'Baslik') rest = rest.replace(/^.*\r?\n/, '');
  const endIdx = rest.search(/\*Etiketler:\*/i);
  if (endIdx !== -1) rest = rest.slice(0, endIdx);
  return rest.trim();
}

/**
 * Ana giriş noktası. Tanınmayan mail için null döner (Hurşit dışı mailler
 * aynı kutuya düşüyor; sessizce atlanmaları gerekiyor).
 */
export function parseHursitMail(subject: string, body: string): HursitPost | null {
  const isReel = /Yeni Reel/i.test(body) || /Reel\s*-\s*\d{4}-\d{2}-\d{2}/i.test(subject);
  const isCarousel = /Yeni Post Hazir/i.test(body) || /Yeni Constantine Post/i.test(subject);
  if (!isReel && !isCarousel) return null;

  const date = field(body, 'Tarih')?.split('|')[0]?.trim() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const title = field(body, 'Baslik');
  if (!title) return null;

  const hashtags = (field(body, 'Etiketler') ?? '')
    .split(/\s+/)
    .filter((t) => t.startsWith('#'));

  const links = markdownLinks(body);

  let kind: HursitKind;
  let urls: string[];
  let bodyText: string;

  if (isReel) {
    kind = 'REELS';
    // "Direkt Indir" linki videoyu taşır; Drive linki (varsa) medya değil.
    urls = links.filter((l) => /indir/i.test(l.text)).map((l) => l.url);
    bodyText = captionBody(body, 'Baslik');
  } else {
    kind = 'CAROUSEL';
    // "Dosyalar:" bölümündeki linkler. Google Drive linki klasör, medya değil —
    // link METNİ dosya adıysa al, böylece Drive satırı kendiliğinden elenir.
    urls = links.filter((l) => SAFE_FILENAME.test(l.text)).map((l) => l.url);
    bodyText = captionBody(body, 'Caption');
  }

  const { media, rejectedMedia } = collectMedia(urls);

  // Instagram'da ayrı bir başlık alanı YOK; "Baslik" ya caption'ın ilk satırı
  // olur ya da tamamen kaybolur. İlk satır yapılıyor.
  const caption = [title, bodyText, hashtags.join(' ')]
    .filter((p) => p.length > 0)
    .join('\n\n');

  return { kind, date, title, caption, hashtags, media, rejectedMedia };
}
