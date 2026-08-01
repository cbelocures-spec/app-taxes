const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log("✅ SSH Connected to 192.168.50.4!");
  conn.exec("echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== APP-TAXES RESTART OUTPUT ===");
      console.log(out);

      // Verify running git commit on 192.168.50.4
      conn.exec("cd /home/cbelocures/gestion && git log -n 1 --oneline", (err2, stream2) => {
        let out2 = '';
        stream2.on('data', d => out2 += d);
        stream2.on('close', () => {
          console.log("=== ACTIVE GIT COMMIT ON DEBIAN ===");
          console.log(out2);
          conn.end();
        });
      });
    });
  });
}).on('error', (err) => {
  console.error("SSH error:", err.message);
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550',
  readyTimeout: 30000
});
