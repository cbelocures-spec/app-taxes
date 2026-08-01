/**
 * SCRIPT: Abre Chrome en primer plano con la cuenta de Pañol y se queda abierto
 * para que el usuario pueda ver el estado real de la página de Taxes.
 */
const puppeteer = require('puppeteer');

const PORTAL_URL = 'https://taxes.com.ar';
const USERNAME   = 'paniol@contenedoreshugo.com.ar';
const PASSWORD   = 'Paniol2015';

const delay = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('Iniciando Chrome en primer plano en tu pantalla...');
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--start-maximized'],
    defaultViewport: null,
  });
  
  const page = await browser.newPage();
  
  console.log(`Ingresando a Taxes con el usuario ${USERNAME}...`);
  await page.goto(`${PORTAL_URL}/login`, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  
  const userInput = await page.$('input[type="email"], input[name="email"]');
  if (userInput) {
    await userInput.click({ clickCount: 3 });
    await userInput.type(USERNAME, { delay: 60 });
  }
  
  const passInput = await page.$('input[type="password"]');
  if (passInput) {
    await passInput.click({ clickCount: 3 });
    await passInput.type(PASSWORD, { delay: 60 });
  }
  
  // Click login
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.type === 'submit' || b.textContent.toLowerCase().includes('ingresar'));
    if (btn) btn.click();
  });
  
  await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
  await delay(2000);
  
  console.log('Navegando a la sección de Órdenes de Trabajo...');
  await page.goto(`${PORTAL_URL}/tms/produccion/ot`, { waitUntil: 'networkidle2', timeout: 30000 });
  
  console.log('El navegador ya está abierto en tu pantalla. Puedes revisarlo ahora.');
  console.log('Manteniendo la sesión abierta. Presiona Ctrl+C en esta consola cuando termines.');
  
  // Keep it open
  await new Promise(() => {});
})().catch(e => {
  console.error('Error al abrir el navegador:', e.message);
});
