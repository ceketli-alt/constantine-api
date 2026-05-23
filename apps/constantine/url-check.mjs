import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome' });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();

await page.goto('https://crm.constantineyachts.com');
await page.waitForTimeout(1500);
await page.locator('input[type="email"]').fill('derincea@gmail.com');
await page.locator('input[type="password"]').fill('ConstantineTest2026!');
await page.locator('button[type="submit"]').click();
await page.waitForTimeout(3000);

await page.evaluate(() => localStorage.setItem('constantine.activeBoat', 'all'));

console.log('Before goto:', page.url());
await page.goto('https://crm.constantineyachts.com/bookings');
await page.waitForTimeout(1000);
console.log('After goto + 1s:', page.url());
await page.waitForTimeout(3000);
console.log('After +3s:', page.url());

// Search for boat selector
const boatSelector = await page.evaluate(() => {
  // Hangi button "Tüm Tekneler" veya "CONSTANTINE" diyor?
  const els = document.querySelectorAll('*');
  for (const el of els) {
    const t = el.textContent;
    if (t && (t.includes('Tüm Tekneler') || t.includes('Tekne Seç') || t.includes('CONSTANTINE') && el.tagName === 'BUTTON')) {
      return { tag: el.tagName, text: t.slice(0, 50) };
    }
  }
  return null;
});
console.log('Boat selector:', boatSelector);

await browser.close();
