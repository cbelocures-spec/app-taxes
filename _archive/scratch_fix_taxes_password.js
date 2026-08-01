const fs = require('fs');
const { Client } = require('ssh2');

const dbFile = './db.json';
if (fs.existsSync(dbFile)) {
  const raw = fs.readFileSync(dbFile, 'utf8');
  const dbData = JSON.parse(raw);

  if (!dbData.settings) dbData.settings = {};
  dbData.settings.username = "paniol@contenedoreshugo.com.ar";
  dbData.settings.password = "Paniol2015";

  fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));
  console.log("✅ Updated password to 'Paniol2015' in db.json!");
}

// Upload to 192.168.50.4 via SSH
const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('./db.json', '/home/cbelocures/data/db.json', (err2) => {
      if (err2) console.error("SFTP upload error:", err2);
      else console.log("✅ Successfully uploaded updated db.json to 192.168.50.4!");

      conn.exec("echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service", (err3, stream) => {
        let out = '';
        stream.on('data', d => out += d);
        stream.on('close', () => {
          console.log("=== APP-TAXES RESTARTED ON 192.168.50.4 ===");
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
