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
  console.log("=== INSPECTING RUNNING PROCESS CWD AND SERVICE DEFINITIONS ===");
  const procCwd = await runCmd(conn, 'ls -la /proc/2136503/cwd /proc/2137069/cwd || true');
  console.log("\n--- Proc CWD ---\n" + procCwd);

  const allServices = await runCmd(conn, 'ls -la /etc/systemd/system/*.service || true');
  console.log("\n--- systemd services ---\n" + allServices);

  const ports = await runCmd(conn, 'ss -tulpn | grep node || netstat -tulpn | grep node || true');
  console.log("\n--- Node listening ports ---\n" + ports);

  const apacheConf = await runCmd(conn, 'cat /etc/apache2/sites-enabled/* || true');
  console.log("\n--- Apache site configs ---\n" + apacheConf);

  conn.end();
}).connect(DEBIAN_CONFIG);
