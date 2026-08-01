const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) {
      console.error("SFTP error:", err.message);
      return conn.end();
    }
    sftp.fastPut('public/app.js', '/home/cbelocures/gestion/public/app.js', (putErr) => {
      if (putErr) console.error("SFTP upload error:", putErr.message);
      else console.log("✅ Successfully uploaded public/app.js to 192.168.50.4");
      conn.end();
    });
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
});
