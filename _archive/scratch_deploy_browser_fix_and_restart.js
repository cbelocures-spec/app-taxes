const { Client } = require('ssh2');

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
  conn.on('ready', () => {
    conn.sftp(async (err, sftp) => {
      if (err) return conn.end();

      console.log("=== DEPLOYING PUPPETEER CHROMIUM BROWSER FIX TO DEBIAN ===");
      await uploadFile(sftp, 'syncWorker.js', '/home/cbelocures/gestion/syncWorker.js');
      console.log("  ✅ Uploaded syncWorker.js!");

      await uploadFile(sftp, 'server.js', '/home/cbelocures/gestion/server.js');
      console.log("  ✅ Uploaded server.js!");

      await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
      console.log("✅ app-taxes.service restarted on Debian!");

      await new Promise(r => setTimeout(r, 2000));

      const status = await runCmd(conn, 'systemctl status app-taxes.service || true');
      console.log("\n--- Service Status ---\n" + status);

      // Trigger a test retry of order FORD F100 (id or active order)
      const retryResult = await runCmd(conn, 'curl -s -X POST http://localhost:3000/api/orders/retry/326 -H "x-user-username: paniol@contenedoreshugo.com.ar" || true');
      console.log("\n--- Test Retry Request Output ---\n" + retryResult);

      conn.end();
    });
  }).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
