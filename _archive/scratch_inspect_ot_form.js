const puppeteer = require('puppeteer');
const fs = require('fs');
const db = require('./database');

function getChromePath() {
  const stdPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const x86Path = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
  if (fs.existsSync(stdPath)) return stdPath;
  if (fs.existsSync(x86Path)) return x86Path;
  return null;
}

async function autoLogin(browser, username, password, portalUrl) {
  const page = await browser.newPage();
  await page.goto(`${portalUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.type('input[type="text"], input[type="email"]', username);
  await page.type('input[type="password"]', password);
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 4000));
  return page;
}

async function inspectForm() {
  const settings = db.getSettings();
  console.log("Launching browser to inspect OT creation form on Taxes...");
  const chromePath = getChromePath();
  const options = { headless: true };
  if (chromePath) options.executablePath = chromePath;
  const browser = await puppeteer.launch(options);
  try {
    const page = await autoLogin(browser, settings.username, settings.password, settings.portalUrl);
    console.log("Logged in. Navigating to /tms/produccion/ot...");
    await page.goto(`${settings.portalUrl}/tms/produccion/ot`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 4000));

    console.log("Clicking 'NUEVO' button...");
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, a')).find(el => el.textContent.trim().toUpperCase() === 'NUEVO' || el.textContent.trim().toUpperCase() === 'NUEVA');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 4000));

    const formData = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label')).map(l => ({
        text: l.textContent.trim(),
        forAttr: l.getAttribute('for'),
        parentHTML: l.parentElement ? l.parentElement.outerHTML.substring(0, 400) : ''
      }));
      const inputs = Array.from(document.querySelectorAll('input, select')).map(i => ({
        name: i.name,
        id: i.id,
        type: i.type,
        className: i.className,
        value: i.value
      }));
      return { labels, inputs };
    });

    console.log("LABELS FOUND IN CREATION FORM:");
    formData.labels.forEach((l, idx) => {
      console.log(`  [${idx}] Label: "${l.text}" | for: "${l.forAttr}"`);
      console.log(`       Parent HTML snippet: ${l.parentHTML}\n`);
    });

    console.log("\nINPUTS FOUND IN CREATION FORM:");
    formData.inputs.forEach((i, idx) => {
      console.log(`  [${idx}] Type: "${i.type}" | Name: "${i.name}" | ID: "${i.id}" | Class: "${i.className}" | Value: "${i.value}"`);
    });

  } catch (e) {
    console.error("Error inspecting form:", e);
  } finally {
    await browser.close();
  }
}

inspectForm();
