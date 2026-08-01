const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('./syncWorker.js', '/home/cbelocures/gestion/syncWorker.js', (err2) => {
      if (err2) console.error("SFTP upload error:", err2);
      else console.log("✅ Successfully uploaded fixed syncWorker.js to 192.168.50.4!");

      conn.exec("echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service", (err3, stream) => {
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
  password: 'CesarHernan3550'
});
