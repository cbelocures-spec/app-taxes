const { Client } = require('ssh2');
const https = require('https');
const http = require('http');
const fs = require('fs');

const RAILWAY_HOST = 'app-taxes-production-ec67.up.railway.app';
const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

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
  conn.on('ready', async () => {
    console.log("=== KILLING STRAY PROCESSES AND DEPLOYING FIXED SERVER.JS ===");
    await runCmd(conn, 'pkill -9 -f "server.js" || true');

    conn.sftp(async (sftpErr, sftp) => {
      if (sftpErr) return conn.end();

      await uploadFile(sftp, 'server.js', '/home/cbelocures/gestion/server.js');
      console.log("  ✅ Uploaded server.js!");

      await uploadFile(sftp, 'railway_sync_agent.js', '/home/cbelocures/gestion/railway_sync_agent.js');
      console.log("  ✅ Uploaded railway_sync_agent.js!");

      await uploadFile(sftp, 'public/app.js', '/home/cbelocures/gestion/public/app.js');
      console.log("  ✅ Uploaded public/app.js!");

      await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
      console.log("✅ app-taxes.service restarted on Debian!");

      // Wait 4 seconds for sync agent to complete first 3-second cycle
      await new Promise(r => setTimeout(r, 4000));

      const psCheck = await runCmd(conn, 'ps aux | grep node || true');
      console.log("\n--- Active Node Processes ---\n" + psCheck);

      const logs = await runCmd(conn, 'journalctl -u app-taxes.service -n 25 --no-pager || true');
      console.log("\n--- Systemd Service Logs ---\n" + logs);

      conn.end();
    });
  }).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
