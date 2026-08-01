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

const today6am = new Date();
today6am.setHours(6, 0, 0, 0);
const start6amMs = today6am.getTime();

const tasks155_clean = [
  {
    id: "task-155-ojeda-target-6am",
    centroCosto: "15",
    empleado: "OJEDA FERNANDEZ JOSE ENRIQUE",
    horasEstimadas: 3.5,
    status: "Pendiente",
    descripcion: "desarme rueda derecha trasera revision rulemanes campana y cinta",
    timerStart: start6amMs,
    timerStarted: true,
    timerHistory: []
  },
  {
    id: "task-155-perez-target-6am",
    centroCosto: "15",
    empleado: "PEREZ FACUNDO",
    horasEstimadas: 6.5,
    status: "Pendiente",
    descripcion: "pintar pisos con antioxidaaantes",
    timerStart: start6amMs,
    timerStarted: true,
    timerHistory: []
  },
  {
    id: "task-155-rocha-target-6am",
    centroCosto: "15",
    empleado: "Rocha, Ariel Maximiliano",
    horasEstimadas: 6.5,
    status: "Pendiente",
    descripcion: "termina de pisos revision puertas y cabina",
    timerStart: start6amMs,
    timerStarted: true,
    timerHistory: []
  }
];

const tasks119_clean = [
  {
    id: "task-119-morel-target-6am",
    centroCosto: "15",
    empleado: "Morel, Luis Maximiliano",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: start6amMs,
    timerStarted: true,
    timerHistory: []
  },
  {
    id: "task-119-canaviri-target-6am",
    centroCosto: "15",
    empleado: "Canaviri Fernandez, Jesús",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: start6amMs,
    timerStarted: true,
    timerHistory: []
  }
];

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
  const conn = new Client();
  conn.on('ready', () => {
    conn.exec('cat /home/cbelocures/data/db.json', async (err, stream) => {
      let out = '';
      stream.on('close', async () => {
        let db = { workOrders: [] };
        try { db = JSON.parse(out); } catch(e) {}

        const pushPromises = [];

        (db.workOrders || []).forEach(o => {
          const is155 = String(o.interno) === '155';
          const is119 = String(o.interno) === '119';

          if (is155) {
            if (String(o.id) === '1784884919356') {
              const historical = (o.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('6am'));
              o.tasks = [...historical, ...tasks155_clean];
              o.archived = false;
              o.deleted = false;
              pushPromises.push(pushLocalSyncResult(o.id, o));
            } else {
              o.archived = true;
              o.deleted = true;
              o.deletedAt = new Date().toISOString();
              pushPromises.push(pushLocalSyncResult(o.id, { archived: true, deleted: true, deletedAt: o.deletedAt }));
            }
          }

          if (is119) {
            if (String(o.id) === '1785334094327') {
              const historical = (o.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('6am'));
              o.tasks = [...historical, ...tasks119_clean];
              o.archived = false;
              o.deleted = false;
              pushPromises.push(pushLocalSyncResult(o.id, o));
            } else {
              o.archived = true;
              o.deleted = true;
              o.deletedAt = new Date().toISOString();
              pushPromises.push(pushLocalSyncResult(o.id, { archived: true, deleted: true, deletedAt: o.deletedAt }));
            }
          }
        });

        await Promise.all(pushPromises);
        console.log(`✅ Pushed ${pushPromises.length} order state updates to Railway!`);

        conn.sftp(async (sftpErr, sftp) => {
          if (sftpErr) return conn.end();

          console.log("=== UPLOADING FIXED CORE FILES AND CLEAN DB TO DEBIAN ===");
          await uploadFile(sftp, 'public/app.js', '/home/cbelocures/gestion/public/app.js');
          console.log("  ✅ Uploaded public/app.js!");

          await uploadFile(sftp, 'database.js', '/home/cbelocures/gestion/database.js');
          console.log("  ✅ Uploaded database.js!");

          await uploadFile(sftp, 'railway_sync_agent.js', '/home/cbelocures/gestion/railway_sync_agent.js');
          console.log("  ✅ Uploaded railway_sync_agent.js!");

          const tmp = './db_fully_equalized.json';
          fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
          await uploadFile(sftp, tmp, '/home/cbelocures/data/db.json');
          fs.unlinkSync(tmp);
          console.log("  ✅ Uploaded persistent db.json!");

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
