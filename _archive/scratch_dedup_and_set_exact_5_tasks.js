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

const exact5Tasks155 = [
  {
    id: "task-155-ojeda-155-1",
    centroCosto: "15",
    empleado: "OJEDA FERNANDEZ JOSE ENRIQUE",
    horasEstimadas: 3.5,
    status: "Pendiente",
    descripcion: "desarme rueda derecha trasera revision rulemanes campana y cinta",
    timerStart: null,
    timerStarted: false,
    synced: false
  },
  {
    id: "task-155-perez-155-2",
    centroCosto: "15",
    empleado: "PEREZ FACUNDO",
    horasEstimadas: 6.5,
    status: "Pendiente",
    descripcion: "pintar pisos con antioxidaaantes",
    timerStart: null,
    timerStarted: false,
    synced: false
  },
  {
    id: "task-155-rocha-155-3",
    centroCosto: "15",
    empleado: "Rocha, Ariel Maximiliano",
    horasEstimadas: 6.5,
    status: "Pendiente",
    descripcion: "termina de pisos revision puertas y cabina",
    timerStart: null,
    timerStarted: false,
    synced: false
  }
];

const exact5Tasks119 = [
  {
    id: "task-119-morel-119-1",
    centroCosto: "15",
    empleado: "Morel, Luis Maximiliano",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: null,
    timerStarted: false,
    synced: false
  },
  {
    id: "task-119-canaviri-119-2",
    centroCosto: "15",
    empleado: "Canaviri Fernandez, Jesús",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: null,
    timerStarted: false,
    synced: false
  }
];

function getRailwayOrders() {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: RAILWAY_HOST,
      path: '/api/orders/all',
      headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function putOrder(id, data) {
  return new Promise((resolve, reject) => {
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
    req.on('error', reject);
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

async function main() {
  console.log("=== CLEANING DUPES AND SETTING EXACT 5 TASKS ON RAILWAY ===");
  const orders = await getRailwayOrders();

  const o155 = orders.find(o => String(o.interno) === '155');
  if (o155) {
    const history = (o155.tasks || []).filter(t => t.status === 'Finalizada' || t.synced === true);
    o155.tasks = [...history, ...exact5Tasks155];
    o155.archived = false;
    o155.deleted = false;
    await putOrder(o155.id, o155);
    console.log("✅ Order 155 updated with exact 3 pending tasks!");
  }

  const o119 = orders.find(o => String(o.interno) === '119');
  if (o119) {
    const history = (o119.tasks || []).filter(t => t.status === 'Finalizada' || t.synced === true);
    o119.tasks = [...history, ...exact5Tasks119];
    o119.archived = false;
    o119.deleted = false;
    await putOrder(o119.id, o119);
    console.log("✅ Order 119 updated with exact 2 pending tasks!");
  }

  const updatedOrders = await getRailwayOrders();

  console.log("\n=== VERIFYING PENDING TASKS ON RAILWAY ===");
  let count = 0;
  updatedOrders.forEach(o => {
    (o.tasks || []).forEach(t => {
      if (t.status === 'Pendiente') {
        count++;
        console.log(`  #${count} OT Interno ${o.interno}: [${t.empleado}] ${t.descripcion}`);
      }
    });
  });
  console.log(`Total active pending tasks: ${count}`);

  // Sync to local and Debian DB
  const localData = fs.existsSync('db.json') ? JSON.parse(fs.readFileSync('db.json', 'utf8')) : {};
  localData.workOrders = updatedOrders;
  fs.writeFileSync('db.json', JSON.stringify(localData, null, 2), 'utf8');

  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) return conn.end();
      const tmp = './merged_exact_5.json';
      fs.writeFileSync(tmp, JSON.stringify(localData, null, 2), 'utf8');
      sftp.fastPut(tmp, '/home/cbelocures/data/db.json', async (uploadErr) => {
        fs.unlinkSync(tmp);
        if (uploadErr) return conn.end();
        console.log("✅ Persistent db.json updated on Debian!");
        await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
        await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
        console.log("✅ app-taxes.service restarted on Debian!");
        conn.end();
      });
    });
  }).on('error', e => console.error("SSH error:", e.message)).connect(DEBIAN_CONFIG);
}

main().catch(console.error);
