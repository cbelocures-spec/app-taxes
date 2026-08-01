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

const tasks155_clean = [
  {
    id: "task-155-ojeda-target-6am",
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
    id: "task-155-perez-target-6am",
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
    id: "task-155-rocha-target-6am",
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

const tasks119_clean = [
  {
    id: "task-119-morel-target-6am",
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
    id: "task-119-canaviri-target-6am",
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

function archiveOrder(id) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: RAILWAY_HOST,
      path: `/api/orders/${id}/archive`,
      method: 'PATCH',
      headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', err => resolve({ error: err.message }));
    req.end();
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
  console.log("=== STEP 1: ARCHIVING ALL 155 AND 119 DUPLICATES ON RAILWAY ===");
  const rwOrders = await getRailwayOrders();

  const archivePromises = [];
  for (const o of rwOrders) {
    const is155 = String(o.interno) === '155';
    const is119 = String(o.interno) === '119';

    if (is155 && String(o.id) !== '1784884919356') {
      archivePromises.push(archiveOrder(o.id));
      archivePromises.push(pushLocalSyncResult(o.id, { archived: true, deleted: true }));
    } else if (is119 && String(o.id) !== '1785334094327') {
      archivePromises.push(archiveOrder(o.id));
      archivePromises.push(pushLocalSyncResult(o.id, { archived: true, deleted: true }));
    }
  }

  await Promise.all(archivePromises);
  console.log(`✅ Archived ${archivePromises.length / 2} duplicate orders on Railway!`);

  // Target Order 155 update
  const o155 = rwOrders.find(o => String(o.id) === '1784884919356');
  if (o155) {
    const historical = (o155.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('6am'));
    o155.tasks = [...historical, ...tasks155_clean];
    o155.archived = false;
    o155.deleted = false;
    await pushLocalSyncResult(o155.id, o155);
    console.log("  ✅ Updated Order 155 on Railway!");
  }

  // Target Order 119 update
  const o119 = rwOrders.find(o => String(o.id) === '1785334094327');
  if (o119) {
    const historical = (o119.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('6am'));
    o119.tasks = [...historical, ...tasks119_clean];
    o119.archived = false;
    o119.deleted = false;
    await pushLocalSyncResult(o119.id, o119);
    console.log("  ✅ Updated Order 119 on Railway!");
  }

  const finalRwOrders = await getRailwayOrders();

  console.log("\n=== STEP 2: VERIFICATION OF ACTIVE PENDING TASKS ON RAILWAY ===");
  let activeCount = 0;
  finalRwOrders.forEach(o => {
    if (!o.archived && !o.deleted) {
      (o.tasks || []).forEach(t => {
        if (t.status === 'Pendiente' || !t.status) {
          activeCount++;
          console.log(`[#${activeCount}] OT Interno ${o.interno} (${o.rodado}): ${t.empleado} - TimerStart: ${t.timerStart}`);
        }
      });
    }
  });
  console.log(`TOTAL ACTIVE TASKS ON RAILWAY: ${activeCount}`);

  // Push clean DB to Debian and restart app-taxes.service
  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp(async (err, sftp) => {
      if (err) return conn.end();

      const localDb = { workOrders: finalRwOrders };
      const tmp = './db_archive_all_155_119_clean.json';
      fs.writeFileSync(tmp, JSON.stringify(localDb, null, 2), 'utf8');

      sftp.fastPut(tmp, '/home/cbelocures/data/db.json', async (uploadErr) => {
        fs.unlinkSync(tmp);
        if (uploadErr) return conn.end();

        await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
        await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
        console.log("✅ Debian DB updated and app-taxes.service restarted!");
        conn.end();
      });
    });
  }).on('error', e => console.error("SSH error:", e.message)).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
