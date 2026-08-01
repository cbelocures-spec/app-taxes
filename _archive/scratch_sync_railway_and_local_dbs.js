const { Client } = require('ssh2');
const fs = require('fs');

// Set 5 target tasks on 155 and 119 in Pendiente status with 06:00 AM start time
const dbData = JSON.parse(fs.readFileSync('./db.json', 'utf8'));
const timestamp6am = new Date('2026-07-31T06:00:00-03:00').getTime();

const o155 = (dbData.workOrders || []).find(o => String(o.interno) === '155' || o.taxesOrderNumber === '26926');
if (o155) {
  o155.tasks = [
    {
      id: `t155-1-active`,
      centroCosto: "15",
      empleado: "OJEDA FERNANDEZ JOSE ENRIQUE",
      horasEstimadas: 3.5,
      status: "Pendiente",
      descripcion: "desarme rueda derecha trasera revision rulemanes campana y cinta",
      timerStart: timestamp6am,
      timerStarted: true,
      timerHistory: [{ event: 'Inició', timestamp: timestamp6am, timeString: '06:00' }]
    },
    {
      id: `t155-2-active`,
      centroCosto: "15",
      empleado: "PEREZ FACUNDO",
      horasEstimadas: 6.5,
      status: "Pendiente",
      descripcion: "pintar pisos con antioxidaaantes",
      timerStart: timestamp6am,
      timerStarted: true,
      timerHistory: [{ event: 'Inició', timestamp: timestamp6am, timeString: '06:00' }]
    },
    {
      id: `t155-3-active`,
      centroCosto: "15",
      empleado: "Rocha, Ariel Maximiliano",
      horasEstimadas: 6.5,
      status: "Pendiente",
      descripcion: "termina de pisos revision puertas y cabina",
      timerStart: timestamp6am,
      timerStarted: true,
      timerHistory: [{ event: 'Inició', timestamp: timestamp6am, timeString: '06:00' }]
    }
  ];
}

const o119 = (dbData.workOrders || []).find(o => String(o.interno) === '119' || o.taxesOrderNumber === '27889');
if (o119) {
  o119.tasks = [
    {
      id: `t119-1-active`,
      centroCosto: "15",
      empleado: "Morel, Luis Maximiliano",
      horasEstimadas: 4.5,
      status: "Pendiente",
      descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
      timerStart: timestamp6am,
      timerStarted: true,
      timerHistory: [{ event: 'Inició', timestamp: timestamp6am, timeString: '06:00' }]
    },
    {
      id: `t119-2-active`,
      centroCosto: "15",
      empleado: "Canaviri Fernandez, Jesús",
      horasEstimadas: 4.5,
      status: "Pendiente",
      descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
      timerStart: timestamp6am,
      timerStarted: true,
      timerHistory: [{ event: 'Inició', timestamp: timestamp6am, timeString: '06:00' }]
    }
  ];
}

fs.writeFileSync('./db.json', JSON.stringify(dbData, null, 2));

// Upload to 192.168.50.4
const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('./db.json', '/home/cbelocures/data/db.json', (err1) => {
      console.log("✅ Synchronized 192.168.50.4 db.json!");
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
