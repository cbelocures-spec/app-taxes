/**
 * TEST SCRIPT: Opens the edit form for OT 25530, takes a full-page screenshot
 * and logs all available buttons and inputs on the page to analyze how to add tasks.
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const PORTAL_URL = 'https://taxes.com.ar';
const USERNAME   = 'paniol@contenedoreshugo.com.ar';
const PASSWORD   = 'Paniol2015';
const OT_NUM     = '25530';

const delay = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--start-maximized'],
    defaultViewport: null,
  });
  const page = await browser.newPage();

  console.log('Logging in...');
  await page.goto(`${PORTAL_URL}/login`, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  
  const userInput = await page.$('input[type="email"], input[name="email"]');
  if (userInput) { await userInput.click({ clickCount: 3 }); await userInput.type(USERNAME); }
  const passInput = await page.$('input[type="password"]');
  if (passInput) { await passInput.click({ clickCount: 3 }); await passInput.type(PASSWORD); }
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.type === 'submit' || b.textContent.toLowerCase().includes('ingresar'));
    if (btn) btn.click();
  });
  await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
  await delay(2000);

  console.log('Navigating to OTs page...');
  await page.goto(`${PORTAL_URL}/tms/produccion/ot`, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  console.log('Clicking En Proceso tab...');
  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a.nav-link, [role="tab"], .nav-tabs li a'));
    const t = links.find(l => l.textContent.trim().toLowerCase().includes('en proceso'));
    if (t) t.click();
  });
  await delay(2000);

  console.log('Typing OT number...');
  const numInputId = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"]')).filter(i => i.offsetParent);
    const inp = inputs[3] || inputs[2];
    if (inp) { inp.id = 'debug-ot-num'; return inp.id; }
    return null;
  });

  if (numInputId) {
    await page.click(`#${numInputId}`, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.keyboard.type(OT_NUM);
    await delay(500);
    // Use the Tab x3 + Enter method
    await page.keyboard.press('Tab'); await delay(200);
    await page.keyboard.press('Tab'); await delay(200);
    await page.keyboard.press('Tab'); await delay(200);
    await page.keyboard.press('Enter');
    await delay(3000);
  }

  console.log('Clicking edit pencil...');
  const pencilClicked = await page.evaluate((otNum) => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const row = rows.find(r => r.textContent.includes(otNum));
    if (row) {
      const pencil = row.querySelector('.fa-pencil-alt, .fa-edit, .fa-pencil, a[href*="edit"], [class*="pencil"]');
      if (pencil) {
        pencil.click();
        return true;
      }
      // Try clicking any action link inside the row
      const links = Array.from(row.querySelectorAll('a, button'));
      if (links[1]) { links[1].click(); return true; }
    }
    return false;
  }, OT_NUM);
  console.log(`Pencil clicked: ${pencilClicked}`);
  await delay(5000);

  console.log('Saving full page screenshot...');
  const destPath = path.join(__dirname, 'full_edit_page_debug.png');
  await page.screenshot({ path: destPath, fullPage: true });
  console.log(`Screenshot saved to: ${destPath}`);

  console.log('Analyzing elements in the edit form...');
  const analysis = await page.evaluate(() => {
    const getSelectorInfo = (el) => {
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id,
        name: el.name || el.getAttribute('name') || '',
        class: el.className,
        text: el.textContent.trim().substring(0, 50),
        value: el.value || ''
      };
    };

    const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map(getSelectorInfo);
    const buttons = Array.from(document.querySelectorAll('button, a.btn, [role="button"]')).map(getSelectorInfo);
    
    // Check if there is any button to add tasks
    const addButtons = buttons.filter(b => 
      b.text.toLowerCase().includes('tarea') || 
      b.text.toLowerCase().includes('agregar') || 
      b.text.toLowerCase().includes('nuevo') || 
      b.text.includes('+')
    );

    // Look for sections/headers
    const headers = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, .card-header')).map(h => h.textContent.trim());

    return {
      inputsCount: inputs.length,
      buttonsCount: buttons.length,
      addButtons: addButtons,
      headers: headers,
      first15Inputs: inputs.slice(0, 15),
      first15Buttons: buttons.slice(0, 15)
    };
  });

  console.log('\n--- Analysis Results ---');
  console.log(JSON.stringify(analysis, null, 2));
  console.log('------------------------');

  console.log('Browser will close in 5 seconds.');
  await delay(5000);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
