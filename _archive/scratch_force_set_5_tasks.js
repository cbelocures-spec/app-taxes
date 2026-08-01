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

const tasks155 = [
  {
    id: `task-155-ojeda-1`,
    centroCosto: "15",
    empleado: "OJEDA FERNANDEZ JOSE ENRIQUE",
    horasEstimadas: 3.5,
    status: "Pendiente",
    descripcion: "desarme rueda derecha trasera revision rulemanes campana y cinta",
    timerStart: null,
    timerStarted: false,
    synced: false
  },
  {
    id: `task-155-perez-2`,
    centroCosto: "15",
    empleado: "PEREZ FACUNDO",
    horasEstimadas: 6.5,
    status: "Pendiente",
    descripcion: "pintar pisos con antioxidaaantes",
    timerStart: null,
    timerStarted: false,
    synced: false
  },
  {
    id: `task-155-rocha-3`,
    centroCosto: "15",
    empleado: "Rocha, Ariel Maximiliano",
    horasEstimadas: 6.5,
    status: "Pendiente",
    descripcion: "termina de pisos revision puertas y cabina",
    timerStart: null,
    timerStarted: false,
    synced: false
  }
];

const tasks119 = [
  {
    id: `task-119-morel-1`,
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
    id: `task-119-canaviri-2`,
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

function getOrder(id) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: RAILWAY_HOST,
      path: `/api/orders/all`,
      headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const list = JSON.parse(body);
          resolve(list.find(o => String(o.id) === String(id) || String(o.interno) === String(id)));
        } catch(e) { reject(e); }
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
  console.log("=== UPDATING ORDER 155 ON RAILWAY ===");
  const o155 = await getOrder('1784884919356');
  if (o155) {
    o155.tasks = tasks155;
    o155.archived = false;
    o155.deleted = false;
    o155.status = 'Pendiente';
    const res155 = await putOrder(o155.id, o155);
    console.log("Order 155 updated on Railway:", res155.substring(0, 150));
  }

  console.log("\n=== UPDATING ORDER 119 ON RAILWAY ===");
  const o119 = await getOrder('1784904402541');
  if (o119) {
    o119.tasks = tasks119;
    o119.archived = false;
    o119.deleted = false;
    o119.status = 'Pendiente';
    const res119 = await putOrder(o119.id, o119);
    console.log("Order 119 updated on Railway:", res119.substring(0, 150));
  }

  console.log("\n=== UPDATING LOCAL AND DEBIAN DB ===");
  if (fs.existsSync('db.json')) {
    const localData = JSON.parse(fs.readFileSync('db.json', 'utf8'));
    const l155 = (localData.workOrders || []).find(o => String(o.interno) === '155');
    if (l155) { l155.tasks = tasks155; l155.archived = false; l155.deleted = false; }
    const l119 = (localData.workOrders || []).find(o => String(o.interno) === '119');
    if (l119) { l119.tasks = tasks119; l119.archived = false; l119.deleted = false; }

    fs.writeFileSync('db.json', JSON.stringify(localData, null, 2), 'utf8');

    const tmpDbFile = './merged_db_exact_5.json';
    fs.writeFileSync(tmpDbFile, JSON.stringify(localData, null, 2), 'utf8');

    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return conn.end();
        sftp.fastPut(tmpDbFile, '/home/cbelocures/data/db.json', async (uploadErr) => {
          fs.unlinkSync(tmpDbFile);
          if (uploadErr) {
            console.error("SFTP error:", uploadErr.message);
            conn.end();
            return;
          }
          console.log("✅ Successfully updated /home/cbelocures/data/db.json on Debian!");
          await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
          await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
          console.log("✅ Restarted app-taxes.service on Debian!");
          conn.end();
        });
      });
    }).on('error', e => console.error("SSH error:", e.message)).connect(DEBIAN_CONFIG);
  }
}

main().catch(console.error);
