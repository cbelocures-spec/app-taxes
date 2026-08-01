const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("cd /home/cbelocures/gestion && node test_active_login.js", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== TAXES LOGIN TEST DIRECT OUTPUT ===");
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
