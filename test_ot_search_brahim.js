/**
 * TEST SCRIPT v3: Runs the test with a.brahim credentials to see if the OT list is different
 * Run: node test_ot_search_brahim.js
 */
const puppeteer = require('puppeteer');

const PORTAL_URL = 'https://taxes.com.ar';
const USERNAME   = 'a.brahim@contenedoreshugo.com.ar';
const PASSWORD   = '123456';
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

  // ── LOGIN ──
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

  // ── NAVIGATE TO OT ──
  console.log('Going to /tms/produccion/ot...');
  await page.goto(`${PORTAL_URL}/tms/produccion/ot`, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  // ── CLICK "EN PROCESO" TAB ──
  console.log('Clicking En Proceso tab...');
  const tabClicked = await page.evaluate(() => {
    const navLinks = Array.from(document.querySelectorAll('a.nav-link, [role="tab"], .nav-tabs li a, .nav li a'));
    const tab = navLinks.find(t => t.textContent.trim().toLowerCase().includes('en proceso'));
    if (tab) { tab.click(); return tab.textContent.trim(); }
    return null;
  });
  console.log('Tab clicked:', tabClicked);
  await delay(3000);

  // ── FIND THE NUMERO FILTER INPUT ──
  const numId = await page.evaluate(() => {
    const normalizeText = s => (s || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const vis = Array.from(document.querySelectorAll('input[type="text"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')).filter(i => i.offsetParent);
    const inp = vis[3] || vis[2];
    if (inp) {
      if (!inp.id) inp.id = 'test-numero-brahim';
      return inp.id;
    }
    return null;
  });
  console.log('Numero input found:', numId);

  if (numId) {
    await page.click(`#${numId}`, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.keyboard.type(OT_NUM, { delay: 80 });
    console.log(`Typed "${OT_NUM}"`);
    await delay(500);
  }

  // ── BUSCAR ──
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('buscar'));
    if (btn) btn.click();
  });
  await delay(3000);

  // ── READ RESULT ROWS ──
  const resultRows = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    return rows.map(r => Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim()).join(' | '));
  });
  console.log(`\nResult: ${resultRows.length} rows after BUSCAR:`);
  resultRows.forEach((r, i) => console.log(`  [${i}] ${r}`));

  const foundIdx = resultRows.findIndex(r => r.replace(/#/g, '').includes(OT_NUM));
  console.log(`\nOT ${OT_NUM} at row index: ${foundIdx}`);

  console.log('\n=== DONE. Inspect browser window. Press Ctrl+C to close. ===');
  await new Promise(() => {});
})().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
