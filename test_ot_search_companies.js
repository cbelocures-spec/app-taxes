/**
 * TEST SCRIPT: Lists all available companies for Pañol and searches for OT 25530 in each
 */
const puppeteer = require('puppeteer');

const PORTAL_URL = 'https://taxes.com.ar';
const USERNAME   = 'paniol@contenedoreshugo.com.ar';
const PASSWORD   = 'Paniol2015';
const OT_NUM     = '25530';

const delay = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--start-maximized'],
    defaultViewport: null,
  });
  const page = await browser.newPage();

  // 1. LOGIN
  console.log(`Logging in as ${USERNAME}...`);
  await page.goto(`${PORTAL_URL}/login`, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  const userInput = await page.$('input[type="email"], input[name="email"]');
  if (userInput) { await userInput.click({ clickCount: 3 }); await userInput.type(USERNAME, { delay: 60 }); }
  const passInput = await page.$('input[type="password"]');
  if (passInput) { await passInput.click({ clickCount: 3 }); await passInput.type(PASSWORD, { delay: 60 }); }
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.type === 'submit' || b.textContent.toLowerCase().includes('ingresar'));
    if (btn) btn.click();
  });
  await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
  await delay(2000);
  console.log('Logged in. URL:', page.url());

  // 2. GET ALL COMPANIES FROM TOP-LEFT DROPDOWN
  console.log('Detecting available companies...');
  // Click the company selector to open the dropdown
  await page.evaluate(() => {
    const selector = document.querySelector('.navbar-brand, .navbar-brand + div, [class*="company-select"], .sidebar-brand, [style*="cursor: pointer"]');
    if (selector) selector.click();
  }).catch(() => {});
  await delay(1500);

  const companies = await page.evaluate(() => {
    // Find all dropdown item texts or options
    const items = Array.from(document.querySelectorAll('.dropdown-item, .dropdown-menu li a, [role="menuitem"]'));
    return items.map((item, idx) => ({
      index: idx,
      text: item.textContent.trim(),
      hasClick: typeof item.click === 'function'
    })).filter(i => i.text !== '');
  });
  console.log('Companies found:', JSON.stringify(companies, null, 2));

  // If no companies found, try another selector
  if (companies.length === 0) {
    const companyText = await page.evaluate(() => {
      const el = document.querySelector('.sidebar-brand, [class*="brand"], [class*="company"]');
      return el ? el.textContent.trim() : 'Unknown';
    });
    console.log(`Only one company visible: ${companyText}`);
    companies.push({ index: 0, text: companyText, hasClick: false });
  }

  // 3. SEARCH OT IN EACH COMPANY
  for (const comp of companies) {
    console.log(`\n----------------------------------------`);
    console.log(`Switching to Company: ${comp.text}`);
    if (comp.hasClick) {
      await page.evaluate((idx) => {
        // Re-open selector
        const selector = document.querySelector('.navbar-brand, .navbar-brand + div, [class*="company-select"], .sidebar-brand, [style*="cursor: pointer"]');
        if (selector) selector.click();
      });
      await delay(800);
      await page.evaluate((idx) => {
        const items = Array.from(document.querySelectorAll('.dropdown-item, .dropdown-menu li a, [role="menuitem"]')).filter(i => i.textContent.trim() !== '');
        if (items[idx]) items[idx].click();
      }, comp.index);
      await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
      await delay(3000);
    }

    console.log('Navigating to /tms/produccion/ot...');
    await page.goto(`${PORTAL_URL}/tms/produccion/ot`, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(3000);

    console.log('Clicking En Proceso tab...');
    await page.evaluate(() => {
      const navLinks = Array.from(document.querySelectorAll('a.nav-link, [role="tab"], .nav-tabs li a, .nav li a'));
      const tab = navLinks.find(t => t.textContent.trim().toLowerCase().includes('en proceso'));
      if (tab) tab.click();
    });
    await delay(2000);

    const numId = await page.evaluate(() => {
      const vis = Array.from(document.querySelectorAll('input[type="text"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')).filter(i => i.offsetParent);
      const inp = vis[3] || vis[2];
      if (inp) {
        if (!inp.id) inp.id = 'company-test-num';
        return inp.id;
      }
      return null;
    });

    if (numId) {
      await page.click(`#${numId}`, { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.keyboard.type(OT_NUM, { delay: 60 });
      await page.keyboard.press('Enter');
      await delay(1000);
    }

    // Click BUSCAR natively
    const buscarBtnId = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent.trim().toUpperCase() === 'BUSCAR' || b.textContent.toLowerCase().includes('buscar')
      );
      if (btn) {
        if (!btn.id) btn.id = 'company-test-buscar';
        return btn.id;
      }
      return null;
    });
    if (buscarBtnId) {
      await page.click(`#${buscarBtnId}`).catch(() => {});
    }

    // Wait and check result
    console.log('Waiting for search result...');
    await delay(3500);

    const resultRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map(r => Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim()).join(' | '));
    });

    const foundIdx = resultRows.findIndex(r => r.replace(/#/g, '').includes(OT_NUM));
    console.log(`Company "${comp.text}": Found OT ${OT_NUM} at row index: ${foundIdx}`);
    if (foundIdx !== -1) {
      console.log(`SUCCESS! Matching row: ${resultRows[foundIdx]}`);
    }
  }

  console.log('\n=== DONE. Press Ctrl+C to exit. ===');
  await new Promise(() => {});
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
