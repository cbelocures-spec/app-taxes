/**
 * TEST SCRIPT: Search for OT 25530 in all tabs (En Proceso, Cerradas, Consultar, Historial)
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

  const tabs = ['En Proceso', 'Cerradas', 'Consultar', 'Historial'];
  for (const tabName of tabs) {
    console.log(`\n========================================`);
    console.log(`Searching in Tab: ${tabName}`);
    await page.goto(`${PORTAL_URL}/tms/produccion/ot`, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(3000);

    // Click tab
    const clicked = await page.evaluate((name) => {
      const links = Array.from(document.querySelectorAll('a.nav-link, [role="tab"], .nav-tabs li a, .nav li a'));
      const t = links.find(l => l.textContent.trim().toLowerCase() === name.toLowerCase());
      if (t) { t.click(); return t.textContent.trim(); }
      return null;
    }, tabName);
    console.log(`Clicked tab: ${clicked}`);
    await delay(2500);

    // Find input
    const numId = await page.evaluate(() => {
      const vis = Array.from(document.querySelectorAll('input[type="text"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')).filter(i => i.offsetParent);
      const inp = vis[3] || vis[2];
      if (inp) {
        if (!inp.id) inp.id = 'tab-search-num';
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

    // Click BUSCAR
    const buscarBtnId = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent.trim().toUpperCase() === 'BUSCAR' || b.textContent.toLowerCase().includes('buscar')
      );
      if (btn) {
        if (!btn.id) btn.id = 'tab-search-buscar';
        return btn.id;
      }
      return null;
    });
    if (buscarBtnId) {
      await page.click(`#${buscarBtnId}`).catch(() => {});
    }

    await delay(3500);

    // Read result
    const resultRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map(r => Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim()).join(' | '));
    });

    const foundIdx = resultRows.findIndex(r => r.replace(/#/g, '').includes(OT_NUM));
    console.log(`Tab "${tabName}": Found at row index: ${foundIdx}`);
    if (foundIdx !== -1) {
      console.log(`MATCHING ROW: ${resultRows[foundIdx]}`);
    }
  }

  console.log('\n=== DONE. Press Ctrl+C to exit. ===');
  await new Promise(() => {});
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
