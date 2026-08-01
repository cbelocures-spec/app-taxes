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
console.log(`Setting clean 06:00 AM timerStart: ${start6amMs}`);

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

const conn = new Client();
conn.on('ready', () => {
  conn.exec('cat /home/cbelocures/data/db.json', async (err, stream) => {
    let out = '';
    stream.on('close', async () => {
      let db = { workOrders: [] };
      try { db = JSON.parse(out); } catch(e) {}

      (db.workOrders || []).forEach(o => {
        if (!o.archived && !o.deleted) {
          (o.tasks || []).forEach(t => {
            if (t.status === 'Pendiente' || !t.status) {
              t.timerStart = start6amMs;
              t.timerStarted = true;
              t.timerHistory = []; // Clear conflicting events so 06:00 AM timer is strictly used
            }
          });
        }
      });

      conn.sftp(async (sftpErr, sftp) => {
        if (sftpErr) return conn.end();

        console.log("=== DEPLOYING FIXED app.js AND CLEAN 06:00 AM DB TO DEBIAN ===");
        await uploadFile(sftp, 'public/app.js', '/home/cbelocures/gestion/public/app.js');
        console.log("✅ Uploaded updated public/app.js to Debian!");

        const tmp = './db_6am_timer_clean_final.json';
        fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
        await uploadFile(sftp, tmp, '/home/cbelocures/data/db.json');
        fs.unlinkSync(tmp);
        console.log("✅ Uploaded persistent db.json with clean 06:00 AM timerStart to Debian!");

        await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
        await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
        console.log("✅ app-taxes.service restarted on Debian!");
        conn.end();
      });
    }).on('data', d => out += d);
  });
}).connect(DEBIAN_CONFIG);
