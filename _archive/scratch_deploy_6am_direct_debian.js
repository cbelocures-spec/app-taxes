const { Client } = require('ssh2');
const fs = require('fs');

const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

// 06:00 AM ART (UTC-3) for today 2026-07-31
const today6am = new Date();
today6am.setHours(6, 0, 0, 0);
const start6amMs = today6am.getTime();
console.log(`Setting timerStart to 06:00 AM ART: ${start6amMs} (${today6am.toLocaleTimeString('es-AR')})`);

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
  const localDb = fs.existsSync('db.json') ? JSON.parse(fs.readFileSync('db.json', 'utf8')) : { workOrders: [] };

  const clean3Tasks155 = [
    {
      id: "task-155-ojeda-6am-direct",
      centroCosto: "15",
      empleado: "OJEDA FERNANDEZ JOSE ENRIQUE",
      horasEstimadas: 3.5,
      status: "Pendiente",
      descripcion: "desarme rueda derecha trasera revision rulemanes campana y cinta",
      timerStart: start6amMs,
      timerStarted: true,
      timerHistory: [{ event: 'inició', timestamp: start6amMs }]
    },
    {
      id: "task-155-perez-6am-direct",
      centroCosto: "15",
      empleado: "PEREZ FACUNDO",
      horasEstimadas: 6.5,
      status: "Pendiente",
      descripcion: "pintar pisos con antioxidaaantes",
      timerStart: start6amMs,
      timerStarted: true,
      timerHistory: [{ event: 'inició', timestamp: start6amMs }]
    },
    {
      id: "task-155-rocha-6am-direct",
      centroCosto: "15",
      empleado: "Rocha, Ariel Maximiliano",
      horasEstimadas: 6.5,
      status: "Pendiente",
      descripcion: "termina de pisos revision puertas y cabina",
      timerStart: start6amMs,
      timerStarted: true,
      timerHistory: [{ event: 'inició', timestamp: start6amMs }]
    }
  ];

  const clean2Tasks119 = [
    {
      id: "task-119-morel-6am-direct",
      centroCosto: "15",
      empleado: "Morel, Luis Maximiliano",
      horasEstimadas: 4.5,
      status: "Pendiente",
      descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
      timerStart: start6amMs,
      timerStarted: true,
      timerHistory: [{ event: 'inició', timestamp: start6amMs }]
    },
    {
      id: "task-119-canaviri-6am-direct",
      centroCosto: "15",
      empleado: "Canaviri Fernandez, Jesús",
      horasEstimadas: 4.5,
      status: "Pendiente",
      descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
      timerStart: start6amMs,
      timerStarted: true,
      timerHistory: [{ event: 'inició', timestamp: start6amMs }]
    }
  ];

  (localDb.workOrders || []).forEach(o => {
    if (String(o.interno) === '155') {
      if (String(o.id) === '1784884919356') {
        const finished = (o.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('6am'));
        o.tasks = [...finished, ...clean3Tasks155];
        o.archived = false;
        o.deleted = false;
      } else {
        o.archived = true;
      }
    }

    if (String(o.interno) === '119') {
      if (String(o.id) === '1785334094327') {
        const finished = (o.tasks || []).filter(t => t.status === 'Finalizada' && !t.id.includes('6am'));
        o.tasks = [...finished, ...clean2Tasks119];
        o.archived = false;
        o.deleted = false;
      } else {
        o.archived = true;
      }
    }
  });

  fs.writeFileSync('db.json', JSON.stringify(localDb, null, 2), 'utf8');

  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp(async (err, sftp) => {
      if (err) return conn.end();

      console.log("=== DEPLOYING DIRECTLY TO DEBIAN ===");
      await uploadFile(sftp, 'public/app.js', '/home/cbelocures/gestion/public/app.js');
      console.log("✅ Uploaded public/app.js to Debian!");

      const tmp = './db_debian_direct_6am.json';
      fs.writeFileSync(tmp, JSON.stringify(localDb, null, 2), 'utf8');
      await uploadFile(sftp, tmp, '/home/cbelocures/data/db.json');
      fs.unlinkSync(tmp);
      console.log("✅ Uploaded persistent db.json with 06:00 AM timerStart to Debian!");

      await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
      await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
      console.log("✅ app-taxes.service restarted on Debian!");
      conn.end();
    });
  }).on('error', e => console.error("SSH error:", e.message)).connect(DEBIAN_CONFIG);
}

main().catch(console.error);
