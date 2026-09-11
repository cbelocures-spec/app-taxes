const fs = require('fs');
const puppeteer = require('puppeteer');

// Renders a self-contained HTML report (built client-side from the currently-displayed Parte
// Taller state) into a PDF via a short-lived headless Chromium instance. Moved out of
// server.js as-is (same logic, same launch options) so it can run inside the sync child
// process (syncChildEntry.js) instead of the main server - it's a second, independent
// Chromium instance that used to block the main process just like syncWorker's own browser.
async function generarPdfParteTaller(html) {
  if (!html) {
    throw new Error("Falta el HTML del reporte.");
  }

  let browser = null;
  try {
    let execPath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
    if (!execPath) {
      if (process.platform === 'win32') {
        const stdPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        const x86Path = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
        if (fs.existsSync(stdPath)) execPath = stdPath;
        else if (fs.existsSync(x86Path)) execPath = x86Path;
      } else {
        const linuxPaths = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
        execPath = linuxPaths.find(p => fs.existsSync(p)) || null;
      }
    }

    browser = await puppeteer.launch({
      executablePath: execPath || undefined,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true,
      margin: { top: '15px', bottom: '15px', left: '15px', right: '15px' }
    });
    return pdfBuffer;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { generarPdfParteTaller };
