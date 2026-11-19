/**
 * Hurşit mail ayrıştırıcısı.
 *
 * Gövdeler UYDURULMADI: aşağıdaki iki metin, 18 Kasım 2026 (reel) ve 17 Kasım
 * 2026 (5'li post) maillerinin Gmail'den okunan birebir kopyası. Hurşit'in
 * şablonu değişirse bu testler kırılır — istenen de budur, çünkü sessizce
 * yanlış caption'la gönderi atmaktansa job'ın durması yeğdir.
 *
 * Güvenlik testleri ayrıca var: dosya adı ve indirme adresi dış girdi; biri
 * diske yazılacak, diğeri sunucumuzun gideceği adres. İkisi de doğrulanmazsa
 * taklit bir mail bize istediği dosyayı indirtip kendi alan adımızdan
 * yayınlatabilir.
 */
import { describe, it, expect } from 'vitest';
import { parseHursitMail, rejectMediaReason } from '../instagram-hursit-parse.js';

const REEL_SUBJECT = 'Constantine Yachts Reel - 2026-11-18';
const REEL_BODY = ` ## Constantine Yachts - Yeni Reel!

*Tarih:* 2026-11-18 | *Dosya:* reel_constantine_20261118_080236.mp4 (25M)

*Baslik:* Sıradanlıktan Uzak

Boğaz'a yakın.

Constantine Yachts ile her anınız özel, her detay düşünülmüş.

Bio'daki linkten detayları inceleyin.

@constantineyachts

*Etiketler:* #ConstantineYachts #Boğaz #İstanbulEtkinlik #ÖzelOrganizasyon #VIPYat

[Direkt Indir](http://185.149.103.5/dl/constantine/reel_constantine_20261118_080236.mp4)`;

const POST_SUBJECT = '5 Yeni Constantine Post - 2026-11-17';
const POST_BODY = ` ## 5 Yeni Post Hazir!

*Tarih:* 2026-11-17

*Marka:* Constantine Yachts
### Instagram Icin:

*Baslik:* Boğaz'ın En Güzel Hali

*Caption:*

Gün batarken Boğaz'da yat ile süzülmek — bunu yaşamadan anlatmak zor.

Rezervasyonlar açık. DM atın.

@constantineyachts

*Etiketler:* #BoğazGünbatımı #ÖzelYat #İstanbul #YatKiralama #LuxuryIstanbul
### Dosyalar:

* [cpost_20261117_080042_1.jpg](http://185.149.103.5/dl/constantine_posts/cpost_20261117_080042_1.jpg)
* [cpost_20261117_080042_2.jpg](http://185.149.103.5/dl/constantine_posts/cpost_20261117_080042_2.jpg)
* [cpost_20261117_080042_3.jpg](http://185.149.103.5/dl/constantine_posts/cpost_20261117_080042_3.jpg)
* [cpost_20261117_080042_4.jpg](http://185.149.103.5/dl/constantine_posts/cpost_20261117_080042_4.jpg)
* [cpost_20261117_080042_5.jpg](http://185.149.103.5/dl/constantine_posts/cpost_20261117_080042_5.jpg)

[Google Drive](https://drive.google.com/drive/folders/1BOPegm5rSN_0pDMwWCpptVGitdfJK0uU)
------------------------------

Otomatik uretildi - Constantine Post Engine`;

describe('reel maili (18 Kasım 2026, gerçek gövde)', () => {
  const post = parseHursitMail(REEL_SUBJECT, REEL_BODY)!;

  it('REELS olarak tanınır', () => {
    expect(post.kind).toBe('REELS');
  });

  it('tarih konu başlığından değil *Tarih:* alanından okunur', () => {
    expect(post.date).toBe('2026-11-18');
  });

  it('başlık tekrar tespiti için ayrı tutulur', () => {
    expect(post.title).toBe('Sıradanlıktan Uzak');
  });

  it('tek video, dosya adı URL ile tutarlı', () => {
    expect(post.media).toEqual([
      {
        filename: 'reel_constantine_20261118_080236.mp4',
        url: 'http://185.149.103.5/dl/constantine/reel_constantine_20261118_080236.mp4',
      },
    ]);
  });

  it('5 etiket ayrıştırılır', () => {
    expect(post.hashtags).toHaveLength(5);
    expect(post.hashtags[0]).toBe('#ConstantineYachts');
  });

  it('caption: başlık ilk satır, gövde ortada, etiketler sonda', () => {
    // Instagram'da ayrı başlık alanı yok — başlık caption'a girmezse kaybolur.
    expect(post.caption).toBe(
      `Sıradanlıktan Uzak

Boğaz'a yakın.

Constantine Yachts ile her anınız özel, her detay düşünülmüş.

Bio'daki linkten detayları inceleyin.

@constantineyachts

#ConstantineYachts #Boğaz #İstanbulEtkinlik #ÖzelOrganizasyon #VIPYat`,
    );
  });

  it('başlık caption gövdesinde İKİ kez geçmez', () => {
    // Regresyon: *Baslik:* satırı gövdeden atılmazsa başlık tekrar ederdi.
    const kez = post.caption.split('Sıradanlıktan Uzak').length - 1;
    expect(kez).toBe(1);
  });
});

