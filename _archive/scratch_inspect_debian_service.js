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
  console.log("=== INSPECTING DEBIAN SERVICE & PATHS ===");
  const serviceFile = await runCmd(conn, 'cat /etc/systemd/system/app-taxes.service || cat /lib/systemd/system/app-taxes.service || true');
  console.log("\n--- systemd service file ---\n" + serviceFile);

  const status = await runCmd(conn, 'systemctl status app-taxes.service || true');
  console.log("\n--- service status ---\n" + status);

  const ps = await runCmd(conn, 'ps aux | grep node || true');
  console.log("\n--- running node processes ---\n" + ps);

  const lsGestion = await runCmd(conn, 'ls -la /home/cbelocures/gestion/ || true');
  console.log("\n--- /home/cbelocures/gestion/ ---\n" + lsGestion);

  const headAppJs = await runCmd(conn, 'grep -n "x-user-username" /home/cbelocures/gestion/public/app.js | head -n 10 || true');
  console.log("\n--- grep x-user-username in /home/cbelocures/gestion/public/app.js ---\n" + headAppJs);

  conn.end();
}).connect(DEBIAN_CONFIG);
