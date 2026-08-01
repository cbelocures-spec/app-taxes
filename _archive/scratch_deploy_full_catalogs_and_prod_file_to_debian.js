const { Client } = require('ssh2');
const fs = require('fs');

const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

const fullCatalogs = JSON.parse(fs.readFileSync('prod_catalogs.json', 'utf8'));

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
        let db = { workOrders: [], catalogs: {} };
        try { db = JSON.parse(out); } catch(e) {}

        db.catalogs = fullCatalogs;

        conn.sftp(async (sftpErr, sftp) => {
          if (sftpErr) return conn.end();

          console.log("=== UPLOADING PROD_CATALOGS.JSON AND SYNCWORKER.JS TO DEBIAN ===");
          await uploadFile(sftp, 'prod_catalogs.json', '/home/cbelocures/gestion/prod_catalogs.json');
          console.log("  ✅ Uploaded prod_catalogs.json!");

          await uploadFile(sftp, 'syncWorker.js', '/home/cbelocures/gestion/syncWorker.js');
          console.log("  ✅ Uploaded syncWorker.js!");

          const tmp = './db_full_167_rodados.json';
          fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
          await uploadFile(sftp, tmp, '/home/cbelocures/data/db.json');
          fs.unlinkSync(tmp);
          console.log("  ✅ Uploaded persistent db.json with 167 rodados!");

          await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
          await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
          console.log("✅ Service restarted on Debian!");
          conn.end();
        });
      }).on('data', d => out += d);
    });
  }).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
