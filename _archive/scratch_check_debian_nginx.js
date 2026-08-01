const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log("Connected to 192.168.50.4 via SSH");
  conn.exec("sudo cat /etc/nginx/sites-enabled/* || true; systemctl status app-taxes.service || true", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== SSH OUTPUT FROM 192.168.50.4 ===");
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
