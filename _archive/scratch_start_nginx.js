const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("echo CesarHernan3550 | sudo -S systemctl start nginx && sudo systemctl status nginx", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== NGINX START RESULT ===");
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
