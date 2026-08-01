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
  const conn = new Client();
  conn.on('ready', () => {
    conn.exec('cat /home/cbelocures/data/db.json', async (err, stream) => {
      let out = '';
      stream.on('close', async () => {
        let db = { workOrders: [], settings: {}, catalogs: {} };
        try { db = JSON.parse(out); } catch(e) {}

        let archivedCount = 0;
        (db.workOrders || []).forEach(o => {
          if (!o.archived && o.deleted !== true && o.estadoUnidad !== 'fuera_de_servicio') {
            const tasks = o.tasks || [];
            const isCompleted = tasks.length > 0 && tasks.every(t => t && (t.status === 'Finalizada' || t.status === 'Completada'));
            if (isCompleted) {
              o.archived = true;
              o.archivedAt = new Date().toISOString();
              archivedCount++;
              console.log(`[AutoArchive] Order ${o.interno} (${o.id}) auto-archived to Historial without needing Taxes OT number.`);
              pushOrderToRailway(o.id, { ...o, archived: true, archivedAt: o.archivedAt });
            }
          }
        });

        console.log(`Total orders moved to Historial: ${archivedCount}`);

        conn.sftp(async (sftpErr, sftp) => {
          if (sftpErr) return conn.end();

          await uploadFile(sftp, 'database.js', '/home/cbelocures/gestion/database.js');
          console.log("  ✅ Uploaded database.js!");

          await uploadFile(sftp, 'server.js', '/home/cbelocures/gestion/server.js');
          console.log("  ✅ Uploaded server.js!");

          await uploadFile(sftp, 'public/app.js', '/home/cbelocures/gestion/public/app.js');
          console.log("  ✅ Uploaded public/app.js!");

          const tmp = './db_archived_fixed.json';
          fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
          await uploadFile(sftp, tmp, '/home/cbelocures/data/db.json');
          fs.unlinkSync(tmp);
          console.log("  ✅ Uploaded updated db.json to Debian!");

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
