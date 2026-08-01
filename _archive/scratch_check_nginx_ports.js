const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("echo CesarHernan3550 | sudo -S cat /etc/nginx/sites-available/* || true; ss -tulpn | grep -E 'node|nginx|3000|80'", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== NGINX SITES & PORTS ON 192.168.50.4 ===");
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
