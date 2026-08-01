const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("systemctl is-active nginx; ss -tulpn | grep :80", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== NGINX ACTIVE & PORT 80 CHECK ===");
      console.log(out);
      conn.end();
    });
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
});
