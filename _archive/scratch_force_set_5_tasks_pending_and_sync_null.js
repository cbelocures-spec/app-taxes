const fs = require('fs');
const { Client } = require('ssh2');

const dbFile = './db.json';
if (fs.existsSync(dbFile)) {
  const dbData = JSON.parse(fs.readFileSync(dbFile, 'utf8'));

  // 1. Order 155 (OT 26926)
  const o155 = (dbData.workOrders || []).find(o => String(o.interno) === '155' || o.taxesOrderNumber === '26926');
  if (o155) {
    o155.tasks = [
      {
        id: `t155-1`,
        centroCosto: "15",
        empleado: "OJEDA FERNANDEZ JOSE ENRIQUE",
        horasEstimadas: 3.5,
        status: "Pendiente",
        descripcion: "desarme rueda derecha trasera revision rulemanes campana y cinta",
        timerStart: null,
        timerStarted: false
      },
      {
        id: `t155-2`,
        centroCosto: "15",
        empleado: "PEREZ FACUNDO",
        horasEstimadas: 6.5,
        status: "Pendiente",
        descripcion: "pintar pisos con antioxidaaantes",
        timerStart: null,
        timerStarted: false
      },
      {
        id: `t155-3`,
        centroCosto: "15",
        empleado: "Rocha, Ariel Maximiliano",
        horasEstimadas: 6.5,
        status: "Pendiente",
        descripcion: "termina de pisos revision puertas y cabina",
        timerStart: null,
        timerStarted: false
      }
    ];
    console.log("✅ Set 3 clean Pendiente tasks for Interno 155!");
  }

  // 2. Order 119 (OT 27889)
  const o119 = (dbData.workOrders || []).find(o => String(o.interno) === '119' || o.taxesOrderNumber === '27889');
  if (o119) {
    o119.tasks = [
      {
        id: `t119-1`,
        centroCosto: "15",
        empleado: "Morel, Luis Maximiliano",
        horasEstimadas: 4.5,
        status: "Pendiente",
        descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
        timerStart: null,
        timerStarted: false
      },
      {
        id: `t119-2`,
        centroCosto: "15",
        empleado: "Canaviri Fernandez, Jesús",
        horasEstimadas: 4.5,
        status: "Pendiente",
        descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
        timerStart: null,
        timerStarted: false
      }
    ];
    console.log("✅ Set 2 clean Pendiente tasks for Interno 119!");
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
      console.log("✅ Uploaded db.json with 5 active tasks to 192.168.50.4!");
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
