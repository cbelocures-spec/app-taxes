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

const target5Tasks155 = [
  {
    id: `task-155-ojeda-${Date.now()}`,
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
    id: `task-155-perez-${Date.now()}`,
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
    id: `task-155-rocha-${Date.now()}`,
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

const target5Tasks119 = [
  {
    id: `task-119-morel-${Date.now()}`,
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
    id: `task-119-canaviri-${Date.now()}`,
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

function sendPostRailway(path, data) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(data);
    const req = https.request({
      hostname: RAILWAY_HOST,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-username': 'paniol@contenedoreshugo.com.ar',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(payload);
    req.end();
  });
}

function sendPutRailway(path, data) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(data);
    const req = https.request({
      hostname: RAILWAY_HOST,
      path: path,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-user-username': 'paniol@contenedoreshugo.com.ar',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(payload);
    req.end();
  });
}

function getRailwayOrders() {
  return new Promise((resolve) => {
    https.get({
      hostname: RAILWAY_HOST,
      path: '/api/orders/all',
      headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

function runCmd(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('close', () => resolve(out))
        .on('data', d => out += d.toString());
    });
  });
}

async function run() {
  console.log("=== STEP 1: UPDATING RAILWAY WITH THE 5 EXACT PENDING TASKS ===");
  const railwayOrders = await getRailwayOrders();

  let o155 = railwayOrders.find(o => String(o.interno) === '155');
  if (o155) {
    console.log(`Found Order 155 on Railway (ID: ${o155.id}). Setting 3 pending tasks...`);
    o155.tasks = target5Tasks155;
    o155.archived = false;
    o155.deleted = false;
    o155.status = 'Pendiente';
    await sendPutRailway(`/api/orders/${o155.id}`, o155);
  } else {
    console.log("Order 155 not found on Railway. Creating fresh order...");
    await sendPostRailway('/api/orders', {
      id: '1784884919356',
      rodado: 'MERCEDES BENZ ATEGO 1725 Interno 155',
      interno: '155',
      clasificacion: 'Correctivo',
      responsable: 'OJEDA FERNANDEZ JOSE ENRIQUE',
      fechaEntrega: new Date().toISOString().split('T')[0],
      tasks: target5Tasks155
    });
  }

  let o119 = railwayOrders.find(o => String(o.interno) === '119');
  if (o119) {
    console.log(`Found Order 119 on Railway (ID: ${o119.id}). Setting 2 pending tasks...`);
    o119.tasks = target5Tasks119;
    o119.archived = false;
    o119.deleted = false;
    o119.status = 'Pendiente';
    await sendPutRailway(`/api/orders/${o119.id}`, o119);
  } else {
    console.log("Order 119 not found on Railway. Creating fresh order...");
    await sendPostRailway('/api/orders', {
      id: '1785334094327',
      rodado: 'MERCEDES BENZ ATEGO 1725 Interno 119',
      interno: '119',
      clasificacion: 'Correctivo',
      responsable: 'Morel, Luis Maximiliano',
      fechaEntrega: new Date().toISOString().split('T')[0],
      tasks: target5Tasks119
    });
  }

  console.log("\n=== STEP 2: UPDATING DEBIAN SERVER PERSISTENT DATABASE ===");
  // Refetch latest Railway orders to ensure full consistency
  const updatedRailwayOrders = await getRailwayOrders();

  const conn = new Client();
  conn.on('ready', async () => {
    conn.sftp(async (err, sftp) => {
      if (err) return conn.end();

      const localDbContent = fs.existsSync('db.json') ? JSON.parse(fs.readFileSync('db.json', 'utf8')) : {};
      const mergedDb = {
        ...localDbContent,
        workOrders: updatedRailwayOrders
      };

      // Ensure local db.json has the 5 tasks as well
      const local155 = (mergedDb.workOrders || []).find(o => String(o.interno) === '155');
      if (local155) local155.tasks = target5Tasks155;
      const local119 = (mergedDb.workOrders || []).find(o => String(o.interno) === '119');
      if (local119) local119.tasks = target5Tasks119;

      fs.writeFileSync('db.json', JSON.stringify(mergedDb, null, 2), 'utf8');

      const tmpDbFile = './merged_db_5tasks.json';
      fs.writeFileSync(tmpDbFile, JSON.stringify(mergedDb, null, 2), 'utf8');

      sftp.fastPut(tmpDbFile, '/home/cbelocures/data/db.json', async (uploadErr) => {
        fs.unlinkSync(tmpDbFile);
        if (uploadErr) {
          console.error("Upload error to Debian:", uploadErr.message);
          conn.end();
          return;
        }

        console.log("✅ Successfully uploaded persistent db.json with exact 5 tasks to Debian!");
        await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
        await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
        console.log("✅ Services restarted on Debian!");
        conn.end();
      });
    });
  }).on('error', err => console.error("SSH error:", err.message)).connect(DEBIAN_CONFIG);
}

run();
