const { Client } = require('ssh2');

const TEST_SCRIPT = `
const puppeteer = require('puppeteer');

async function testTaxesLogin() {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    const passwordsToTest = ['Paniol2015', 'paniol2015', 'Paniol2024', 'Paniol2025', 'Paniol2026', '123456', 'Paniol123'];

    for (const pass of passwordsToTest) {
      console.log('Testing password:', pass);
      await page.goto('https://taxes.com.ar', { waitUntil: 'networkidle2', timeout: 30000 });

      const userInputs = await page.$$('input[type="text"], input[name="username"], input[name="user"]');
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
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
  }
}

testTaxesLogin();
`;

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.writeFile('/tmp/test_login.js', TEST_SCRIPT, (err2) => {
      if (err2) return conn.end();
      conn.exec("cd /home/cbelocures/gestion && node /tmp/test_login.js", (err3, stream) => {
        let out = '';
        stream.on('data', d => out += d);
        stream.on('close', () => {
          console.log("=== TAXES LOGIN TEST ON DEBIAN ===");
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
