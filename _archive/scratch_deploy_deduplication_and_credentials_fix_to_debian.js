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

async function run() {
  console.log("=== STEP 1: DEPLOYING DATABASE.JS, SERVER.JS, SYNCWORKER.JS TO DEBIAN ===");
  const conn = new Client();
  conn.on('ready', () => {
    conn.exec('cat /home/cbelocures/data/db.json', async (err, stream) => {
      let out = '';
      stream.on('close', async () => {
        let db = { workOrders: [], settings: {}, catalogs: {} };
        try { db = JSON.parse(out); } catch(e) {}

        // Ensure default Taxes credentials in DB
        db.settings = db.settings || {};
        db.settings.username = "paniol@contenedoreshugo.com.ar";
        db.settings.password = "Paniol2015";

        // Consolidate duplicate orders by interno
        const uniqueOrders = new Map();
        (db.workOrders || []).forEach(o => {
          if (!o) return;
          const key = o.interno ? String(o.interno).trim().toLowerCase() : String(o.id);
          if (!uniqueOrders.has(key)) {
            uniqueOrders.set(key, { ...o, syncError: null, syncStatus: "success" });
          } else {
            // Mark duplicate as archived/deleted
            const dup = uniqueOrders.get(key);
            console.log(`[Deduplicator] Removing duplicate order for Interno ${o.interno} (ID: ${o.id})`);
            pushLocalSyncResult(o.id, { archived: true, deleted: true });
          }
        });

        db.workOrders = Array.from(uniqueOrders.values());

        conn.sftp(async (sftpErr, sftp) => {
          if (sftpErr) return conn.end();

          await uploadFile(sftp, 'database.js', '/home/cbelocures/gestion/database.js');
          console.log("  ✅ Uploaded database.js!");

          await uploadFile(sftp, 'syncWorker.js', '/home/cbelocures/gestion/syncWorker.js');
          console.log("  ✅ Uploaded syncWorker.js!");

          await uploadFile(sftp, 'server.js', '/home/cbelocures/gestion/server.js');
          console.log("  ✅ Uploaded server.js!");

          await uploadFile(sftp, 'railway_sync_agent.js', '/home/cbelocures/gestion/railway_sync_agent.js');
          console.log("  ✅ Uploaded railway_sync_agent.js!");

          await uploadFile(sftp, 'public/app.js', '/home/cbelocures/gestion/public/app.js');
          console.log("  ✅ Uploaded public/app.js!");

          const tmp = './db_deduped_cred_fixed.json';
          fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
          await uploadFile(sftp, tmp, '/home/cbelocures/data/db.json');
          fs.unlinkSync(tmp);
          console.log("  ✅ Uploaded cleaned, deduplicated & credential-configured db.json to Debian!");

          await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
          await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
          console.log("✅ app-taxes.service restarted on Debian!");

          // Also push clean single order for Interno 28 to Railway
          const activeOrder28 = db.workOrders.find(o => String(o.interno) === '28');
          if (activeOrder28) {
            console.log(`[RailwayPush] Uploading clean active order for Interno 28 (ID: ${activeOrder28.id}) to Railway...`);
            await pushLocalSyncResult(activeOrder28.id, {
              ...activeOrder28,
              archived: false,
              deleted: false,
              syncError: null,
              syncStatus: "success"
            });
            console.log("  ✅ Clean order for Interno 28 pushed to Railway!");
          }

          conn.end();
        });
      }).on('data', d => out += d);
    });
  }).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
