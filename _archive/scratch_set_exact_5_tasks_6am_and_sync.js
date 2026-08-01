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

// Exact 06:00 AM Argentina time timestamp for today (July 31, 2026)
const today6am = new Date();
today6am.setHours(6, 0, 0, 0);
const start6amMs = today6am.getTime();
console.log(`Setting timerStart to 06:00 AM ART: ${start6amMs} (${today6am.toISOString()})`);

const tasks155 = [
  {
    id: "task-155-ojeda-6am-fixed",
    centroCosto: "15",
    empleado: "OJEDA FERNANDEZ JOSE ENRIQUE",
    horasEstimadas: 3.5,
    status: "Pendiente",
    descripcion: "desarme rueda derecha trasera revision rulemanes campana y cinta",
    timerStart: start6amMs,
    timerStarted: true,
    timerHistory: [{ event: 'inició', timestamp: start6amMs }]
  },
  {
    id: "task-155-perez-6am-fixed",
    centroCosto: "15",
    empleado: "PEREZ FACUNDO",
    horasEstimadas: 6.5,
    status: "Pendiente",
    descripcion: "pintar pisos con antioxidaaantes",
    timerStart: start6amMs,
    timerStarted: true,
    timerHistory: [{ event: 'inició', timestamp: start6amMs }]
  },
  {
    id: "task-155-rocha-6am-fixed",
    centroCosto: "15",
    empleado: "Rocha, Ariel Maximiliano",
    horasEstimadas: 6.5,
    status: "Pendiente",
    descripcion: "termina de pisos revision puertas y cabina",
    timerStart: start6amMs,
    timerStarted: true,
    timerHistory: [{ event: 'inició', timestamp: start6amMs }]
  }
];

const tasks119 = [
  {
    id: "task-119-morel-6am-fixed",
    centroCosto: "15",
    empleado: "Morel, Luis Maximiliano",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: start6amMs,
    timerStarted: true,
    timerHistory: [{ event: 'inició', timestamp: start6amMs }]
  },
  {
    id: "task-119-canaviri-6am-fixed",
    centroCosto: "15",
    empleado: "Canaviri Fernandez, Jesús",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: start6amMs,
    timerStarted: true,
    timerHistory: [{ event: 'inició', timestamp: start6amMs }]
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

function putOrderWithRetry(id, data, maxAttempts = 3) {
  return new Promise(async (resolve) => {
    const payload = JSON.stringify(data);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await new Promise((resFn, rejFn) => {
          const req = https.request({
            hostname: RAILWAY_HOST,
            path: `/api/orders/${id}`,
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'x-user-username': 'paniol@contenedoreshugo.com.ar',
              'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 15000
          }, response => {
            let body = '';
            response.on('data', c => body += c);
            response.on('end', () => resFn({ status: response.statusCode, body }));
          });
          req.on('error', rejFn);
          req.on('timeout', () => { req.destroy(); rejFn(new Error('Timeout')); });
          req.write(payload);
          req.end();
        });

        if (res.status === 200) return resolve(res);
      } catch (err) {}
      await new Promise(r => setTimeout(r, 1500));
    }
    resolve({ status: 500, error: 'Retry limit reached' });
  });
}

function uploadFile(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (err) => {
      if (err) return reject(err);
      resolve();
    });
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

  for (const o of orders) {
    let modified = false;

    if (String(o.interno) === '155') {
      if (String(o.id) === '1784884919356') {
        const historical = (o.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('6am'));
        o.tasks = [...historical, ...tasks155];
        o.archived = false;
        o.deleted = false;
      } else {
        o.archived = true;
      }
      modified = true;
    }

    if (String(o.interno) === '119') {
      if (String(o.id) === '1785334094327') {
        const historical = (o.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('6am'));
        o.tasks = [...historical, ...tasks119];
        o.archived = false;
        o.deleted = false;
      } else {
        o.archived = true;
      }
      modified = true;
    }

    if (modified) {
      await putOrderWithRetry(o.id, o);
    }
  }

  const finalOrders = await getOrders();

  console.log("\n=== VERIFYING EXACT 5 WORKING TASKS (06:00 AM START) ===");
  let count = 0;
  finalOrders.forEach(o => {
    if (!o.archived && !o.deleted) {
      (o.tasks || []).forEach(t => {
        if (t.status === 'Pendiente' || !t.status) {
          count++;
          console.log(`[#${count}] OT Interno ${o.interno} (${o.rodado}):`);
          console.log(`     Empleado: ${t.empleado}`);
          console.log(`     TimerStart: ${t.timerStart}`);
          console.log(`     Descripcion: ${t.descripcion}\n`);
        }
      });
    }
  });
  console.log(`TOTAL WORKING TASKS WITH 06:00 AM START: ${count}`);

  // Write clean DB to local db.json and upload to Debian persistent db.json
  const localDb = fs.existsSync('db.json') ? JSON.parse(fs.readFileSync('db.json', 'utf8')) : {};
  localDb.workOrders = finalOrders;
  fs.writeFileSync('db.json', JSON.stringify(localDb, null, 2), 'utf8');

  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp(async (err, sftp) => {
      if (err) return conn.end();

      // Upload updated app.js
      await uploadFile(sftp, 'public/app.js', '/home/cbelocures/gestion/public/app.js');
      console.log("✅ Uploaded updated public/app.js to Debian!");

      // Upload persistent db.json
      const tmp = './db_6am_sync_final.json';
      fs.writeFileSync(tmp, JSON.stringify(localDb, null, 2), 'utf8');
      await uploadFile(sftp, tmp, '/home/cbelocures/data/db.json');
      fs.unlinkSync(tmp);

      console.log("✅ Uploaded persistent db.json with 06:00 AM timerStart to Debian!");
      await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
      await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
      console.log("✅ app-taxes.service restarted on Debian!");
      conn.end();
    });
  }).on('error', e => console.error("SSH error:", e.message)).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
