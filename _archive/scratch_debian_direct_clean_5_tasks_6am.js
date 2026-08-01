const { Client } = require('ssh2');
const fs = require('fs');

const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

const today6am = new Date();
today6am.setHours(6, 0, 0, 0);
const start6amMs = today6am.getTime();
console.log(`Setting timerStart to 06:00 AM ART: ${start6amMs}`);

const tasks155_target = [
  {
    id: "task-155-ojeda-6am-clean",
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
    id: "task-155-perez-6am-clean",
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
    id: "task-155-rocha-6am-clean",
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

const tasks119_target = [
  {
    id: "task-119-morel-6am-clean",
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
    id: "task-119-canaviri-6am-clean",
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

function runCmd(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('close', () => resolve(out)).on('data', d => out += d);
    });
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
            o.tasks = [...finished, ...tasks155_target];
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
            o.tasks = [...finished, ...tasks119_target];
            o.archived = false;
            o.deleted = false;
          } else {
            o.archived = true;
            (o.tasks || []).forEach(t => { if (t.status === 'Pendiente') t.status = 'Finalizada'; });
          }
        }
      });

      console.log("=== FINAL CLEAN DB CREATED WITH 5 ACTIVE 06:00 AM TASKS ===");
      let count = 0;
      (db.workOrders || []).forEach(o => {
        if (!o.archived && !o.deleted) {
          (o.tasks || []).forEach(t => {
            if (t.status === 'Pendiente' || !t.status) {
              count++;
              console.log(`[#${count}] OT Interno ${o.interno}: ${t.empleado} - TimerStart: ${t.timerStart}`);
            }
          });
        }
      });
      console.log(`TOTAL ACTIVE TASKS: ${count}`);

      conn.sftp(async (sftpErr, sftp) => {
        if (sftpErr) return conn.end();

        await uploadFile(sftp, 'public/app.js', '/home/cbelocures/gestion/public/app.js');
        console.log("✅ Uploaded public/app.js to Debian!");

        const tmp = './db_debian_clean_6am.json';
        fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
        await uploadFile(sftp, tmp, '/home/cbelocures/data/db.json');
        fs.unlinkSync(tmp);
        console.log("✅ Uploaded persistent db.json to Debian!");

        await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
        await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
        console.log("✅ app-taxes.service restarted on Debian!");
        conn.end();
      });
    }).on('data', d => out += d);
  });
}).connect(DEBIAN_CONFIG);
