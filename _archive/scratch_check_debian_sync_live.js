const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("journalctl -u app-taxes.service -n 40 --no-pager", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== DEBIAN 192.168.50.4 RECENT LOGS ===");
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
