const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('./db.json', '/home/cbelocures/data/db.json', (err1) => {
      sftp.fastPut('./auditor_externo/app_client.py', '/home/cbelocures/gestion/auditor_externo/app_client.py', (err2) => {
        console.log("✅ Uploaded updated db.json and app_client.py to 192.168.50.4!");
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
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
});
