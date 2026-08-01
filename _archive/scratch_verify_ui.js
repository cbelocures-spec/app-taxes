const puppeteer = require('puppeteer');

async function testPage() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  
  // Capture page console logs and errors
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  page.on('pageerror', err => console.error('BROWSER ERROR:', err.message));

  console.log("Navigating to Railway app...");
  await page.goto('https://app-taxes-production-ec67.up.railway.app/', { waitUntil: 'networkidle2' });

  // Wait for dashboard to render
  await page.waitForTimeout(3000);

  const stats = await page.evaluate(() => {
    const workingEl = document.getElementById('count-working');
    const pausedEl = document.getElementById('count-paused');
    const freeEl = document.getElementById('count-free');
    const workingGrid = document.getElementById('grid-working');

    return {
      workingCount: workingEl ? workingEl.textContent : 'N/A',
      pausedCount: pausedEl ? pausedEl.textContent : 'N/A',
      freeCount: freeEl ? freeEl.textContent : 'N/A',
      workingCards: workingGrid ? workingGrid.querySelectorAll('.dashboard-card').length : 0
    };
  });

  console.log("Dashboard UI stats after restoration:", stats);
  await page.screenshot({ path: 'public/restored_dashboard_test.png', fullPage: true });
  console.log("Screenshot saved to public/restored_dashboard_test.png");

  await browser.close();
}

testPage().catch(err => {
  console.error("Puppeteer error:", err.message);
});
