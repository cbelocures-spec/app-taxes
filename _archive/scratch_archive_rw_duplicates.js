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

function archiveRailwayOrder(id) {
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
  console.log("=== ARCHIVING ALL DUPLICATE ORDERS ON RAILWAY ===");
  const rwOrders = await getRailwayOrders();

  const archivePromises = [];
  for (const o of rwOrders) {
    const is155 = String(o.interno) === '155';
    const is119 = String(o.interno) === '119';

    if (is155 && String(o.id) !== '1784884919356') {
      archivePromises.push(archiveRailwayOrder(o.id));
    } else if (is119 && String(o.id) !== '1785334094327') {
      archivePromises.push(archiveRailwayOrder(o.id));
    }
  }

  await Promise.all(archivePromises);
  console.log(`✅ Archived ${archivePromises.length} duplicate orders on Railway!`);

  const finalRwOrders = await getRailwayOrders();

  console.log("\n=== VERIFICATION: ACTIVE ORDERS ON RAILWAY ===");
  let activeCount = 0;
  finalRwOrders.forEach(o => {
    if (!o.archived && !o.deleted) {
      (o.tasks || []).forEach(t => {
        if (t.status === 'Pendiente' || !t.status) {
          activeCount++;
          console.log(`[#${activeCount}] OT Interno ${o.interno}: ${t.empleado} - TimerStart: ${t.timerStart}`);
        }
      });
    }
  });
  console.log(`TOTAL ACTIVE TASKS ON RAILWAY: ${activeCount}`);

  // Deploy clean DB to Debian
  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp(async (err, sftp) => {
      if (err) return conn.end();

      const localDb = { workOrders: finalRwOrders };
      const tmp = './db_archive_rw_clean.json';
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
