const fs = require('fs');
const { Client } = require('ssh2');

const dbFile = './db.json';
if (fs.existsSync(dbFile)) {
  const dbData = JSON.parse(fs.readFileSync(dbFile, 'utf8'));

  // 1. Order 155 (OT 26926)
  const o155 = (dbData.workOrders || []).find(o => String(o.interno) === '155' || o.taxesOrderNumber === '26926');
  if (o155 && o155.tasks) {
    const targetDescs = [
      'desarme rueda derecha trasera revision rulemanes campana y cinta',
      'pintar pisos con antioxidaaantes',
      'termina de pisos revision puertas y cabina'
    ];

    o155.tasks.forEach(t => {
      const descNorm = String(t.descripcion || '').toLowerCase().trim();
      const match = targetDescs.some(d => descNorm.includes(d.toLowerCase().trim()) || d.toLowerCase().trim().includes(descNorm));
      if (match) {
        t.status = 'Pendiente';
        t.timerStart = null;
        t.timerStarted = false;
        console.log(`✅ Set 155 task to Pendiente: "${t.descripcion}" (${t.empleado})`);
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
    const targetDescs = [
      'armado motor y todo el pereferico'
    ];

    o119.tasks.forEach(t => {
      const descNorm = String(t.descripcion || '').toLowerCase().trim();
      const match = targetDescs.some(d => descNorm.includes(d.toLowerCase().trim()));
      if (match) {
        t.status = 'Pendiente';
        t.timerStart = null;
        t.timerStarted = false;
        console.log(`✅ Set 119 task to Pendiente: "${t.descripcion}" (${t.empleado})`);
      } else {
        t.status = 'Finalizada';
        t.timerStart = null;
        t.timerStarted = false;
      }
    });
  }

  fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));
  console.log("✅ Updated db.json with exact 5 user tasks!");
}

// Upload to 192.168.50.4
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
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550',
  readyTimeout: 30000
});
