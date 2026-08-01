const { Client } = require('ssh2');
const https = require('https');
const fs = require('fs');

const RAILWAY_HOST = 'app-taxes-production-ec67.up.railway.app';
const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

const fullCatalogs = JSON.parse(fs.readFileSync('prod_catalogs.json', 'utf8'));

const emptyDb = {
  workOrders: [],
  catalogs: fullCatalogs,
  auditLog: [],
  deletedLog: []
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
  console.log("=== STEP 1: CLEARING ALL ORDERS ON RAILWAY ===");
  const rwOrders = await getRailwayOrders();
  console.log(`Found ${rwOrders.length} orders on Railway to clear.`);

  const clearPromises = rwOrders.map(o => pushLocalSyncResult(o.id, { archived: true, deleted: true, deletedAt: new Date().toISOString() }));
  await Promise.all(clearPromises);
  console.log(`✅ Marked all ${rwOrders.length} orders as deleted/archived on Railway!`);

  console.log("\n=== STEP 2: CLEARING DEBIAN PERSISTENT DB & DEPLOYING CLEAN CORE ===");
  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp(async (sftpErr, sftp) => {
      if (sftpErr) return conn.end();

      const tmp = './db_empty_clean.json';
      fs.writeFileSync(tmp, JSON.stringify(emptyDb, null, 2), 'utf8');

      await uploadFile(sftp, tmp, '/home/cbelocures/data/db.json');
      fs.unlinkSync(tmp);
      console.log("  ✅ Uploaded empty db.json to Debian /home/cbelocures/data/db.json!");

      await uploadFile(sftp, 'public/app.js', '/home/cbelocures/gestion/public/app.js');
      console.log("  ✅ Uploaded updated public/app.js to Debian!");

      await uploadFile(sftp, 'database.js', '/home/cbelocures/gestion/database.js');
      console.log("  ✅ Uploaded database.js to Debian!");

      await uploadFile(sftp, 'syncWorker.js', '/home/cbelocures/gestion/syncWorker.js');
      console.log("  ✅ Uploaded syncWorker.js to Debian!");

      await uploadFile(sftp, 'railway_sync_agent.js', '/home/cbelocures/gestion/railway_sync_agent.js');
      console.log("  ✅ Uploaded railway_sync_agent.js to Debian!");

      await uploadFile(sftp, 'prod_catalogs.json', '/home/cbelocures/gestion/prod_catalogs.json');
      console.log("  ✅ Uploaded prod_catalogs.json to Debian!");

      await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
      await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
      console.log("✅ app-taxes.service restarted on Debian!");
      conn.end();
    });
  }).on('error', e => console.error("SSH error:", e.message)).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
