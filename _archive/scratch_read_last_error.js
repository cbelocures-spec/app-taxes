const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("cat /home/cbelocures/gestion/last_error.log", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== LAST ERROR LOG ON DEBIAN ===");
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
