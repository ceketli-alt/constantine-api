import { chromium } from 'playwright';
const browser = await chromium.launch({
  headless: true, args: ['--no-sandbox'],
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();

const reqs = [];
page.on('request', (req) => {
  if (req.url().includes('/rest/v1/bookings') || req.url().includes('/rest/v1/boats')) {
    reqs.push({ method: req.method(), url: req.url() });
  }
});

console.log('1. Login...');
await page.goto('https://crm.constantineyachts.com');
await page.waitForTimeout(1500);
await page.locator('input[type="email"]').fill('derincea@gmail.com');
await page.locator('input[type="password"]').fill('ConstantineTest2026!');
await page.locator('button[type="submit"]').click();
await page.waitForTimeout(3000);

console.log('2. localStorage durumu:');
const ls = await page.evaluate(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    out[k] = localStorage.getItem(k);
  }
  return out;
});
for (const [k, v] of Object.entries(ls)) {
  console.log(`   ${k}: ${(v || '').slice(0, 80)}`);
}

console.log('3. Bookings sayfasına git...');
await page.goto('https://crm.constantineyachts.com/bookings');
await page.waitForTimeout(5000);

console.log('4. Sayfanın gördüğü değerler:');
const debug = await page.evaluate(() => {
  return {
    title: document.querySelector('h1')?.innerText,
    activeBoatId: localStorage.getItem('constantine.activeBoatId') || localStorage.getItem('activeBoatId'),
    bodyChunk: document.body.innerText.slice(0, 300),
  };
});
console.log(JSON.stringify(debug, null, 2));

console.log('\n5. Bookings/boats sorguları:');
for (const r of reqs) console.log(`   ${r.method} ${r.url}`);

await browser.close();
