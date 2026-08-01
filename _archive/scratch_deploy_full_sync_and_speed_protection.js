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

function pushOrderToRailway(id, data) {
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
  console.log("=== STEP 1: DEPLOYING FAST DB & UPDATED CORE TO DEBIAN ===");
  const conn = new Client();
  conn.on('ready', () => {
    conn.exec('cat /home/cbelocures/data/db.json', async (err, stream) => {
      let out = '';
      stream.on('close', async () => {
        let db = { workOrders: [], settings: {}, catalogs: {} };
        try { db = JSON.parse(out); } catch(e) {}

        const activeOrders = (db.workOrders || []).filter(o => !o.archived && o.deleted !== true);
        console.log(`Active orders on Debian to sync to Railway: ${activeOrders.length}`);

        // Push all active orders from Debian to Railway
        for (const order of activeOrders) {
          console.log(`  Syncing active order ${order.interno} (${order.id}) to Railway...`);
          await pushOrderToRailway(order.id, {
            ...order,
            archived: false,
            deleted: false
          });
        }

        conn.sftp(async (sftpErr, sftp) => {
          if (sftpErr) return conn.end();

          await uploadFile(sftp, 'database.js', '/home/cbelocures/gestion/database.js');
          console.log("  ✅ Uploaded database.js!");

          await uploadFile(sftp, 'server.js', '/home/cbelocures/gestion/server.js');
          console.log("  ✅ Uploaded server.js!");

          await uploadFile(sftp, 'railway_sync_agent.js', '/home/cbelocures/gestion/railway_sync_agent.js');
          console.log("  ✅ Uploaded railway_sync_agent.js!");

          await uploadFile(sftp, 'public/app.js', '/home/cbelocures/gestion/public/app.js');
          console.log("  ✅ Uploaded public/app.js!");

          await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
          console.log("✅ app-taxes.service restarted on Debian!");

          conn.end();
        });
      }).on('data', d => out += d);
    });
  }).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
