const fs = require('fs');
const https = require('https');
const { Client } = require('ssh2');

const RAILWAY_HOST = 'app-taxes-production-ec67.up.railway.app';
const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

const tasks119ToInsert = [
  {
    id: `task-119-morel-active-${Date.now()}`,
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
    id: `task-119-canaviri-active-${Date.now()}`,
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
  console.log("=== STEP 1: UPDATING ACTIVE ORDER 119 ON RAILWAY ===");
  const orders = await getRailwayOrders();

  const o119 = orders.find(o => String(o.id) === '1785334094327' || (!o.archived && !o.deleted && String(o.interno) === '119'));
  if (o119) {
    console.log(`Found active Order 119 (ID: ${o119.id}, TaxesOT: ${o119.taxesOrderNumber}). Adding the 2 pending tasks...`);
    // Keep finished historical tasks, strip any old pending tasks, and append clean 2 pending tasks
    const finishedTasks = (o119.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('morel') && !t.id.includes('canaviri'));
    o119.tasks = [...finishedTasks, ...tasks119ToInsert];
    o119.archived = false;
    o119.deleted = false;
    o119.status = 'Pendiente';
    
    const putRes = await putOrder(o119.id, o119);
    console.log("Updated Order 119 response:", putRes.substring(0, 150));
  } else {
    console.log("Active order 119 not found on Railway");
  }

  // Also clean Order 155 to ensure exact 3 pending tasks
  const o155 = orders.find(o => String(o.id) === '1784884919356' || (!o.archived && !o.deleted && String(o.interno) === '155'));
  if (o155) {
    const finishedTasks155 = (o155.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('ojeda') && !t.id.includes('perez') && !t.id.includes('rocha'));
    const pendingTasks155 = [
      {
        id: `task-155-ojeda-active-${Date.now()}`,
        centroCosto: "15",
        empleado: "OJEDA FERNANDEZ JOSE ENRIQUE",
        horasEstimadas: 3.5,
        status: "Pendiente",
        descripcion: "desarme rueda derecha trasera revision rulemanes campana y cinta",
        timerStart: null,
        timerStarted: false
      },
      {
        id: `task-155-perez-active-${Date.now()}`,
        centroCosto: "15",
        empleado: "PEREZ FACUNDO",
        horasEstimadas: 6.5,
        status: "Pendiente",
        descripcion: "pintar pisos con antioxidaaantes",
        timerStart: null,
        timerStarted: false
      },
      {
        id: `task-155-rocha-active-${Date.now()}`,
        centroCosto: "15",
        empleado: "Rocha, Ariel Maximiliano",
        horasEstimadas: 6.5,
        status: "Pendiente",
        descripcion: "termina de pisos revision puertas y cabina",
        timerStart: null,
        timerStarted: false
      }
    ];
    o155.tasks = [...finishedTasks155, ...pendingTasks155];
    o155.archived = false;
    o155.deleted = false;
    await putOrder(o155.id, o155);
    console.log("Updated Order 155 on Railway!");
  }

  const updatedOrders = await getRailwayOrders();

  console.log("\n=== VERIFYING ACTIVE PENDING TASKS ON RAILWAY ===");
  let pendingCount = 0;
  updatedOrders.forEach(o => {
    if (!o.archived && !o.deleted) {
      (o.tasks || []).forEach(t => {
        if (t.status === 'Pendiente' || !t.status) {
          pendingCount++;
          console.log(`[#${pendingCount}] OT Interno ${o.interno} (${o.rodado}):`);
          console.log(`     Empleado: ${t.empleado}`);
          console.log(`     Descripcion: ${t.descripcion}`);
        }
      });
    }
  });
  console.log(`\nTOTAL ACTIVE PENDING TASKS ON RAILWAY: ${pendingCount}`);

  // STEP 2: Sync to local db.json and upload to Debian persistent db.json
  const localDb = fs.existsSync('db.json') ? JSON.parse(fs.readFileSync('db.json', 'utf8')) : {};
  localDb.workOrders = updatedOrders;
  fs.writeFileSync('db.json', JSON.stringify(localDb, null, 2), 'utf8');

  console.log("\n=== STEP 3: UPLOADING TO DEBIAN PERSISTENT DB AND RESTARTING ===");
  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) return conn.end();
      const tmpFile = './db_119_fix.json';
      fs.writeFileSync(tmpFile, JSON.stringify(localDb, null, 2), 'utf8');

      sftp.fastPut(tmpFile, '/home/cbelocures/data/db.json', async (uploadErr) => {
        fs.unlinkSync(tmpFile);
        if (uploadErr) {
          console.error("SFTP Error:", uploadErr.message);
          conn.end();
          return;
        }
        console.log("✅ Successfully updated persistent /home/cbelocures/data/db.json on Debian!");
        await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
        await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
        console.log("✅ app-taxes.service restarted on Debian!");
        conn.end();
      });
    });
  }).on('error', e => console.error("SSH error:", e.message)).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
