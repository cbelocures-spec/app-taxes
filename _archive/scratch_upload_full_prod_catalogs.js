const fs = require('fs');
const https = require('https');
const { Client } = require('ssh2');

const RAILWAY_HOST = 'app-taxes-production-ec67.up.railway.app';
const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

const fullCatalogs = JSON.parse(fs.readFileSync('prod_catalogs.json', 'utf8'));

console.log(`Loaded full prod_catalogs.json:`);
console.log(`  Rodados: ${fullCatalogs.rodados ? fullCatalogs.rodados.length : 0}`);
console.log(`  Responsables: ${fullCatalogs.responsables ? fullCatalogs.responsables.length : 0}`);
console.log(`  Empleados: ${fullCatalogs.empleados ? fullCatalogs.empleados.length : 0}`);

function pushCatalogsToRailway(catalogs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(catalogs);
    const req = https.request({
      hostname: RAILWAY_HOST,
      path: '/api/catalogs/update',
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
  console.log("=== STEP 1: PUSHING FULL CATALOGS TO RAILWAY ===");
  const rwRes = await pushCatalogsToRailway(fullCatalogs);
  console.log("  Railway response:", rwRes);

  console.log("=== STEP 2: SAVING FULL CATALOGS TO DEBIAN PERSISTENT DB ===");
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

          const tmp = './db_full_catalogs.json';
          fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
          await sftp.fastPut(tmp, '/home/cbelocures/data/db.json');
          fs.unlinkSync(tmp);

          await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');
          await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
          console.log("✅ Updated full catalogs (100+ rodados) on Debian persistent DB & restarted service!");
          conn.end();
        });
      }).on('data', d => out += d);
    });
  }).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
