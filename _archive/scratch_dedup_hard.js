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

  // Deduplicate tasks array inside EVERY order
  for (const o of orders) {
    if (!Array.isArray(o.tasks)) continue;

    const seenPendingKeys = new Set();
    const cleanTasks = [];

    for (const t of o.tasks) {
      if (t.status === 'Pendiente' || !t.status) {
        const key = `${t.empleado}_${(t.descripcion || '').trim().toLowerCase()}`;
        if (!seenPendingKeys.has(key)) {
          seenPendingKeys.add(key);
          cleanTasks.push(t);
        }
      } else {
        cleanTasks.push(t);
      }
    }

    if (cleanTasks.length !== o.tasks.length) {
      o.tasks = cleanTasks;
      await putOrder(o.id, o);
    }
  }

  const finalOrders = await getOrders();

  console.log("\n=== FINAL DEDUPLICATED ACTIVE PENDING TASKS ===");
  let count = 0;
  finalOrders.forEach(o => {
    if (!o.archived && !o.deleted) {
      (o.tasks || []).forEach(t => {
        if (t.status === 'Pendiente' || !t.status) {
          count++;
          console.log(`[#${count}] Interno ${o.interno} (${o.rodado}):`);
          console.log(`     Empleado: ${t.empleado}`);
          console.log(`     Descripcion: ${t.descripcion}`);
        }
      });
    }
  });
  console.log(`\nTOTAL UNIQUE ACTIVE PENDING TASKS: ${count}`);

  const localDb = fs.existsSync('db.json') ? JSON.parse(fs.readFileSync('db.json', 'utf8')) : {};
  localDb.workOrders = finalOrders;
  fs.writeFileSync('db.json', JSON.stringify(localDb, null, 2), 'utf8');

  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) return conn.end();
      const tmp = './db_dedup_hard.json';
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

run().catch(console.error);
