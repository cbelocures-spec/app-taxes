const fs = require('fs');
const { Client } = require('ssh2');

const dbFile = './db.json';
if (fs.existsSync(dbFile)) {
  const raw = fs.readFileSync(dbFile, 'utf8');
  const dbData = JSON.parse(raw);
  
  let resetCount = 0;
  (dbData.workOrders || []).forEach(o => {
    if (!o.archived && !o.deleted && o.syncStatus === 'error') {
      o.syncStatus = 'pending';
      o.syncError = null;
      resetCount++;
    }
  });

  fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));
  console.log(`✅ Reset ${resetCount} failed active orders to 'pending' for auto-retry!`);
}

// Upload to 192.168.50.4 via SSH
const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('./db.json', '/home/cbelocures/data/db.json', (err1) => {
      sftp.fastPut('./auditor_externo/app_client.py', '/home/cbelocures/gestion/auditor_externo/app_client.py', (err2) => {
        console.log("✅ Uploaded updated db.json and app_client.py to 192.168.50.4!");
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
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
});
