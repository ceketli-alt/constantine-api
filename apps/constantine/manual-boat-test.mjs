import { chromium } from 'playwright';
const browser = await chromium.launch({
  headless: true, args: ['--no-sandbox'],
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();

const reqs = [];
page.on('request', (req) => {
  if (req.url().includes('/rest/v1/bookings')) {
    reqs.push({ method: req.method(), url: req.url().slice(0, 250) });
  }
});
const errs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`[${m.type()}] ${m.text().slice(0, 250)}`); });

await page.goto('https://crm.constantineyachts.com');
await page.waitForTimeout(1000);
await page.locator('input[type="email"]').fill('derincea@gmail.com');
await page.locator('input[type="password"]').fill('ConstantineTest2026!');
await page.locator('button[type="submit"]').click();
await page.waitForTimeout(3000);

// MANUEL: localStorage'a active boat yaz
await page.evaluate(() => {
  localStorage.setItem('constantine.activeBoat', 'all');
});

await page.goto('https://crm.constantineyachts.com/bookings');
await page.waitForTimeout(2000);
// FULL RELOAD ki React useState init tekrar çalışsın
await page.reload();
await page.waitForTimeout(5000);

const result = await page.evaluate(() => ({
  title: document.querySelector('h1')?.innerText,
  activeBoat: localStorage.getItem('constantine.activeBoat'),
  bodyChunk: document.body.innerText.slice(0, 400),
}));
console.log('Sonuç:', JSON.stringify(result, null, 2));

console.log('\nTÜM bookings sorguları (' + reqs.length + '):');
for (const r of reqs) console.log(`  ${r.method} ${r.url}`);
console.log('\nConsole err/warn (son 10):');
for (const e of errs.slice(-10)) console.log(`  ${e}`);

await browser.close();
