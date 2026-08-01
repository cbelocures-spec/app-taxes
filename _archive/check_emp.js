const puppeteer = require('puppeteer');
const db = require('./database');
const fs = require('fs');

async function checkEmp() {
  const settings = db.getSettings();
  console.log("=== DEBUGGING EMPLOYEE DROPDOWN WITH SCREENSHOTS ===");

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });

    // Login
    await page.goto(`${settings.portalUrl}/admin`, { waitUntil: 'networkidle2' });
    const isLoggedIn = await page.evaluate(() => {
      return document.body.textContent.includes('Inicio') || document.querySelector('.profile-user') !== null;
    });

    if (!isLoggedIn) {
      const inputs = await page.$$('input');
      for (const input of inputs) {
        const type = await page.evaluate(el => el.type, input);
        const name = await page.evaluate(el => el.name || '', input);
        if (type === 'text' || type === 'email' || name.includes('email') || name.includes('user')) {
          await input.type(settings.username);
        } else if (type === 'password' || name.includes('pass')) {
          await input.type(settings.password);
        }
      }
      await page.keyboard.press('Enter');
      await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
      await new Promise(res => setTimeout(res, 3000));
    }
    console.log("Login OK");

    // Go to OT list and click NUEVO
    await page.goto(`${settings.portalUrl}/tms/produccion/ot`, { waitUntil: 'networkidle2' });
    await new Promise(res => setTimeout(res, 3000));
    
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const nuevo = buttons.find(b => b.textContent.trim().toUpperCase().includes('NUEVO'));
      if (nuevo) nuevo.click();
    });
    await new Promise(res => setTimeout(res, 3000));
    console.log("Form opened");

    // Click AGREGAR TAREA
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const addBtn = buttons.find(b => b.textContent.includes('AGREGAR TAREA') || b.textContent.includes('Agregar Tarea'));
      if (addBtn) addBtn.click();
    });
    await new Promise(res => setTimeout(res, 2000));

    // Get input selectors
    const searchSelector = await page.evaluate(() => {
      const hiddenInput = document.querySelector('input[name="syj_empleado_id_tarea_0"]');
      if (hiddenInput) {
        const parent = hiddenInput.closest('.searchable-select-wrapper') || hiddenInput.parentElement;
        const searchInput = parent.querySelector('.searchable-input');
        if (searchInput) {
          searchInput.setAttribute('id', 'test_emp_search_0');
          return '#test_emp_search_0';
        }
      }
      return null;
    });

    if (!searchSelector) {
      console.log("Could not find employee search selector!");
      return;
    }

    // 1. Select Centro de Costo = CHOFERES (value is "4")
    console.log("\nSelecting CC = CHOFERES (value='4')...");
    await page.evaluate(() => {
      const ccSelect = document.getElementById('centro_costo_0') || document.querySelector('select[name="syj_centro_costo_id_0"]');
      if (ccSelect) {
        ccSelect.value = "4";
        ccSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    console.log("Waiting 4 seconds for AJAX/Vue update...");
    await new Promise(res => setTimeout(res, 4000));

    // Type "BRAHIM" and see what shows up
    console.log("Focusing and typing 'BRAHIM' under CC=CHOFERES...");
    await page.click(searchSelector);
    await new Promise(res => setTimeout(res, 500));
    await page.type(searchSelector, "BRAHIM", { delay: 100 });
    await new Promise(res => setTimeout(res, 2000));

    // Take screenshot of opened dropdown
    await page.screenshot({ path: 'debug_emp_cc4.png' });
    console.log("Saved screenshot: debug_emp_cc4.png");

    // Let's get the list of divs in body to see if any dropdowns are open
    const bodyDivs = await page.evaluate(() => {
      const allDivs = Array.from(document.querySelectorAll('div'));
      return allDivs
        .filter(d => d.className && typeof d.className === 'string' && (d.className.includes('dropdown') || d.className.includes('searchable') || d.id.includes('searchable')))
        .map(d => ({
          id: d.id,
          className: d.className,
          offsetHeight: d.offsetHeight,
          text: d.textContent.trim().substring(0, 100)
        })).filter(d => d.offsetHeight > 0);
    });
    console.log("Visible dropdown/searchable elements under CC=CHOFERES:", bodyDivs);


    // Clear input
    await page.click(searchSelector);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.evaluate(() => {
      const label = document.querySelector('label');
      if (label) label.click();
    });
    await new Promise(res => setTimeout(res, 1000));


    // 2. Select Centro de Costo = MECANICA (value is "15")
    console.log("\nSelecting CC = MECANICA (value='15')...");
    await page.evaluate(() => {
      const ccSelect = document.getElementById('centro_costo_0') || document.querySelector('select[name="syj_centro_costo_id_0"]');
      if (ccSelect) {
        ccSelect.value = "15";
        ccSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    console.log("Waiting 4 seconds for AJAX/Vue update...");
    await new Promise(res => setTimeout(res, 4000));

    // Type "BRAHIM"
    console.log("Focusing and typing 'BRAHIM' under CC=MECANICA...");
    await page.click(searchSelector);
    await new Promise(res => setTimeout(res, 500));
    await page.type(searchSelector, "BRAHIM", { delay: 100 });
    await new Promise(res => setTimeout(res, 2000));

    // Take screenshot of opened dropdown
    await page.screenshot({ path: 'debug_emp_cc15.png' });
    console.log("Saved screenshot: debug_emp_cc15.png");

    const bodyDivs15 = await page.evaluate(() => {
      const allDivs = Array.from(document.querySelectorAll('div'));
      return allDivs
        .filter(d => d.className && typeof d.className === 'string' && (d.className.includes('dropdown') || d.className.includes('searchable') || d.id.includes('searchable')))
        .map(d => ({
          id: d.id,
          className: d.className,
          offsetHeight: d.offsetHeight,
          text: d.textContent.trim().substring(0, 100)
        })).filter(d => d.offsetHeight > 0);
    });
    console.log("Visible dropdown/searchable elements under CC=MECANICA:", bodyDivs15);

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await browser.close();
  }
}

checkEmp();
