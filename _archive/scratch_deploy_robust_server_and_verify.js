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

      console.log("=== DEPLOYING ROBUST CRASH-PROOF SERVER.JS TO DEBIAN ===");
      await uploadFile(sftp, 'server.js', '/home/cbelocures/gestion/server.js');
      console.log("  ✅ Uploaded crash-proof server.js!");

      await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
      console.log("✅ app-taxes.service restarted on Debian!");

      await new Promise(r => setTimeout(r, 3000));

      const status = await runCmd(conn, 'systemctl status app-taxes.service || true');
      console.log("\n--- Systemctl Status ---\n" + status);

      const netstat = await runCmd(conn, 'ss -tulpn | grep 3000 || true');
      console.log("\n--- Listener on Port 3000 ---\n" + netstat);

      conn.end();
    });
  }).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
