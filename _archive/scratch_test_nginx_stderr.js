const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("echo CesarHernan3550 | sudo -S nginx -t 2>&1", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== NGINX TEST STDERR OUTPUT ===");
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
