const fs = require('fs');
const { Client } = require('ssh2');

const dbFile = './db.json';
if (fs.existsSync(dbFile)) {
  const dbData = JSON.parse(fs.readFileSync(dbFile, 'utf8'));

  // 1. Order 155 (OT 26926)
  const o155 = (dbData.workOrders || []).find(o => String(o.interno) === '155' || o.taxesOrderNumber === '26926');
  if (o155 && o155.tasks && o155.tasks.length >= 3) {
    const len = o155.tasks.length;
    // Set last 3 tasks to Pendiente
    o155.tasks[len - 3].status = 'Pendiente';
    o155.tasks[len - 3].timerStart = null;
    o155.tasks[len - 3].timerStarted = false;

    o155.tasks[len - 2].status = 'Pendiente';
    o155.tasks[len - 2].timerStart = null;
    o155.tasks[len - 2].timerStarted = false;

    o155.tasks[len - 1].status = 'Pendiente';
    o155.tasks[len - 1].timerStart = null;
    o155.tasks[len - 1].timerStarted = false;
    console.log("✅ Set 3 tasks of Interno 155 to 'Pendiente'!");
  }

  // 2. Order 119 (OT 27889)
  const o119 = (dbData.workOrders || []).find(o => String(o.interno) === '119' || o.taxesOrderNumber === '27889');
  if (o119 && o119.tasks && o119.tasks.length >= 2) {
    o119.tasks[0].status = 'Pendiente';
    o119.tasks[0].timerStart = null;
    o119.tasks[0].timerStarted = false;

    o119.tasks[1].status = 'Pendiente';
    o119.tasks[1].timerStart = null;
    o119.tasks[1].timerStarted = false;
    console.log("✅ Set 2 tasks of Interno 119 to 'Pendiente'!");
  }

  fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));
}

// Upload to 192.168.50.4
const conn = new Client();
conn.on('ready', () => {
  console.log("✅ SSH Connected to 192.168.50.4!");
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('./db.json', '/home/cbelocures/data/db.json', (err1) => {
      console.log("✅ Uploaded fixed db.json to 192.168.50.4!");
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
