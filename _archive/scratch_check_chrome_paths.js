const { Client } = require('ssh2');

const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

function runCmd(conn, cmd) {
  return new Promise((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return resolve("Error: " + err.message);
      let out = '';
      stream.on('close', () => resolve(out)).on('data', d => out += d);
    });
  });
}

const conn = new Client();
conn.on('ready', async () => {
  const chromePath = await runCmd(conn, 'which google-chrome google-chrome-stable chromium chromium-browser node || true');
  console.log("--- Chrome Paths on Debian ---\n" + chromePath);
  
  const testLaunch = await runCmd(conn, 'node -e "const p = require(\'puppeteer\'); p.launch({args: [\'--no-sandbox\']}).then(b => { console.log(\'Browser launched ok!\'); b.close(); }).catch(e => console.error(\'Launch error:\', e.message));"');
  console.log("\n--- Puppeteer Launch Test ---\n" + testLaunch);

  conn.end();
}).connect(DEBIAN_CONFIG);
