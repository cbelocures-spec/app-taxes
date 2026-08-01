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
  console.log("=== CHECKING SYSTEMD SERVICE FILE CONTENTS ===");
  const serviceContent = await runCmd(conn, 'cat /etc/systemd/system/app-taxes.service');
  console.log(serviceContent);

  console.log("\n=== UPDATING SYSTEMD SERVICE TO RUN EXACTLY IN /home/cbelocures/gestion ===");
  const newServiceContent = `[Unit]
Description=App Taxes Node.js Server
After=network.target

[Service]
Type=simple
User=cbelocures
WorkingDirectory=/home/cbelocures/gestion
ExecStart=/usr/bin/node /home/cbelocures/gestion/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
`;

  await runCmd(conn, `echo '${newServiceContent}' | sudo -S tee /etc/systemd/system/app-taxes.service`);
  await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl daemon-reload');
  await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');

  console.log("\n=== VERIFYING RUNNING NODE PROCESS NOW ===");
  const psCheck = await runCmd(conn, 'ps aux | grep node || true');
  console.log(psCheck);

  conn.end();
}).connect(DEBIAN_CONFIG);
