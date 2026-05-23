/**
 * Headless browser ile gerçek frontend testi
 * Console + network'ü kaydeder, login dener, ne fail ediyorsa raporlar.
 */
import { chromium } from 'playwright';

const URL = process.argv[2] || 'https://crm.constantineyachts.com';
const EMAIL = process.argv[3] || 'derincea@gmail.com';
const PASSWORD = process.argv[4] || 'ConstantineTest2026!';

console.log(`🌐 Testing: ${URL}`);
console.log(`👤 Login as: ${EMAIL}`);
console.log();

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();

// Capture everything
const consoleMessages = [];
const networkRequests = [];
const failedRequests = [];

page.on('console', (msg) => {
  consoleMessages.push({ type: msg.type(), text: msg.text() });
});
page.on('pageerror', (err) => {
  consoleMessages.push({ type: 'pageerror', text: err.message });
});
page.on('request', (req) => {
  if (req.url().includes('/rest/v1/') || req.url().includes('/auth/v1/') || req.url().includes('/functions/v1/')) {
    networkRequests.push({ method: req.method(), url: req.url(), headers: req.headers() });
  }
});
page.on('response', async (resp) => {
  const url = resp.url();
  if ((url.includes('/rest/v1/') || url.includes('/auth/v1/') || url.includes('/functions/v1/')) && resp.status() >= 400) {
    let body = '';
    try { body = (await resp.text()).slice(0, 300); } catch {}
    failedRequests.push({ method: resp.request().method(), url, status: resp.status(), body });
  }
});
page.on('requestfailed', (req) => {
  failedRequests.push({ method: req.method(), url: req.url(), error: req.failure()?.errorText });
});

console.log(`📄 ${URL}'e gidiyor...`);
try {
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  console.log(`✓ Sayfa yüklendi`);
} catch (e) {
  console.log(`❌ Sayfa yüklenemedi: ${e.message}`);
}

// Wait for React to render
await page.waitForTimeout(2000);

console.log(`\n🔍 Sayfada login formu var mı?`);
const emailInput = await page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="-mail" i]').first();
const passInput = await page.locator('input[type="password"]').first();
const hasForm = await emailInput.count() > 0 && await passInput.count() > 0;
console.log(`   Email input: ${await emailInput.count() > 0 ? '✓' : '✗'}`);
console.log(`   Password input: ${await passInput.count() > 0 ? '✓' : '✗'}`);

if (hasForm) {
  console.log(`\n📝 Form dolduruluyor + login...`);
  await emailInput.fill(EMAIL);
  await passInput.fill(PASSWORD);
  // Submit
  const submitBtn = page.locator('button[type="submit"], button:has-text("Giriş"), button:has-text("Login")').first();
  if (await submitBtn.count() > 0) {
    await submitBtn.click();
    await page.waitForTimeout(3000);
  } else {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
  }
  console.log(`✓ Submit yapıldı, URL şu an: ${page.url()}`);
}

console.log(`\n📡 Network istekleri:`);
for (const r of networkRequests.slice(-15)) {
  console.log(`   ${r.method.padEnd(7)} ${r.url}`);
}

console.log(`\n❌ Failed istekler (${failedRequests.length}):`);
for (const f of failedRequests.slice(0, 10)) {
  console.log(`   ${f.method?.padEnd(7) || ''} ${f.status || ''} ${f.url}`);
  if (f.body) console.log(`      body: ${f.body}`);
  if (f.error) console.log(`      err:  ${f.error}`);
}

console.log(`\n💬 Console messages — TÜM ERROR'lar tam metin:`);
for (const m of consoleMessages) {
  if (m.type === 'error' || m.type === 'pageerror') {
    console.log(`\n   [${m.type}]`);
    console.log(`   ${m.text}`);
  }
}

// Screenshot
await page.screenshot({ path: '/tmp/test-shot.png', fullPage: true });
console.log(`\n📸 Screenshot: /tmp/test-shot.png`);

await browser.close();
