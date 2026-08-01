const { Client } = require('ssh2');

const SERVICE_CONF = `[Unit]
Description=Servidor Express de Gestion de Mantenimiento (Taxes)
After=network.target

[Service]
Type=simple
User=cbelocures
WorkingDirectory=/home/cbelocures/gestion
Environment=PORT=3000
Environment=PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
Environment=DB_PATH=/home/cbelocures/data/db.json
ExecStartPre=-/usr/bin/fuser -k 3000/tcp
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.writeFile('/tmp/app-taxes.service', SERVICE_CONF, (err2) => {
      if (err2) return conn.end();
      conn.exec("echo CesarHernan3550 | sudo -S cp /tmp/app-taxes.service /etc/systemd/system/app-taxes.service && sudo systemctl daemon-reload && sudo fuser -k 3000/tcp || true; sudo systemctl restart app-taxes.service", (err3, stream) => {
        let out = '';
        stream.on('data', d => out += d);
        stream.on('close', () => {
          console.log("=== APP-TAXES SERVICE CLEAN RESTART WITH PRE-CLEANUP ===");
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
