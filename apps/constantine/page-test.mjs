import { chromium } from 'playwright';
const PAGES = ['', 'bookings', 'leads', 'tasks', 'reports', 'expenses'];
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
console.log('Login...');
await page.goto('https://crm.constantineyachts.com');
await page.waitForTimeout(1500);
await page.locator('input[type="email"]').fill('derincea@gmail.com');
await page.locator('input[type="password"]').fill('ConstantineTest2026!');
await page.locator('button[type="submit"]').click();
await page.waitForTimeout(3000);
console.log(`URL: ${page.url()}`);

for (const p of PAGES) {
  await page.goto(`https://crm.constantineyachts.com/${p}`);
  await page.waitForTimeout(2500);
  const title = await page.locator('h1, h2').first().innerText().catch(() => '?');
  const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 200).replace(/\n+/g, ' | ');
  console.log(`\n─── /${p} ───`);
  console.log(`  title: ${title.slice(0, 60)}`);
  console.log(`  body:  ${body}`);
  await page.screenshot({ path: `/tmp/page-${p || 'dashboard'}.png` });
}
await browser.close();
