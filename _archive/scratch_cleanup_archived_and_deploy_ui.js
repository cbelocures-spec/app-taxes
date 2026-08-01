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

const clean3Tasks155 = [
  {
    id: "task-155-ojeda-target",
    centroCosto: "15",
    empleado: "OJEDA FERNANDEZ JOSE ENRIQUE",
    horasEstimadas: 3.5,
    status: "Pendiente",
    descripcion: "desarme rueda derecha trasera revision rulemanes campana y cinta",
    timerStart: null,
    timerStarted: false
  },
  {
    id: "task-155-perez-target",
    centroCosto: "15",
    empleado: "PEREZ FACUNDO",
    horasEstimadas: 6.5,
    status: "Pendiente",
    descripcion: "pintar pisos con antioxidaaantes",
    timerStart: null,
    timerStarted: false
  },
  {
    id: "task-155-rocha-target",
    centroCosto: "15",
    empleado: "Rocha, Ariel Maximiliano",
    horasEstimadas: 6.5,
    status: "Pendiente",
    descripcion: "termina de pisos revision puertas y cabina",
    timerStart: null,
    timerStarted: false
  }
];

const clean2Tasks119 = [
  {
    id: "task-119-morel-target",
    centroCosto: "15",
    empleado: "Morel, Luis Maximiliano",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: null,
    timerStarted: false
  },
  {
    id: "task-119-canaviri-target",
    centroCosto: "15",
    empleado: "Canaviri Fernandez, Jesús",
    horasEstimadas: 4.5,
    status: "Pendiente",
    descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
    timerStart: null,
    timerStarted: false
  }
];

function getOrders() {
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

function putOrder(id, data) {
  return new Promise((resolve) => {
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
    req.on('error', err => resolve({ error: err.message }));
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

async function main() {
  console.log("=== STEP 1: CLEANING DUPES AND ARCHIVING HISTORICAL ORDERS ===");
  const orders = await getOrders();

  for (const o of orders) {
    let modified = false;

    if (String(o.interno) === '155') {
      if (String(o.id) === '1784884919356') {
        const finished = (o.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('target'));
        o.tasks = [...finished, ...clean3Tasks155];
        o.archived = false;
        o.deleted = false;
      } else {
        // Archive duplicate historical orders of 155
        o.archived = true;
      }
      modified = true;
    }

    if (String(o.interno) === '119') {
      if (String(o.id) === '1785334094327') {
        const finished = (o.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('target'));
        o.tasks = [...finished, ...clean2Tasks119];
        o.archived = false;
        o.deleted = false;
      } else {
        // Archive duplicate historical orders of 119
        o.archived = true;
      }
      modified = true;
    }

    if (modified) {
      await putOrder(o.id, o);
    }
  }

  const updatedOrders = await getOrders();

  console.log("\n=== STEP 2: DEPLOYING UPDATED app.js AND PERSISTENT DB TO DEBIAN ===");
  const localDb = fs.existsSync('db.json') ? JSON.parse(fs.readFileSync('db.json', 'utf8')) : {};
  localDb.workOrders = updatedOrders;
  fs.writeFileSync('db.json', JSON.stringify(localDb, null, 2), 'utf8');

  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp(async (err, sftp) => {
      if (err) return conn.end();

      // Upload updated public/app.js
      await uploadFile(sftp, 'public/app.js', '/home/cbelocures/gestion/public/app.js');
      console.log("  ✅ Uploaded updated public/app.js to Debian!");

      // Upload persistent db.json
      const tmp = './db_clean_ui.json';
      fs.writeFileSync(tmp, JSON.stringify(localDb, null, 2), 'utf8');
      await uploadFile(sftp, tmp, '/home/cbelocures/data/db.json');
      fs.unlinkSync(tmp);
      console.log("  ✅ Uploaded clean persistent db.json to Debian!");

      await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
      await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
      console.log("  ✅ Restarted app-taxes.service on Debian!");
      conn.end();
    });
  }).on('error', e => console.error("SSH error:", e.message)).connect(DEBIAN_CONFIG);
}

main().catch(console.error);
