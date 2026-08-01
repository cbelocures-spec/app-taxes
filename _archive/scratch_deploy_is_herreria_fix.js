const { execSync } = require('child_process');
const { Client } = require('ssh2');

console.log("Committing and pushing isHerreriaOrder fix to Railway...");
try {
  execSync('git add public/app.js', { stdio: 'inherit' });
  execSync('git commit -m "Fix isHerreriaOrder filtering in app.js so Taller orders with volquete/roll-off in interno never disappear"', { stdio: 'inherit' });
  execSync('git push origin master', { stdio: 'inherit' });
  console.log("✅ Successfully pushed app.js fix to Railway!");
} catch (e) {
  console.error("Git error:", e.message);
}

// Upload to 192.168.50.4 via SSH
const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('./public/app.js', '/home/cbelocures/gestion/public/app.js', (err1) => {
      console.log("✅ Uploaded public/app.js to 192.168.50.4!");
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
