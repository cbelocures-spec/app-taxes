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

const tasks119 = [
  {
    id: `task-119-morel-active`,
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
    id: `task-119-canaviri-active`,
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

function getOrders() {
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
  const orders = await getOrders();
  const o119 = orders.find(o => String(o.id) === '1785334094327' || String(o.interno) === '119');

  if (o119) {
    console.log(`Found Order 119 (ID: ${o119.id}). Setting 2 pending tasks...`);
    o119.tasks = tasks119;
    o119.archived = false;
    o119.deleted = false;
    o119.status = 'Pendiente';
    await putOrder(o119.id, o119);
  }

  const updatedOrders = await getOrders();

  console.log("\n=== ALL 5 ACTIVE PENDING TASKS ON RAILWAY ===");
  let count = 0;
  updatedOrders.forEach(o => {
    (o.tasks || []).forEach(t => {
      if ((t.status === 'Pendiente' || !t.status) && !o.archived && !o.deleted) {
        count++;
        console.log(`[#${count}] Interno ${o.interno} (${o.rodado}):`);
        console.log(`     Empleado: ${t.empleado}`);
        console.log(`     Descripcion: ${t.descripcion}`);
      }
    });
  });
  console.log(`TOTAL ACTIVE PENDING TASKS: ${count}`);

  // Sync to Debian persistent DB
  const localData = fs.existsSync('db.json') ? JSON.parse(fs.readFileSync('db.json', 'utf8')) : {};
  localData.workOrders = updatedOrders;
  fs.writeFileSync('db.json', JSON.stringify(localData, null, 2), 'utf8');

  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) return conn.end();
      const tmp = './merged_exact_5_final.json';
      fs.writeFileSync(tmp, JSON.stringify(localData, null, 2), 'utf8');
      sftp.fastPut(tmp, '/home/cbelocures/data/db.json', async (uploadErr) => {
        fs.unlinkSync(tmp);
        if (uploadErr) return conn.end();
        console.log("✅ Persistent db.json updated on Debian!");
        await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
        await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
        console.log("✅ Services restarted on Debian!");
        conn.end();
      });
    });
  }).on('error', e => console.error("SSH error:", e.message)).connect(DEBIAN_CONFIG);
}

main().catch(console.error);