describe('5li post maili (17 Kasım 2026, gerçek gövde)', () => {
  const post = parseHursitMail(POST_SUBJECT, POST_BODY)!;

  it('CAROUSEL olarak tanınır', () => {
    expect(post.kind).toBe('CAROUSEL');
  });

  it('5 fotoğrafın hepsi alınır', () => {
    expect(post.media).toHaveLength(5);
    expect(post.media[0]!.filename).toBe('cpost_20261117_080042_1.jpg');
    expect(post.media[4]!.filename).toBe('cpost_20261117_080042_5.jpg');
  });

  it('Google Drive klasör linki medya sanılmaz', () => {
    // Klasör linki indirilebilir bir dosya değil; carousel öğesi olarak
    // gönderilirse Meta container hatası döner.
    expect(post.media.some((m) => m.url.includes('drive.google.com'))).toBe(false);
  });

  it('tek caption 5 fotoğrafın tamamını kapsar (carousel modeline uyar)', () => {
    expect(post.caption).toContain("Boğaz'ın En Güzel Hali");
    expect(post.caption).toContain('Rezervasyonlar açık. DM atın.');
    expect(post.caption).toContain('#BoğazGünbatımı');
  });

  it('caption gövdesine "Dosyalar" bölümü sızmaz', () => {
    expect(post.caption).not.toContain('cpost_');
    expect(post.caption).not.toContain('Otomatik uretildi');
  });
});

describe('tanınmayan mail', () => {
  it('Hurşit dışı mail null döner (aynı kutuya başka mailler de düşüyor)', () => {
    expect(parseHursitMail('Fatura #123', 'Sayın yetkili, ekte faturanız.')).toBeNull();
  });

  it('tarihi bozuk mail null döner', () => {
    const bozuk = REEL_BODY.replace('2026-11-18', 'yarin');
    expect(parseHursitMail(REEL_SUBJECT, bozuk)).toBeNull();
  });
});

describe('medya doğrulama — taklit mail savunması', () => {
  it('allow-list dışı host reddedilir', () => {
    // Senaryo: saldırgan Hurşit'i taklit eden bir mail atıyor. Host
    // doğrulanmazsa sunucumuz bu dosyayı indirip KENDİ alan adımızdan yayınlar.
    expect(rejectMediaReason('http://evil.example/dl/x.mp4')).toMatch(/allow-list/);
  });

  it('dizin dışına çıkma denemesi reddedilir', () => {
    expect(rejectMediaReason('http://185.149.103.5/dl/../../etc/passwd')).toMatch(/güvensiz|allow/);
  });

  it('bilinmeyen uzantı reddedilir', () => {
    expect(rejectMediaReason('http://185.149.103.5/dl/x.sh')).toMatch(/güvensiz dosya adı/);
  });

  it('doğru host + doğru ad kabul edilir', () => {
    expect(rejectMediaReason('http://185.149.103.5/dl/constantine/a_1.mp4')).toBeNull();
  });

  it('elenen medya sessizce yutulmaz, rejectedMedia dolar', () => {
    const sahte = REEL_BODY.replace('185.149.103.5', 'evil.example');
    const post = parseHursitMail(REEL_SUBJECT, sahte)!;
    expect(post.media).toHaveLength(0);
    expect(post.rejectedMedia).toHaveLength(1);
    expect(post.rejectedMedia[0]!.reason).toMatch(/allow-list/);
  });
});
