const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("cd /home/cbelocures/gestion && git pull origin master && echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== GIT PULL AND RESTART ON 192.168.50.4 ===");
      console.log(out);
      conn.end();
    });
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550',
  readyTimeout: 30000
});
