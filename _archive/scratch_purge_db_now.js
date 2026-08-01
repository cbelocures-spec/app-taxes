const fs = require('fs');
const { Client } = require('ssh2');

const dbFile = './db.json';
if (fs.existsSync(dbFile)) {
  const raw = fs.readFileSync(dbFile, 'utf8');
  const dbData = JSON.parse(raw);
  const activeToKeep = (dbData.workOrders || []).filter(o => !o.archived && !o.deleted);

  // Backup original db.json
  fs.writeFileSync(`./db_backup_purged_now.json`, raw);

  // Set active orders only
  dbData.workOrders = activeToKeep;
  fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));

  console.log(`✅ LOCAL db.json PURGED! Kept ${activeToKeep.length} active orders.`);
}

// Upload clean db.json to Debian 192.168.50.4 and restart service
const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('./db.json', '/home/cbelocures/data/db.json', (err2) => {
      if (err2) console.error("SFTP upload error:", err2);
      else console.log("✅ Successfully uploaded purged db.json to 192.168.50.4!");

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
