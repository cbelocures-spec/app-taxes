const https = require('https');
const { Client } = require('ssh2');
const fs = require('fs');

const RAILWAY_HOST = 'app-taxes-production-ec67.up.railway.app';
const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

const exact3Tasks155 = [
  {
    id: "task-155-ojeda-clean",
    centroCosto: "15",
    empleado: "OJEDA FERNANDEZ JOSE ENRIQUE",
    horasEstimadas: 3.5,
    status: "Pendiente",
    descripcion: "desarme rueda derecha trasera revision rulemanes campana y cinta",
    timerStart: null,
    timerStarted: false
  },
  {
    id: "task-155-perez-clean",
    centroCosto: "15",
    empleado: "PEREZ FACUNDO",
    horasEstimadas: 6.5,
    status: "Pendiente",
    descripcion: "pintar pisos con antioxidaaantes",
    timerStart: null,
    timerStarted: false
  },
  {
    id: "task-155-rocha-clean",
    centroCosto: "15",
    empleado: "Rocha, Ariel Maximiliano",
    horasEstimadas: 6.5,
    status: "Pendiente",
    descripcion: "termina de pisos revision puertas y cabina",
    timerStart: null,
    timerStarted: false
  }
];

const exact2Tasks119 = [
  {
    id: "task-119-morel-clean",
    centroCosto: "15",
    empleado: "Morel, Luis Maximiliano",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: null,
    timerStarted: false
  },
  {
    id: "task-119-canaviri-clean",
    centroCosto: "15",
    empleado: "Canaviri Fernandez, Jesús",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: null,
    timerStarted: false
  }
];

function getOrders() {
  return new Promise((resolve) => {
    https.get({
      hostname: RAILWAY_HOST,
      path: '/api/orders/all',
      headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

function putOrder(id, data) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(data);
    const req = https.request({
      hostname: RAILWAY_HOST,
      path: `/api/orders/${id}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-user-username': 'paniol@contenedoreshugo.com.ar',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', err => resolve({ error: err.message }));
    req.write(payload);
    req.end();
  });
}

function runCmd(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('close', () => resolve(out)).on('data', d => out += d);
    });
  });
}

async function run() {
  const orders = await getOrders();

  const o155 = orders.find(o => String(o.id) === '1784884919356' || String(o.interno) === '155');
  if (o155) {
    const historicalTasks = (o155.tasks || []).filter(t => t.status === 'Finalizada' || t.synced === true);
    o155.tasks = [...historicalTasks, ...exact3Tasks155];
    o155.archived = false;
    o155.deleted = false;
    o155.status = 'Pendiente';
    await putOrder(o155.id, o155);
  }

  const o119 = orders.find(o => String(o.id) === '1784904402541' || String(o.id) === '1785334094327' || String(o.interno) === '119');
  if (o119) {
    const historicalTasks = (o119.tasks || []).filter(t => t.status === 'Finalizada' || t.synced === true);
    o119.tasks = [...historicalTasks, ...exact2Tasks119];
    o119.archived = false;
    o119.deleted = false;
    o119.status = 'Pendiente';
    await putOrder(o119.id, o119);
  }

  const finalOrders = await getOrders();

  console.log("\n=== EXACT 5 UNIQUE ACTIVE PENDING TASKS VERIFICATION ===");
  let pendingCount = 0;
  finalOrders.forEach(o => {
    (o.tasks || []).forEach(t => {
      if (t.status === 'Pendiente' && !o.archived && !o.deleted) {
        pendingCount++;
        console.log(`[#${pendingCount}] OT Interno ${o.interno} (${o.rodado}):`);
        console.log(`     Empleado: ${t.empleado}`);
        console.log(`     Descripcion: ${t.descripcion}`);
      }
    });
  });
  console.log(`\nTOTAL ACTIVE PENDING TASKS IN SYSTEM: ${pendingCount}`);

  // Sync to local db.json and Debian /home/cbelocures/data/db.json
  const localDb = fs.existsSync('db.json') ? JSON.parse(fs.readFileSync('db.json', 'utf8')) : {};
  localDb.workOrders = finalOrders;
  fs.writeFileSync('db.json', JSON.stringify(localDb, null, 2), 'utf8');

  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) return conn.end();
      const tmp = './db_exact_5_dedup.json';
      fs.writeFileSync(tmp, JSON.stringify(localDb, null, 2), 'utf8');
      sftp.fastPut(tmp, '/home/cbelocures/data/db.json', async (uploadErr) => {
        fs.unlinkSync(tmp);
        if (uploadErr) return conn.end();
        console.log("✅ Clean persistent db.json updated on Debian!");
        await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
        await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
        console.log("✅ app-taxes.service restarted on Debian!");
        conn.end();
      });
    });
  }).on('error', e => console.error("SSH error:", e.message)).connect(DEBIAN_CONFIG);
}

run();
