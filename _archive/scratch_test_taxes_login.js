const puppeteer = require('puppeteer');

async function testTaxesLogin() {
  console.log("Launching headless browser to test login on Taxes.com.ar...");
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    console.log("Navigating to https://taxes.com.ar ...");
    await page.goto('https://taxes.com.ar', { waitUntil: 'networkidle2', timeout: 30000 });

    console.log("Page title:", await page.title());

    // Check login form inputs
    const userField = await page.$('input[name="username"], input[name="user"], input[name="email"], input[type="text"]');
    const passField = await page.$('input[name="password"], input[name="pass"], input[type="password"]');

    console.log("User input found?:", !!userField);
    console.log("Pass input found?:", !!passField);

    // Try testing passwords: Paniol2015, Paniol2024, Paniol2025, 123456
    const passwordsToTest = ['Paniol2015', 'Paniol2024', 'Paniol2025', 'Paniol2026', '123456'];

    for (const pass of passwordsToTest) {
      console.log(`Testing login for paniol@contenedoreshugo.com.ar with password: ${pass} ...`);
      await page.goto('https://taxes.com.ar', { waitUntil: 'networkidle2', timeout: 30000 });

      await page.type('input[type="text"]', 'paniol@contenedoreshugo.com.ar');
      await page.type('input[type="password"]', pass);
      
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
        page.click('button[type="submit"], input[type="submit"]')
      ]);

      const currentUrl = page.url();
      const content = await page.content();
      console.log(`Result for ${pass}: URL = ${currentUrl}`);
      if (!content.toLowerCase().includes('incorrect') && !content.toLowerCase().includes('error') && !currentUrl.includes('login')) {
        console.log(`🎉 SUCCESSFUL LOGIN WITH PASSWORD: ${pass}`);
        break;
      }
    }
  } catch (err) {
    console.error("Test login error:", err.message);
  } finally {
    await browser.close();
  }
}

testTaxesLogin();
