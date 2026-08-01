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
console.log(`Setting clean 06:00 AM timestamp: ${start6amMs}`);

const tasks155_final = [
  {
    id: "task-155-ojeda-6am-clean",
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
    id: "task-155-perez-6am-clean",
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
    id: "task-155-rocha-6am-clean",
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

const tasks119_final = [
  {
    id: "task-119-morel-6am-clean",
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
    id: "task-119-canaviri-6am-clean",
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

function pushToRailway(id, data) {
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

async function main() {
  const conn = new Client();
  conn.on('ready', () => {
    conn.exec('cat /home/cbelocures/data/db.json', async (err, stream) => {
      let out = '';
      stream.on('close', async () => {
        let db = { workOrders: [] };
        try { db = JSON.parse(out); } catch(e) {}

        (db.workOrders || []).forEach(o => {
          if (String(o.interno) === '155') {
            if (String(o.id) === '1784884919356') {
              const finished = (o.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('6am'));
              o.tasks = [...finished, ...tasks155_final];
              o.archived = false;
              o.deleted = false;
            } else {
              o.archived = true;
              (o.tasks || []).forEach(t => { if (t.status === 'Pendiente') t.status = 'Finalizada'; });
            }
          }

          if (String(o.interno) === '119') {
            if (String(o.id) === '1785334094327') {
              const finished = (o.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('6am'));
              o.tasks = [...finished, ...tasks119_final];
              o.archived = false;
              o.deleted = false;
            } else {
              o.archived = true;
              (o.tasks || []).forEach(t => { if (t.status === 'Pendiente') t.status = 'Finalizada'; });
            }
          }
        });

        console.log("=== PUSHING CLEAN 5 TASKS (06:00 AM TIMERS) TO RAILWAY ===");
        const o155 = db.workOrders.find(o => String(o.id) === '1784884919356');
        if (o155) {
          await pushToRailway(o155.id, o155);
          console.log("  ✅ Order 155 pushed to Railway!");
        }
        const o119 = db.workOrders.find(o => String(o.id) === '1785334094327');
        if (o119) {
          await pushToRailway(o119.id, o119);
          console.log("  ✅ Order 119 pushed to Railway!");
        }

        conn.sftp(async (sftpErr, sftp) => {
          if (sftpErr) return conn.end();

          console.log("=== DEPLOYING UPDATED CODE TO DEBIAN ===");
          await uploadFile(sftp, 'public/app.js', '/home/cbelocures/gestion/public/app.js');
          console.log("  ✅ Uploaded public/app.js to Debian!");

          await uploadFile(sftp, 'railway_sync_agent.js', '/home/cbelocures/gestion/railway_sync_agent.js');
          console.log("  ✅ Uploaded railway_sync_agent.js to Debian!");

          const tmp = './db_full_sync_fix_final.json';
          fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
          await uploadFile(sftp, tmp, '/home/cbelocures/data/db.json');
          fs.unlinkSync(tmp);
          console.log("  ✅ Uploaded persistent db.json to Debian!");

          await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
          await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
          console.log("  ✅ app-taxes.service restarted on Debian!");
          conn.end();
        });
      }).on('data', d => out += d);
    });
  }).connect(DEBIAN_CONFIG);
}

main().catch(console.error);
