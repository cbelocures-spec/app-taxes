const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("journalctl -u app-taxes.service -n 60 --no-pager | grep -i -E 'verify|control|error|fail' || true", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== VERIFIER / CONTROL LOGS ON 192.168.50.4 ===");
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
