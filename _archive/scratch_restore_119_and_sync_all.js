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

const tasks119Pending = [
  {
    id: `task-119-morel-${Date.now()}`,
    centroCosto: "15",
    empleado: "Morel, Luis Maximiliano",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: null,
    timerStarted: false,
    synced: false
  },
  {
    id: `task-119-canaviri-${Date.now()}`,
    centroCosto: "15",
    empleado: "Canaviri Fernandez, Jesús",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: null,
    timerStarted: false,
    synced: false
  }
];

function getRailwayOrders() {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: RAILWAY_HOST,
      path: '/api/orders/all',
      headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function putOrder(id, data) {
  return new Promise((resolve, reject) => {
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
    req.on('error', reject);
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

async function main() {
  const orders = await getRailwayOrders();
  const o119s = orders.filter(o => String(o.interno) === '119');

  for (const o119 of o119s) {
    console.log(`Setting pending tasks for Order 119 (ID: ${o119.id})...`);
    o119.tasks = [...(o119.tasks || []).filter(t => t.status === 'Finalizada'), ...tasks119Pending];
    o119.archived = false;
    o119.deleted = false;
    o119.status = 'Pendiente';
    await putOrder(o119.id, o119);
  }

  // Refetch to get final updated Railway DB state
  const updatedOrders = await getRailwayOrders();

  console.log("\n=== SUMMARY OF 5 PENDING TASKS ON RAILWAY ===");
  let count = 0;
  updatedOrders.forEach(o => {
    (o.tasks || []).forEach(t => {
      if (t.status === 'Pendiente') {
        count++;
        console.log(`- OT Interno ${o.interno}: [${t.empleado}] ${t.descripcion}`);
      }
    });
  });
  console.log(`Total active pending tasks found: ${count}`);

  // Now sync complete database to Debian persistent directory /home/cbelocures/data/db.json
  const localData = fs.existsSync('db.json') ? JSON.parse(fs.readFileSync('db.json', 'utf8')) : {};
  localData.workOrders = updatedOrders;
  fs.writeFileSync('db.json', JSON.stringify(localData, null, 2), 'utf8');

  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) return conn.end();
      const tmp = './merged_db_5tasks_final.json';
      fs.writeFileSync(tmp, JSON.stringify(localData, null, 2), 'utf8');
      sftp.fastPut(tmp, '/home/cbelocures/data/db.json', async (uploadErr) => {
        fs.unlinkSync(tmp);
        if (uploadErr) {
          console.error("SFTP Upload Error:", uploadErr.message);
          conn.end();
          return;
        }
        console.log("✅ Successfully updated persistent db.json on Debian!");
        await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
        await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
        console.log("✅ Restarted app-taxes.service on Debian!");
        conn.end();
      });
    });
  }).on('error', e => console.error("SSH error:", e.message)).connect(DEBIAN_CONFIG);
}

main().catch(console.error);
