const { Client } = require('ssh2');

const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550',
  readyTimeout: 10000
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
conn.on('error', (err) => console.error("SSH Error:", err.message));
conn.on('ready', async () => {
  console.log("=== PULLING GITHUB MASTER ON DEBIAN ===");
  const gitPull = await runCmd(conn, 'cd /home/cbelocures/gestion && git checkout -- . && git pull origin master || true');
  console.log("Git Pull Output:\n" + gitPull);

  await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
  console.log("✅ app-taxes.service restarted on Debian!");

  conn.end();
}).connect(DEBIAN_CONFIG);
