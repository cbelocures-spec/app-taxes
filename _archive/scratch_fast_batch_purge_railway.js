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

const today6am = new Date();
today6am.setHours(6, 0, 0, 0);
const start6amMs = today6am.getTime();

function getRailwayOrders() {
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

function pushLocalSyncResult(id, data) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(data);
    const req = https.request({
      hostname: RAILWAY_HOST,
      path: `/api/orders/local-sync-result/${id}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-username': 'paniol@contenedoreshugo.com.ar',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 5000
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', err => resolve({ error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
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
  console.log("=== BATCH PURGING RAILWAY DUPLICATE ORDERS ===");
  const rwOrders = await getRailwayOrders();

  const purgePromises = [];

  for (const o of rwOrders) {
    const is155 = String(o.interno) === '155';
    const is119 = String(o.interno) === '119';

    if (is155 && String(o.id) !== '1784884919356') {
      purgePromises.push(pushLocalSyncResult(o.id, { archived: true, deleted: true, deletedAt: new Date().toISOString() }));
    } else if (is119 && String(o.id) !== '1785334094327') {
      purgePromises.push(pushLocalSyncResult(o.id, { archived: true, deleted: true, deletedAt: new Date().toISOString() }));
    }
  }

  await Promise.all(purgePromises);
  console.log(`✅ Batch purged ${purgePromises.length} duplicate orders on Railway!`);

  // Target orders
  const clean3Tasks155 = [
    {
      id: "task-155-ojeda-clean",
      centroCosto: "15",
      empleado: "OJEDA FERNANDEZ JOSE ENRIQUE",
      horasEstimadas: 3.5,
      status: "Pendiente",
      descripcion: "desarme rueda derecha trasera revision rulemanes campana y cinta",
      timerStart: start6amMs,
      timerStarted: true,
      timerHistory: []
    },
    {
      id: "task-155-perez-clean",
      centroCosto: "15",
      empleado: "PEREZ FACUNDO",
      horasEstimadas: 6.5,
      status: "Pendiente",
      descripcion: "pintar pisos con antioxidaaantes",
      timerStart: start6amMs,
      timerStarted: true,
      timerHistory: []
    },
    {
      id: "task-155-rocha-clean",
      centroCosto: "15",
      empleado: "Rocha, Ariel Maximiliano",
      horasEstimadas: 6.5,
      status: "Pendiente",
      descripcion: "termina de pisos revision puertas y cabina",
      timerStart: start6amMs,
      timerStarted: true,
      timerHistory: []
    }
  ];

  const clean2Tasks119 = [
    {
      id: "task-119-morel-clean",
      centroCosto: "15",
      empleado: "Morel, Luis Maximiliano",
      horasEstimadas: 4.5,
      status: "Pendiente",
      descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
      timerStart: start6amMs,
      timerStarted: true,
      timerHistory: []
    },
    {
      id: "task-119-canaviri-clean",
      centroCosto: "15",
      empleado: "Canaviri Fernandez, Jesús",
      horasEstimadas: 4.5,
      status: "Pendiente",
      descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
      timerStart: start6amMs,
      timerStarted: true,
      timerHistory: []
    }
  ];

  const o155 = rwOrders.find(o => String(o.id) === '1784884919356');
  if (o155) {
    const historical = (o155.tasks || []).filter(t => t.status === 'Finalizada');
    o155.tasks = [...historical, ...clean3Tasks155];
    o155.archived = false;
    o155.deleted = false;
    await pushLocalSyncResult(o155.id, o155);
  }

  const o119 = rwOrders.find(o => String(o.id) === '1785334094327');
  if (o119) {
    const historical = (o119.tasks || []).filter(t => t.status === 'Finalizada');
    o119.tasks = [...historical, ...clean2Tasks119];
    o119.archived = false;
    o119.deleted = false;
    await pushLocalSyncResult(o119.id, o119);
  }

  const verifiedRw = await getRailwayOrders();

  console.log("\n=== RAILWAY VERIFICATION: EXACT ACTIVE TASKS ===");
  let count = 0;
  verifiedRw.forEach(o => {
    if (!o.archived && !o.deleted) {
      (o.tasks || []).forEach(t => {
        if (t.status === 'Pendiente' || !t.status) {
          count++;
          console.log(`[#${count}] OT Interno ${o.interno} (${o.rodado}): ${t.empleado} - TimerStart: ${t.timerStart}`);
        }
      });
    }
  });
  console.log(`TOTAL ACTIVE TASKS ON RAILWAY: ${count}`);

  const localDb = fs.existsSync('db.json') ? JSON.parse(fs.readFileSync('db.json', 'utf8')) : {};
  localDb.workOrders = verifiedRw;
  fs.writeFileSync('db.json', JSON.stringify(localDb, null, 2), 'utf8');

  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp(async (err, sftp) => {
      if (err) return conn.end();
      const tmp = './db_batch_purged.json';
      fs.writeFileSync(tmp, JSON.stringify(localDb, null, 2), 'utf8');
      await sftp.fastPut(tmp, '/home/cbelocures/data/db.json');
      fs.unlinkSync(tmp);

      await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
      await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
      console.log("✅ Persistent db.json updated and app-taxes.service restarted on Debian!");
      conn.end();
    });
  }).on('error', e => console.error("SSH error:", e.message)).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
