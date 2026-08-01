const puppeteer = require('puppeteer');
const fs = require('fs');

const dbPath = 'c:\\Users\\admin\\.gemini\\antigravity\\scratch\\app_taxes\\db.json';
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const settings = db.settings;

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Login
    await page.goto(settings.portalUrl + '/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
    await page.type('input[type="email"]', settings.username, { delay: 60 });
    await page.type('input[type="password"]', settings.password, { delay: 60 });
    await Promise.all([
      page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.type === 'submit' || b.textContent.toLowerCase().includes('ingresar'));
        if (btn) btn.click();
      }),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
    ]);
    
    // Navigate directly to Tareas
    await page.goto(`${settings.portalUrl}/tms/produccion/tareas`, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('label', { timeout: 15000 });
    
    // Inspect all buttons
    const buttonsInfo = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a, input[type="button"]'));
      return btns.map((b, i) => ({
        index: i,
        tagName: b.tagName,
        type: b.type,
        id: b.id,
        className: b.className,
        text: b.textContent.trim(),
        value: b.value,
        title: b.title,
        hasClickAttr: !!b.onclick,
        parentClass: b.parentElement?.className || ''
      }));
    });
    console.log('All buttons found on tasks page:');
    console.log(JSON.stringify(buttonsInfo, null, 2));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
  }
})();
