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

function deleteRailwayOrder(id) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: RAILWAY_HOST,
      path: `/api/orders/${id}`,
      method: 'DELETE',
      headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' },
      timeout: 5000
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', err => resolve({ error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

function archiveRailwayOrder(id) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: RAILWAY_HOST,
      path: `/api/orders/${id}/archive`,
      method: 'PATCH',
      headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' },
      timeout: 5000
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', err => resolve({ error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
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
  console.log("=== DELETING/ARCHIVING ALL DUPLICATE ORDERS ON RAILWAY ===");
  const rwOrders = await getRailwayOrders();

  const deletePromises = [];
  for (const o of rwOrders) {
    const is155 = String(o.interno) === '155';
    const is119 = String(o.interno) === '119';

    if (is155 && String(o.id) !== '1784884919356') {
      deletePromises.push(deleteRailwayOrder(o.id));
      deletePromises.push(archiveRailwayOrder(o.id));
    } else if (is119 && String(o.id) !== '1785334094327') {
      deletePromises.push(deleteRailwayOrder(o.id));
      deletePromises.push(archiveRailwayOrder(o.id));
    }
  }

  await Promise.all(deletePromises);
  console.log(`✅ Processed ${deletePromises.length / 2} duplicate orders on Railway!`);

  const verifiedRw = await getRailwayOrders();

  console.log("\n=== RAILWAY VERIFICATION: ACTIVE NON-DELETED NON-ARCHIVED ORDERS ===");
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

  // Deploy to Debian
  const localDb = { workOrders: verifiedRw };
  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp(async (err, sftp) => {
      if (err) return conn.end();

      const tmp = './db_delete_duplicates_rw.json';
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
