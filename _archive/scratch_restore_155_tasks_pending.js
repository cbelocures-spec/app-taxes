const fs = require('fs');
const { Client } = require('ssh2');

const dbFile = './db.json';
if (fs.existsSync(dbFile)) {
  const dbData = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const order155 = (dbData.workOrders || []).find(o => String(o.interno) === '155' || o.taxesOrderNumber === '26926');
  if (order155 && order155.tasks) {
    // Set the last 3 tasks to Pendiente
    const len = order155.tasks.length;
    for (let i = Math.max(0, len - 3); i < len; i++) {
      order155.tasks[i].status = 'Pendiente';
      order155.tasks[i].timerStart = null;
    }
    fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));
    console.log("✅ Updated 155 tasks back to 'Pendiente' in local db.json!");
  }
}

// Upload to 192.168.50.4
const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('./db.json', '/home/cbelocures/data/db.json', (err1) => {
      console.log("✅ Uploaded updated db.json to 192.168.50.4!");
      conn.exec("echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service", (err2, stream) => {
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
  password: 'CesarHernan3550',
  readyTimeout: 30000
});
