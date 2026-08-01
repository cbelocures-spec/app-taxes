const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log("✅ SSH Connected to 192.168.50.4!");
  conn.exec("cd /home/cbelocures/gestion && git fetch origin && git reset --hard origin/master && echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== FORCE GIT RESET & RESTART OUTPUT ===");
      console.log(out);
      conn.end();
    });
  });
}).on('error', (err) => {
  console.error("SSH error:", err.message);
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550',
  readyTimeout: 30000
});
