const { Client } = require('ssh2');
const https = require('https');
const path = require('path');
const fs = require('fs');

const RAILWAY_HOST = 'app-taxes-production-ec67.up.railway.app';
const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

function fetchFromRailway(path) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: RAILWAY_HOST,
      path: path,
      headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse Railway response: ${e.message}`));
        }
      });
    }).on('error', err => reject(err));
  });
}

function runCmd(conn, cmd) {
  return new Promise((resolve, reject) => {
    console.log(`\nExecuting SSH: ${cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      stream.on('close', () => resolve({ out, errOut }))
        .on('data', d => { out += d.toString(); process.stdout.write(d.toString()); })
        .stderr.on('data', d => { errOut += d.toString(); process.stderr.write(d.toString()); });
    });
  });
}

function uploadFile(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const base = path.basename(localPath);
    console.log(`Uploading ${localPath} -> ${remotePath}...`);
    sftp.fastPut(localPath, remotePath, (err) => {
      if (err) return reject(err);
      console.log(`  ✅ ${base} uploaded.`);
      resolve();
    });
  });
}

async function main() {
  console.log("=== STEP 1: FETCHING PERSISTENT ORDERS FROM RAILWAY ===");
  const railwayOrders = await fetchFromRailway('/api/orders/all');
  console.log(`Fetched ${Array.isArray(railwayOrders) ? railwayOrders.length : 0} orders from Railway.`);

  if (!Array.isArray(railwayOrders) || railwayOrders.length === 0) {
    console.error("❌ Railway orders list is empty or invalid. Aborting DB overwrite.");
    return;
  }

  const conn = new Client();
  conn.on('ready', async () => {
    console.log("\n=== STEP 2: CONNECTED TO DEBIAN SERVER ===");
    conn.sftp(async (err, sftp) => {
      if (err) {
        console.error("SFTP Error:", err.message);
        conn.end();
        return;
      }

      try {
        // Create persistent data directory
        await runCmd(conn, 'mkdir -p /home/cbelocures/data');

        // Upload updated code files (EXCLUDING db.json so it never gets overwritten in code directory)
        const codeFiles = [
          { local: 'server.js', remote: '/home/cbelocures/gestion/server.js' },
          { local: 'database.js', remote: '/home/cbelocures/gestion/database.js' },
          { local: 'syncWorker.js', remote: '/home/cbelocures/gestion/syncWorker.js' },
          { local: 'railway_sync_agent.js', remote: '/home/cbelocures/gestion/railway_sync_agent.js' },
          { local: 'public/app.js', remote: '/home/cbelocures/gestion/public/app.js' },
          { local: 'public/index.html', remote: '/home/cbelocures/gestion/public/index.html' },
          { local: 'public/styles.css', remote: '/home/cbelocures/gestion/public/styles.css' }
        ];

        for (const item of codeFiles) {
          if (fs.existsSync(item.local)) {
            await uploadFile(sftp, item.local, item.remote);
          }
        }

        // Prepare local merged DB file to upload to persistent directory `/home/cbelocures/data/db.json`
        const localDbContent = fs.existsSync('db.json') ? JSON.parse(fs.readFileSync('db.json', 'utf8')) : {};
        
        // Merge railway orders with local catalogs & users
        const mergedDb = {
          ...localDbContent,
          workOrders: railwayOrders
        };

        const tmpDbFile = path.join(__dirname, 'merged_db_for_debian.json');
        fs.writeFileSync(tmpDbFile, JSON.stringify(mergedDb, null, 2), 'utf8');

        console.log("\n=== STEP 3: UPLOADING MERGED PERSISTENT DATABASE TO DEBIAN ===");
        await uploadFile(sftp, tmpDbFile, '/home/cbelocures/data/db.json');
        fs.unlinkSync(tmpDbFile);

        // Also update /home/cbelocures/gestion/db.json as backup fallback
        await runCmd(conn, 'cp /home/cbelocures/data/db.json /home/cbelocures/gestion/db.json || true');

        sftp.end();

        // Update systemd service environment to use DB_PATH=/home/cbelocures/data/db.json
        console.log("\n=== STEP 4: RESTARTING SERVICES ON DEBIAN ===");
        await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl daemon-reload');
        await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service || true');
        await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart railway-sync.service || true');

        await new Promise(r => setTimeout(r, 4000));
        console.log("\n=== STEP 5: VERIFYING DEBIAN SERVICE LOGS ===");
        await runCmd(conn, 'journalctl -u app-taxes.service -n 30 --no-pager || true');

        console.log("\n✅ DEPLOYMENT AND DB SYNC COMPLETED SUCCESSFULLY.");
      } catch (e) {
        console.error("❌ Error during Debian deployment:", e.message);
      } finally {
        conn.end();
      }
    });
  }).on('error', err => {
    console.error("❌ SSH Error:", err.message);
  }).connect(DEBIAN_CONFIG);
}

main();
