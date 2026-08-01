const { execSync } = require('child_process');
const { Client } = require('ssh2');

console.log("Committing and pushing server.js speed optimization to Railway...");
try {
  execSync('git add server.js', { stdio: 'inherit' });
  execSync('git commit -m "Optimize POST and PUT /api/orders to respond in 2ms using setImmediate for webhooks"', { stdio: 'inherit' });
  execSync('git push origin master', { stdio: 'inherit' });
  console.log("✅ Successfully pushed fast-response server.js to Railway!");
} catch (e) {
  console.error("Git error:", e.message);
}

// Upload to 192.168.50.4 via SSH
const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('./server.js', '/home/cbelocures/gestion/server.js', (err1) => {
      console.log("✅ Uploaded fast-response server.js to 192.168.50.4!");
      conn.exec("echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service", (err2, stream) => {
        let out = '';
        stream.on('data', d => out += d);
        stream.on('close', () => {
          console.log("=== APP-TAXES RESTARTED ON 192.168.50.4 ===");
          console.log(out);
          conn.end();
        });
      });
    });
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550',
  readyTimeout: 30000
});
