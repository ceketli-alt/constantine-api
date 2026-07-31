# Bulgu: canlı API'ler yanlış süreci süpervize ediyor (2026-07-31)

**Durum: BİLDİRİM — hiçbir şey değiştirilmedi.** Düzeltme canlı CRM API'sinin
yeniden başlatılmasını gerektiriyor, o yüzden karar Mert'te.

Bu bulgu DMC teklif motorunda **aynı hatanın gerçekten patlamasıyla** ortaya çıktı:
orada PM2 restart sayacı **1787**, hata logunda **3522 EADDRINUSE** ölçüldü.
Düzeltildi ve kanıtlandı (`dmc-quote-engine`, commit `d7ebf19`). Aynı yapı burada da var.

## Ölçülen

| servis | PM2'nin izlediği | portu gerçekten tutan | arada |
|---|---|---|---|
| `api-constantine` | `node /usr/bin/pnpm dev` (854) | node **1419** → :4001 | `sh` + `tsx watch` |
| `api-concierge` | `node /usr/bin/pnpm dev` (873) | node **1379** → :4002 | `sh` + `tsx watch` |
| `dmc-quote` | node (750515) | node **750515** → :8788 | — (düzeltildi) |

### Sonuçları

1. **Sinyal hedefine ulaşmıyor.** `src/server.ts:500`'de düzgün bir
   `process.on('SIGTERM', ...)` handler'ı var — **ama hiç çalışmıyor.** PM2 sinyali
   en üstteki `pnpm`e gönderiyor, aradaki halkalar torunlara iletmiyor.
   Kapanışta uçuştaki istekler kesiliyor, DB havuzu boşaltılmıyor.

2. **Restart döngüsü riski.** Eski dinleyici portu bırakmazsa yeni örnek
   `EADDRINUSE` alıp çöker, PM2 tekrar başlatır → döngü. Servisler 336 saattir
   ayakta çünkü kimse yeniden başlatmıyor; **ilk deploy/restart'ta patlayabilir.**

3. **Canlı API dev modunda koşuyor** (`tsx watch`). Dosya değişimini izliyor:
   deploy sırasında bir dosyaya dokunmak API'yi kendiliğinden yeniden başlatabilir.

4. **`pnpm start` bu sunucuda ÇALIŞMIYOR** — ölçüldü:
   ```
   $ node --experimental-strip-types -e "..."
   node: bad option: --experimental-strip-types      # Node 20.20.2; bu bayrak 22.6+ istiyor
   ```
   Yani `dev`'e düşülmesi bir tercih değil, `start`'ın kırık olmasının sonucu.
   **Bu yüzden "pnpm start'a geç" yanlış öneri olur.**

## Önerilen düzeltme (dmc-quote'ta uygulandı ve ölçüldü)

`node --import tsx` tsx'i **aynı sürece** loader olarak bağlar; ayrı çocuk süreç
doğmaz, PM2'nin izlediği PID portu dinleyen PID olur. Ölçülen sonuç: 5 ardışık
restart, her seferinde PID eşleşmesi + health 200, **0 EADDRINUSE**, her kapanışta
`[shutdown] temiz çıkış`.

```js
// /var/www/api/ecosystem.config.cjs
module.exports = { apps: [
  { name: 'api-constantine', cwd: '/var/www/api/apps/constantine',
    script: 'src/server.ts', interpreter: 'node', interpreter_args: '--import tsx',
    exec_mode: 'fork', kill_timeout: 12000, min_uptime: 10000, max_restarts: 10,
    exp_backoff_restart_delay: 2000, time: true, merge_logs: true },
  { name: 'api-concierge',  cwd: '/var/www/api/apps/concierge',   /* aynı alanlar */ },
]};
```

**Uygulama sırası (kısa kesinti — CRM API'si ~5sn):**
```bash
cd /var/www/api
pm2 delete api-constantine && pm2 start ecosystem.config.cjs --only api-constantine
sleep 6 && curl -s -o /dev/null -w "%{http_code}\n" https://api.constantineyachts.com/health
# PID == dinleyen PID mi:
pm2 jlist | python3 -c "import json,sys;print([ (p['name'],p['pid']) for p in json.load(sys.stdin)])"
ss -lptn 'sport = :4001'
pm2 save
```
Geri dönüş: `pm2 delete api-constantine && pm2 start bash --name api-constantine -- -c "pnpm dev"`

⚠️ **Önce doğrula:** `apps/constantine`'de `tsx` bağımlılık olarak kurulu mu
(`node_modules/.bin/tsx`). Kurulu değilse `pnpm add -D tsx` gerekir.

## İlgili — zaten yapıldı (2026-07-31)

- **Veritabanı yedeği yoktu**, artık var: `/usr/local/bin/pg-auto-backup.sh`,
  günlük 03:30, `constantine` dahil. **Geri yükleme kanıtlandı** (144.852 satır,
  tablo bazında birebir). Haftalık otomatik geri-yükleme testi koşuyor.
  Sınır: yedekler **bu makinede**; makine kaybına karşı korumuyor (offsite = Mert'in kararı).
- **PM2 logları hiç dönmüyordu** (158MB) → `/etc/logrotate.d/pm2`, 157MB→13MB.
- **Monitör** artık `dmc-quote`u ve yedek bayatlığını da izliyor.
