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
  console.log("=== STEP 1: FETCHING LIVE ORDERS FROM RAILWAY ===");
  const rwOrders = await getRailwayOrders();
  console.log(`Fetched ${rwOrders.length} orders from Railway.`);

  let workingCount = 0;
  rwOrders.forEach(o => {
    (o.tasks || []).forEach(t => {
      if (t.timerStart !== null && t.timerStart > 0 && t.status !== 'Finalizada') {
        workingCount++;
        console.log(`  Working Task: [${t.empleado}] on Interno ${o.interno} (${o.rodado}) - TimerStart: ${t.timerStart}`);
      }
    });
  });
  console.log(`Total active working tasks on Railway: ${workingCount}`);

  console.log("\n=== STEP 2: DEPLOYING 3-SECOND SYNC AGENT & LIVE DB TO DEBIAN ===");
  const conn = new Client();
  conn.on('ready', () => {
    conn.exec('cat /home/cbelocures/data/db.json', async (err, stream) => {
      let out = '';
      stream.on('close', async () => {
        let db = { workOrders: [], catalogs: {} };
        try { db = JSON.parse(out); } catch(e) {}

        db.workOrders = rwOrders;

        conn.sftp(async (sftpErr, sftp) => {
          if (sftpErr) return conn.end();

          await uploadFile(sftp, 'railway_sync_agent.js', '/home/cbelocures/gestion/railway_sync_agent.js');
          console.log("  ✅ Uploaded 3-second railway_sync_agent.js to Debian!");

          await uploadFile(sftp, 'public/app.js', '/home/cbelocures/gestion/public/app.js');
          console.log("  ✅ Uploaded public/app.js to Debian!");

          const tmp = './db_synced_rw_live.json';
          fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
          await uploadFile(sftp, tmp, '/home/cbelocures/data/db.json');
          fs.unlinkSync(tmp);
          console.log("  ✅ Uploaded live synchronized db.json to Debian!");

          await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
          await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
          console.log("✅ app-taxes.service restarted on Debian!");
          conn.end();
        });
      }).on('data', d => out += d);
    });
  }).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
