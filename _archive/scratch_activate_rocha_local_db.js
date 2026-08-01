const fs = require('fs');
const { Client } = require('ssh2');

const dbPath = 'db.json';
const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const orders = dbData.workOrders || dbData.orders || [];

const now = Date.now();
let rochaActivated = false;

orders.forEach(order => {
  if (!order.tasks || !Array.isArray(order.tasks)) return;

  order.tasks = order.tasks.map(task => {
    if (!task) return task;

    const emp = String(task.empleado || '');
    const desc = String(task.descripcion || '').toLowerCase();

    // Rocha task on Int 155 (OT 26926)
    if ((emp === '365' || emp.toLowerCase().includes('rocha')) && desc.includes('pisos cabina')) {
      rochaActivated = true;
      console.log(`⚡ ACTIVATING ROCHA TASK: OT ${order.taxesOrderNumber || order.id} | Int ${order.interno} | Mech ${task.empleado} | ${task.descripcion}`);
      return {
        ...task,
        status: 'Pendiente',
        timerStart: now - (1800 * 1000), // 30 min running
        timerStarted: true,
        timerHistory: [
          { type: 'Inició', formatted: '07:00', timestamp: now - (1800 * 1000) }
        ]
      };
    } else {
      if (task.status !== 'Finalizada') {
        console.log(`🧹 FINALIZING EXTRA TASK: OT ${order.taxesOrderNumber || order.id} | Int ${order.interno} | Mech ${task.empleado} | ${task.descripcion}`);
      }
      return {
        ...task,
        status: 'Finalizada',
        timerStart: null,
        timerStarted: false
      };
    }
  });
});

console.log(`\nRocha task activated: ${rochaActivated}`);

// Save to local db.json
fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2));

// Upload db.json to 192.168.50.4
console.log("Uploading updated db.json to 192.168.50.4...");
const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('db.json', '/home/cbelocures/gestion/db.json', (putErr) => {
      if (putErr) console.error("SFTP error:", putErr.message);
      else console.log("✅ Successfully uploaded to 192.168.50.4");
      conn.end();
    });
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
});
