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
  console.log("=== DIAGNOSING 502 BAD GATEWAY ===");
  const status = await runCmd(conn, 'systemctl status app-taxes.service || true');
  console.log("--- Systemctl Status ---\n" + status);

  const logs = await runCmd(conn, 'journalctl -u app-taxes.service -n 50 --no-pager || true');
  console.log("\n--- Crash Logs ---\n" + logs);

  console.log("\n=== RESTARTING SERVICE ===");
  const restart = await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
  console.log("Restart:", restart);

  const netstat = await runCmd(conn, 'ss -tulpn | grep 3000 || true');
  console.log("\n--- Listener on Port 3000 ---\n" + netstat);

  conn.end();
}).connect(DEBIAN_CONFIG);
