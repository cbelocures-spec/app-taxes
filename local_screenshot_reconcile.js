/**
 * LOCAL SCREENSHOT SCRIPT: Logins, opens the edit form for 25530,
 * takes screenshots, and attempts to find and click the Add Task button.
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
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--window-size=1280,1024'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1024 });

  console.log('Logging in...');
  await page.goto(`${PORTAL_URL}/login`, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(1500);
  
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
  await delay(2500);

  console.log('Typing OT number robustly...');
  const numInputId = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"]')).filter(i => i.offsetParent);
    const inp = inputs[3] || inputs[2];
    if (inp) { inp.id = 'inspect-ot-num'; return inp.id; }
    return null;
  });

  if (numInputId) {
    await page.click(`#${numInputId}`, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.keyboard.type(OT_NUM, { delay: 150 });
    await delay(1000);
    // Tab x3 + Enter
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
      const btn = row.querySelector('.fa-pencil-alt, .fa-edit, .fa-pencil, a[href*="edit"], [class*="pencil"]');
      if (btn) {
        const clickable = btn.closest('a, button') || btn;
        clickable.click();
        return true;
      }
    }
    return false;
  }, OT_NUM);
  console.log(`Pencil clicked: ${pencilClicked}`);
  if (!pencilClicked) {
    console.log('OT row not found!');
    await browser.close();
    return;
  }
  await delay(6000); // Wait for edit form to fully load

  // Take screenshot 1 (Opened Form)
  const sc1Path = path.join(__dirname, 'step1_opened.png');
  await page.screenshot({ path: sc1Path, fullPage: true });
  console.log(`Screenshot 1 saved: ${sc1Path}`);

  // Find and log all buttons in the edit form
  const buttonTexts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, a.btn, .btn')).map(b => b.textContent.trim());
  });
  console.log('Buttons on screen:', buttonTexts);

  // Click Agregar Tarea button using all possible text matches
  console.log('Attempting to click Agregar Tarea button...');
  const clickResult = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a, [role="button"], .btn'));
    const addBtn = btns.find(b => {
      const t = b.textContent.toLowerCase();
      return t.includes('agregar tarea') || t.includes('tarea') || t.includes('agregar') || t === '+';
    });
    if (addBtn) {
      addBtn.scrollIntoView();
      addBtn.click();
      return { found: true, text: addBtn.textContent.trim(), tag: addBtn.tagName.toLowerCase(), class: addBtn.className };
    }
    return { found: false };
  });

  console.log('Click result:', clickResult);
  await delay(4000); // Wait 4 seconds for Vue to update the DOM

  // Take screenshot 2 (After Click)
  const sc2Path = path.join(__dirname, 'step2_clicked.png');
  await page.screenshot({ path: sc2Path, fullPage: true });
  console.log(`Screenshot 2 saved: ${sc2Path}`);

  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
