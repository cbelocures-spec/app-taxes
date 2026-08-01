const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log("=== SSH RECENT LOGS ON 192.168.50.4 ===");
  conn.exec('journalctl -u app-taxes.service -n 25 --no-pager', (err, stream) => {
    if (err) return conn.end();
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
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
