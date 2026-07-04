/**
 * TEST SCRIPT v2: Correctly waits for "En Proceso" tab to load the OT list
 * Run: node test_ot_search.js
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

  // ── LOGIN ──
  console.log('Logging in...');
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

  // Print all tabs found
  const tabInfo = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('a.nav-link, li.nav-item a, [role="tab"], .nav-tabs a, .nav a'));
    return tabs.map(t => ({ text: t.textContent.trim(), class: t.className, href: t.href }));
  });
  console.log('Tabs found:', JSON.stringify(tabInfo, null, 2));

  // ── CLICK "EN PROCESO" TAB PROPERLY ──
  console.log('\nClicking En Proceso tab...');
  const tabClicked = await page.evaluate(() => {
    // Try nav-link tabs first
    const navLinks = Array.from(document.querySelectorAll('a.nav-link, [role="tab"], .nav-tabs li a, .nav li a'));
    const tab = navLinks.find(t => t.textContent.trim().toLowerCase().includes('en proceso'));
    if (tab) { tab.click(); return tab.textContent.trim(); }
    // Fallback: any clickable with "proceso"
    const all = Array.from(document.querySelectorAll('a, button, li'));
    const fb  = all.find(t => t.textContent.trim().toLowerCase() === 'en proceso');
    if (fb) { fb.click(); return fb.textContent.trim(); }
    return null;
  });
  console.log('Tab clicked:', tabClicked);
  await delay(3000);

  // Print what's now on the page (check if filter form appeared)
  const pageState = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent).map((i, idx) => ({
      idx, id: i.id, name: i.name, type: i.type, placeholder: i.placeholder, value: i.value
    }));
    const selects = Array.from(document.querySelectorAll('select')).filter(s => s.offsetParent).map((s, idx) => ({
      idx, id: s.id, name: s.name, options: Array.from(s.options).slice(0,3).map(o => o.text)
    }));
    const buttons = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent).map(b => b.textContent.trim()).filter(Boolean);
    const tables  = Array.from(document.querySelectorAll('table')).length;
    const tableRows = Array.from(document.querySelectorAll('table tbody tr')).length;
    return { inputs, selects, buttons, tables, tableRows };
  });
  console.log('\nPage state after tab click:');
  console.log('  Inputs:', JSON.stringify(pageState.inputs));
  console.log('  Selects:', JSON.stringify(pageState.selects));
  console.log('  Buttons:', pageState.buttons.join(', '));
  console.log('  Tables:', pageState.tables, 'rows:', pageState.tableRows);

  // ── FIND THE NUMERO FILTER INPUT ──
  // The OT list filter has: Clasificacion(select) | Fecha Desde | Fecha Hasta | Cliente | NUMERO | Responsable | Limite
  // "Numero" is the 5th visible input (index 4, 0-based) in the filter form
  console.log('\nFinding Numero filter input by label...');
  const numId = await page.evaluate(() => {
    const normalizeText = s => (s || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    // Look for exact "Numero" label
    const allEls = Array.from(document.querySelectorAll('label, span, small, p, .col > div'));
    for (const el of allEls) {
      const t = normalizeText(el.textContent);
      if (t === 'numero') {
        // Find nearest input
        const container = el.closest('.form-group, .col, [class*="col"]') || el.parentElement?.parentElement;
        const inp = container?.querySelector('input');
        if (inp) {
          if (!inp.id) inp.id = 'test-numero-v2';
          console.log('Found by label "numero" | container:', container?.className);
          return inp.id;
        }
      }
    }
    // Fallback: list all visible inputs and their parent labels
    const vis = Array.from(document.querySelectorAll('input[type="text"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')).filter(i => i.offsetParent);
    vis.forEach((inp, i) => {
      const par = inp.closest('.form-group, .col, [class*="col"]');
      const labelText = par?.querySelector('label, span, small')?.textContent.trim() || '(no label)';
      console.log(`  visible input [${i}]: id=${inp.id} placeholder=${inp.placeholder} label="${labelText}"`);
    });
    // The "Numero" filter is typically the one after "Cliente/Proveedor"
    // Look for the input whose container label includes "numero"
    for (const inp of vis) {
      const par = inp.closest('.form-group, .col, [class*="col"]');
      if (par && normalizeText(par.textContent).includes('numero')) {
        if (!inp.id) inp.id = 'test-numero-v2-fb';
        return inp.id;
      }
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
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent);
    const btn = btns.find(b => b.textContent.toLowerCase().includes('buscar'));
    console.log('BUSCAR button found:', !!btn, btn?.textContent.trim());
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

  console.log('\n=== Browser stays open. Press Ctrl+C to close. ===');
  await new Promise(() => {});
})().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
