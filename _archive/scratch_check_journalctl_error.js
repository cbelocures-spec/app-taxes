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
  const logs = await runCmd(conn, 'journalctl -u app-taxes.service -n 30 --no-pager || true');
  console.log("--- Journalctl Logs ---\n" + logs);
  conn.end();
}).connect(DEBIAN_CONFIG);
