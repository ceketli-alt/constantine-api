// PM2 süreç tanımı — /var/www/api (constantine + concierge)
// ---------------------------------------------------------------------------
// NEDEN BU DOSYA DEĞİŞTİ (2026-07-31):
//
// Bu dosya 21 Mayıs'tan beri duruyordu ama ÇALIŞMIYORDU: canlı servisler
// 28 Mayıs'ta elle `pm2 start bash --name api-constantine -- -c "pnpm dev"`
// ile ayağa kaldırılmış. Yani dosyadaki tanım ile çalışan süreç birbirini
// tutmuyordu; `pm2 start ecosystem.config.cjs` diyen biri bambaşka bir şey
// başlatacaktı. Eski tanım da hatalıydı: `script: node_modules/.bin/tsx` →
// tsx CLI kendi çocuk node sürecini doğurur, aşağıdaki 1. maddedeki PID
// uyuşmazlığı orada da vardı. Ayrıca api-concierge hiç tanımlı değildi.
//
//  1. PM2 YANLIŞ SÜRECİ İZLİYORDU. Ölçülen süreç ağacı (2026-07-31):
//        pnpm(854, PM2'nin gördüğü) → sh(1283) → tsx watch(1284) → node(1419, :4001'i TUTAN)
//        pnpm(873, PM2'nin gördüğü) → sh(1191) → tsx watch(1192) → node(1379, :4002'yi TUTAN)
//     PM2 sinyali en üste gönderiyor, aradaki halkalar torunlara iletmiyor.
//     Sonuç: eski dinleyici portu tutmaya devam ederse yeni örnek EADDRINUSE
//     alıp çöker, PM2 tekrar başlatır → döngü. Bu teorik değil: aynı yapı
//     dmc-quote-engine'de gerçekten patladı (1787 restart, 3522 EADDRINUSE,
//     commit d7ebf19). Buradaki servisler 336 saattir ayakta çünkü kimse
//     yeniden başlatmadı — ilk deploy'da patlayabilirdi.
//     Çözüm: node DOĞRUDAN çalıştırılır → PM2'nin izlediği PID ile portu
//     dinleyen PID AYNI olur (ölçüldü).
//
//  2. CANLI API `tsx watch` İLE KOŞUYORDU. Dosya değişimini izliyordu: deploy
//     sırasında bir dosyaya dokunmak canlı CRM API'sini kendiliğinden yeniden
//     başlatabilirdi. `watch` kaldırıldı.
//
// NEDEN `pnpm start` DEĞİL: apps/*/package.json'daki start betiği
// `node --experimental-strip-types` kullanıyor, o bayrak Node 22.6+ istiyor,
// bu sunucuda Node 20.20.2 var (ölçüldü: "node: bad option"). `dev`'e düşülmesi
// bir tercih değil, start'ın bu sunucuda kırık olmasının sonucuydu.
// `node --import tsx` tsx'i AYNI sürece loader olarak bağlar; ayrı çocuk süreç
// doğmaz. Node 20.20.2 + tsx 4.22.3 ile her iki app cwd'sinde doğrulandı.
//
// ⚠ DİKKAT — SIGINT: PM2 7.0.1 kapatma sinyali olarak SIGTERM değil SIGINT
// gönderiyor ve bu SÜRÜMDE per-app `kill_signal` alanı okunmuyor; kod global
// sabiti kullanıyor (lib/God/Methods.js:241 → cst.KILL_SIGNAL, constants.js:106
// → process.env.PM2_KILL_SIGNAL || 'SIGINT'). Yani buraya `kill_signal` yazmak
// SESSİZCE ETKİSİZ KALIR. src/server.ts'teki düzgün kapanışın çalışması için
// handler'ın SIGINT'i de karşılaması gerekir; yoksa süreç Node'un varsayılan
// davranışıyla anında ölür (port serbest kalır ama DB havuzu boşaltılmaz,
// uçuştaki istekler kesilir).
//
// Kullanım:  cd /var/www/api && pm2 start ecosystem.config.cjs && pm2 save
// ---------------------------------------------------------------------------

/**
 * Ortak alanlar. Tek tek tekrar etmek yerine burada toplanıyor ki iki servis
 * arasında sessizce ayrışmasınlar.
 */
