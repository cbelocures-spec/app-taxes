const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("curl -v http://127.0.0.1:80 2>&1 | head -n 30", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== CURL HTTP://127.0.0.1:80 RESULT ===");
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
