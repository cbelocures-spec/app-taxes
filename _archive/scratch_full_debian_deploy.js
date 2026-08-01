const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

const config = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

function uploadFile(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const base = path.basename(localPath);
    console.log(`Uploading ${localPath} -> ${remotePath}...`);
    sftp.fastPut(localPath, remotePath, (err) => {
      if (err) {
        console.error(`  ❌ Error uploading ${base}:`, err.message);
        return reject(err);
      }
      console.log(`  ✅ ${base} uploaded.`);
      resolve();
    });
  });
}

function runCmd(conn, cmd) {
  return new Promise((resolve, reject) => {
    console.log(`\nExecuting SSH command: ${cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      stream.on('close', () => {
        resolve({ out, errOut });
      }).on('data', d => {
        const text = d.toString('utf8');
        out += text;
        process.stdout.write(text);
      }).stderr.on('data', d => {
        const text = d.toString('utf8');
        errOut += text;
        process.stderr.write(text);
      });
    });
  });
}

const conn = new Client();
conn.on('ready', async () => {
  console.log("=== CONNECTED TO DEBIAN LOCAL SERVER (192.168.50.4) ===");

  conn.sftp(async (err, sftp) => {
    if (err) {
      console.error("SFTP Error:", err.message);
      conn.end();
      return;
    }

    try {
      // 1. Upload Core App Files
      const filesToUpload = [
        { local: 'server.js', remote: '/home/cbelocures/gestion/server.js' },
        { local: 'database.js', remote: '/home/cbelocures/gestion/database.js' },
        { local: 'syncWorker.js', remote: '/home/cbelocures/gestion/syncWorker.js' },
        { local: 'railway_sync_agent.js', remote: '/home/cbelocures/gestion/railway_sync_agent.js' },
        { local: 'public/app.js', remote: '/home/cbelocures/gestion/public/app.js' },
        { local: 'public/index.html', remote: '/home/cbelocures/gestion/public/index.html' },
        { local: 'public/styles.css', remote: '/home/cbelocures/gestion/public/styles.css' }
      ];

      for (const item of filesToUpload) {
        if (fs.existsSync(item.local)) {
          await uploadFile(sftp, item.local, item.remote);
        }
      }

      // 2. Upload Auditor Files
      const auditorDir = '/home/cbelocures/gestion/auditor_externo';
      await runCmd(conn, `mkdir -p ${auditorDir}`);

      const auditorFiles = [
        { local: 'auditor_externo/main_gui.py', remote: `${auditorDir}/main_gui.py` },
        { local: 'auditor_externo/taxes_checker.py', remote: `${auditorDir}/taxes_checker.py` },
        { local: 'auditor_externo/auditor_db.py', remote: `${auditorDir}/auditor_db.py` },
        { local: 'auditor_externo/app_client.py', remote: `${auditorDir}/app_client.py` },
        { local: 'auditor_externo/config.json', remote: `${auditorDir}/config.json` }
      ];

      for (const item of auditorFiles) {
        if (fs.existsSync(item.local)) {
          await uploadFile(sftp, item.local, item.remote);
        }
      }

      sftp.end();

      // 3. Git pull (if git repo exists) & dependency check
      await runCmd(conn, 'cd /home/cbelocures/gestion && git fetch origin && git reset --hard origin/master || true');

      // 4. Reload and Restart Services
      console.log("\nReloading systemd services on Debian...");
      await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl daemon-reload');
      await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service || true');
      await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart railway-sync.service || true');

      // 5. Verify Service Status
      await new Promise(r => setTimeout(r, 3000));
      console.log("\n=== VERIFYING SYSTEMD SERVICE STATUS ===");
      await runCmd(conn, 'systemctl status app-taxes.service --no-pager -l || true');

    } catch (e) {
      console.error("Deployment Error:", e.message);
    } finally {
      conn.end();
    }
  });
}).on('error', err => {
  console.error("SSH Connection Error:", err.message);
}).connect(config);
