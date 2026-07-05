const puppeteer = require('puppeteer');

const USERNAME = 'paniol@contenedoreshugo.com.ar';
const PASSWORD = '123';

async function run() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();

  console.log('Logging in...');
  await page.goto('https://taxes.com.ar/login');
  await page.waitForSelector('#email');
  await page.type('#email', USERNAME);
  await page.type('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForNavigation();

  console.log('Navigating to Tasks list page...');
  await page.goto('https://taxes.com.ar/tms/produccion/tareas');
  await page.waitForSelector('input[placeholder*="Buscar por Numero"]');

  console.log('Searching for OT 25534...');
  await page.type('input[placeholder*="Buscar por Numero"]', '25534');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 3000));

  // Get options links
  const options = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    return rows.map(r => {
      const cells = Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim());
      const link = r.querySelector('a, button');
      return {
        cells: cells,
        linkTag: link ? link.tagName : '',
        linkHref: link ? link.getAttribute('href') : ''
      };
    });
  });
  console.log('Rows found:', JSON.stringify(options, null, 2));

  // Click the first eye button
  console.log('Clicking eye button for first row...');
  await page.evaluate(() => {
    const firstRow = document.querySelector('table tbody tr');
    const eyeBtn = firstRow ? firstRow.querySelector('a, button') : null;
    if (eyeBtn) eyeBtn.click();
  });
  await new Promise(r => setTimeout(r, 5000));

  console.log('Current URL after click:', page.url());
  await page.screenshot({ path: 'task_edit_click.png', fullPage: true });

  await browser.close();
}

run().catch(console.error);
