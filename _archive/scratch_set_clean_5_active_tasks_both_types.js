const fs = require('fs');
const { Client } = require('ssh2');

const timestamp6am = new Date('2026-07-31T06:00:00-03:00').getTime();
const dbFile = './db.json';

if (fs.existsSync(dbFile)) {
  const dbData = JSON.parse(fs.readFileSync(dbFile, 'utf8'));

  // 1. Order 155 (OT 26926)
  const o155 = (dbData.workOrders || []).find(o => String(o.interno) === '155' || o.taxesOrderNumber === '26926');
  if (o155) {
    o155.tasks = [
      {
        id: `t155-active-1`,
        centroCosto: "15",
        empleado: "OJEDA FERNANDEZ JOSE ENRIQUE",
        horasEstimadas: 3.5,
        status: "Pendiente",
        descripcion: "desarme rueda derecha trasera revision rulemanes campana y cinta",
        timerStart: timestamp6am,
        timerStarted: true,
        timerHistory: [
          { event: 'Inició', type: 'Inició', timestamp: timestamp6am, timeString: '06:00' }
        ]
      },
      {
        id: `t155-active-2`,
        centroCosto: "15",
        empleado: "PEREZ FACUNDO",
        horasEstimadas: 6.5,
        status: "Pendiente",
        descripcion: "pintar pisos con antioxidaaantes",
        timerStart: timestamp6am,
        timerStarted: true,
        timerHistory: [
          { event: 'Inició', type: 'Inició', timestamp: timestamp6am, timeString: '06:00' }
        ]
      },
      {
        id: `t155-active-3`,
        centroCosto: "15",
        empleado: "Rocha, Ariel Maximiliano",
        horasEstimadas: 6.5,
        status: "Pendiente",
        descripcion: "termina de pisos revision puertas y cabina",
        timerStart: timestamp6am,
        timerStarted: true,
        timerHistory: [
          { event: 'Inició', type: 'Inició', timestamp: timestamp6am, timeString: '06:00' }
        ]
      }
    ];
  }

  // 2. Order 119 (OT 27889)
  const o119 = (dbData.workOrders || []).find(o => String(o.interno) === '119' || o.taxesOrderNumber === '27889');
  if (o119) {
    o119.tasks = [
      {
        id: `t119-active-1`,
        centroCosto: "15",
        empleado: "Morel, Luis Maximiliano",
        horasEstimadas: 4.5,
        status: "Pendiente",
        descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
        timerStart: timestamp6am,
        timerStarted: true,
        timerHistory: [
          { event: 'Inició', type: 'Inició', timestamp: timestamp6am, timeString: '06:00' }
        ]
      },
      {
        id: `t119-active-2`,
        centroCosto: "15",
        empleado: "Canaviri Fernandez, Jesús",
        horasEstimadas: 4.5,
        status: "Pendiente",
        descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
        timerStart: timestamp6am,
        timerStarted: true,
        timerHistory: [
          { event: 'Inició', type: 'Inició', timestamp: timestamp6am, timeString: '06:00' }
        ]
      }
    ];
  }

  fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));
  console.log("✅ Updated db.json with clean 5 active tasks starting at 6:00 AM!");
}

// Upload to 192.168.50.4
const conn = new Client();
conn.on('ready', () => {
  console.log("✅ SSH Connected to 192.168.50.4!");
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('./db.json', '/home/cbelocures/data/db.json', (err1) => {
      sftp.fastPut('./public/app.js', '/home/cbelocures/gestion/public/app.js', (err2) => {
        console.log("✅ Uploaded db.json & public/app.js to 192.168.50.4!");
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
  password: 'CesarHernan3550',
  readyTimeout: 30000
});
