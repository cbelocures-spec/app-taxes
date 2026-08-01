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

const tasks119 = [
  {
    id: `task-119-morel-119-clean`,
    centroCosto: "15",
    empleado: "Morel, Luis Maximiliano",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: null,
    timerStarted: false
  },
  {
    id: `task-119-canaviri-119-clean`,
    centroCosto: "15",
    empleado: "Canaviri Fernandez, Jesús",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: null,
    timerStarted: false
  }
];

function putOrderWithRetry(id, data, maxAttempts = 5) {
  return new Promise(async (resolve, reject) => {
    const payload = JSON.stringify(data);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`Sending PUT /api/orders/${id} (Attempt ${attempt}/${maxAttempts})...`);
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
          req.on('timeout', () => { req.destroy(); rejFn(new Error('Request Timeout')); });
          req.write(payload);
          req.end();
        });

        if (res.status === 200) {
          console.log(`✅ Success updating Order ${id} on Railway!`);
          return resolve(res);
        } else {
          console.warn(`Attempt ${attempt} returned status ${res.status}: ${res.body.substring(0, 100)}`);
        }
      } catch (err) {
        console.warn(`Attempt ${attempt} failed: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    reject(new Error(`Failed to update order ${id} after ${maxAttempts} attempts.`));
  });
}

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
  const orders = await getRailwayOrders();
  const o119 = orders.find(o => String(o.id) === '1785334094327' || (!o.archived && !o.deleted && String(o.interno) === '119'));

  if (o119) {
    const historical = (o119.tasks || []).filter(t => t.status === 'Finalizada');
    o119.tasks = [...historical, ...tasks119];
    o119.archived = false;
    o119.deleted = false;
    o119.status = 'Pendiente';
    await putOrderWithRetry(o119.id, o119);
  }

  const updatedOrders = await getRailwayOrders();

  console.log("\n=== ALL ACTIVE PENDING TASKS ON RAILWAY ===");
  let count = 0;
  updatedOrders.forEach(o => {
    if (!o.archived && !o.deleted) {
      (o.tasks || []).forEach(t => {
        if (t.status === 'Pendiente' || !t.status) {
          count++;
          console.log(`[#${count}] OT Interno ${o.interno} (${o.rodado}): [${t.empleado}] ${t.descripcion}`);
        }
      });
    }
  });
  console.log(`TOTAL ACTIVE PENDING TASKS: ${count}`);

  // Sync to local and Debian DB
  const localDb = fs.existsSync('db.json') ? JSON.parse(fs.readFileSync('db.json', 'utf8')) : {};
  localDb.workOrders = updatedOrders;
  fs.writeFileSync('db.json', JSON.stringify(localDb, null, 2), 'utf8');

  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) return conn.end();
      const tmp = './db_119_retry.json';
      fs.writeFileSync(tmp, JSON.stringify(localDb, null, 2), 'utf8');

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