const ortak = {
  interpreter: 'node',
  // tsx'i loader olarak AYNI sürece bağlar (ayrı çocuk süreç doğmaz).
  interpreter_args: '--import tsx',
  script: 'src/server.ts',
  exec_mode: 'fork',
  instances: 1,

  // --- Kapanış ---
  // server.ts kendi 10sn'lik guard'ıyla çıkmalı; PM2 SIGKILL'i ondan SONRA
  // atsın, yoksa düzgün kapanış hiç tamamlanamaz. (Yukarıdaki SIGINT notu:
  // handler SIGINT'i karşılamıyorsa bu süre zaten devreye girmez.)
  kill_timeout: 12000,

  // --- Restart politikası ---
  // Amaç: çöken servisi ayağa kaldırmak, ama saniyede iki kez dönen bir
  // döngüye girmemek. 10sn'den kısa yaşayan süreç "kararsız" sayılır;
  // 10 kararsız denemeden sonra PM2 durur — sessizce dönüp durmaktansa
  // servis kapalı kalsın ve monitör bunu FAIL olarak görsün.
  autorestart: true,
  min_uptime: 10000,
  max_restarts: 10,
  exp_backoff_restart_delay: 2000,

  // Bu sunucuda bellek dar (7,7GB, 4,5GB kullanımda, 2,3GB swap'te; 7 PM2
  // servisi + Postgres). Kaçan süreç Postgres'i değil kendini vursun.
  // 14 günlük ölçüm: constantine 105MB, concierge 52MB. 600M sıkı bir sınır
  // değil, kaçak koruması.
  max_memory_restart: '600M',

  // Log satırlarına zaman damgası. dmc-quote'ta damga olmadığı için EADDRINUSE
  // patlamasının NE ZAMAN olduğu geriye dönük saptanamamıştı.
  time: true,

  // merge_logs ŞART: tek başına out_file/error_file yetmiyor, PM2 dosya adının
  // sonuna pm_id ekliyor (dmc-quote'ta ölçüldü: -8 son eki). Uygulama silinip
  // yeniden kurulunca pm_id değişir, log başka dosyaya kayar ve ESKİ dosyaya
  // bakan her kontrol boşta çalışır.
  merge_logs: true,

  // NODE_ENV kasten AYARLANMIYOR. Çalışan süreçlerde de ayarlı değil ve
  // src/ içinde hiçbir yer okumuyor (grep: 0 sonuç). Bu restart'ın tek
  // değişkeni süpervizyon olsun; NODE_ENV=production üçüncü parti
  // kütüphanelerin davranışını ölçülmemiş şekilde değiştirebilir.
  // Gerekirse ayrıca ve bilinçli olarak eklenir.
};

module.exports = {
  apps: [
    {
      ...ortak,
      name: 'api-constantine',
      cwd: '/var/www/api/apps/constantine',
      // PORT apps/constantine/.env'den geliyor (PORT=4001); load-env.ts
      // dotenv'i override:true ile cwd'ye göre yüklüyor. cwd aynı kaldığı
      // için davranış `pnpm dev` ile birebir aynı.
      // Log yolları MEVCUT dosyalara sabitlendi: /etc/logrotate.d/pm2
      // /root/.pm2/logs/*.log glob'unu döndürüyor ve 14 günlük geçmiş orada.
      // (Eski tanımdaki /var/log/... yolları hiçbir rotasyon kuralına girmiyordu.)
      out_file: '/root/.pm2/logs/api-constantine-out.log',
      error_file: '/root/.pm2/logs/api-constantine-error.log',
    },
    {
      ...ortak,
      name: 'api-concierge',
      cwd: '/var/www/api/apps/concierge',
      // PORT apps/concierge/.env'den geliyor (PORT=4002). DİKKAT:
      // src/server.ts:47'deki yedek değer 4002 değil 4001 — yani .env
      // okunamazsa concierge constantine'in portuna çakışır. cwd doğru
      // olduğu sürece sorun yok; yedek değer ayrıca düzeltilmeli.
      out_file: '/root/.pm2/logs/api-concierge-out.log',
      error_file: '/root/.pm2/logs/api-concierge-error.log',
    },
  ],
};
