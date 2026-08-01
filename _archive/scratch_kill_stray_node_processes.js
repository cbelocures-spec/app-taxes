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
  console.log("=== KILLING STRAY HIGH-CPU NODE PROCESS 2146287 ===");
  const killRes = await runCmd(conn, 'kill -9 2146287 || true');
  console.log("Kill 2146287:", killRes);

  const killAllStray = await runCmd(conn, 'pkill -9 -f "/usr/bin/node server.js" || true');
  console.log("pkill /usr/bin/node server.js:", killAllStray);

  console.log("\n=== RESTARTING APP-TAXES SERVICE ===");
  const restartRes = await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
  console.log("Service restart:", restartRes);

  const psCheck = await runCmd(conn, 'ps aux | grep node || true');
  console.log("\n--- Active Node Processes Now ---\n" + psCheck);

  const netstatCheck = await runCmd(conn, 'ss -tulpn | grep 3000 || true');
  console.log("\n--- Port 3000 Listener Now ---\n" + netstatCheck);

  conn.end();
}).connect(DEBIAN_CONFIG);
