const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) {
      console.error("SFTP error:", err.message);
      return conn.end();
    }
    sftp.fastPut('server.js', '/home/cbelocures/gestion/server.js', (err1) => {
      if (err1) console.error("SFTP server.js error:", err1.message);
      else console.log("✅ Successfully uploaded server.js to 192.168.50.4");
      sftp.fastPut('auditor_externo/app_client.py', '/home/cbelocures/gestion/auditor_externo/app_client.py', (err2) => {
        if (err2) console.error("SFTP app_client.py error:", err2.message);
        else console.log("✅ Successfully uploaded auditor_externo/app_client.py to 192.168.50.4");
        conn.end();
      });
    });
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
});
