const fs = require('fs');
const { Client } = require('ssh2');

const dbFile = './db.json';
if (fs.existsSync(dbFile)) {
  const dbData = JSON.parse(fs.readFileSync(dbFile, 'utf8'));

  // 1. Order 155 (OT 26926)
  const o155 = (dbData.workOrders || []).find(o => String(o.interno) === '155' || o.taxesOrderNumber === '26926');
  if (o155 && o155.tasks) {
    // Reset all tasks to Finalizada except the last 3
    o155.tasks.forEach((t, idx) => {
      if (idx >= o155.tasks.length - 3) {
        t.status = 'Pendiente';
        t.timerStart = null;
        t.timerStarted = false;
      } else {
        t.status = 'Finalizada';
        t.timerStart = null;
        t.timerStarted = false;
      }
    });
  }

  // 2. Order 119 (OT 27889)
  const o119 = (dbData.workOrders || []).find(o => String(o.interno) === '119' || o.taxesOrderNumber === '27889');
  if (o119 && o119.tasks) {
    o119.tasks.forEach((t, idx) => {
      if (idx < 2) {
        t.status = 'Pendiente';
        t.timerStart = null;
        t.timerStarted = false;
      } else {
        t.status = 'Finalizada';
        t.timerStart = null;
        t.timerStarted = false;
      }
    });
  }

  fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));
  console.log("✅ Set exact 5 active tasks (3 for Interno 155, 2 for Interno 119) in db.json!");
}

// Upload to 192.168.50.4 via SSH
const conn = new Client();
conn.on('ready', () => {
  console.log("✅ SSH Connected to 192.168.50.4!");
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('./db.json', '/home/cbelocures/data/db.json', (err1) => {
      console.log("✅ Uploaded db.json to 192.168.50.4!");
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
}).on('error', (err) => {
  console.error("SSH error:", err.message);
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550',
  readyTimeout: 30000
});
