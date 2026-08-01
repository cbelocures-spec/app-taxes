const { Client } = require('ssh2');

const TEST_SCRIPT = `
const puppeteer = require('puppeteer');

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

    const content = await page.content();
    console.log("Form HTML snippet:", content.substring(0, 1000));
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
    sftp.writeFile('/tmp/test_debug.js', TEST_SCRIPT, (err2) => {
      if (err2) return conn.end();
      conn.exec("cd /home/cbelocures/gestion && node /tmp/test_debug.js 2>&1", (err3, stream) => {
        let out = '';
        stream.on('data', d => out += d);
        stream.on('close', () => {
          console.log("=== TAXES LOGIN DEBUG OUTPUT ===");
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
