const { Client } = require('ssh2');

const conn = new Client();
const config = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('close', () => resolve(out))
        .on('data', d => { out += d; process.stdout.write(d); })
        .stderr.on('data', d => process.stderr.write(d));
    });
  });
}

conn.on('ready', async () => {
  try {
    console.log('Installing npm dependencies in /home/cbelocures/gestion ...');
    await runCmd('cd /home/cbelocures/gestion && npm install bcryptjs express cors node-fetch dotenv');

    console.log('\nRestarting app-taxes.service ...');
    await runCmd('echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');

    await new Promise(r => setTimeout(r, 3000));
    console.log('\nChecking service status ...');
    await runCmd('echo CesarHernan3550 | sudo -S systemctl status app-taxes.service --no-pager');
  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    conn.end();
  }
}).on('error', err => console.error('SSH error:', err.message)).connect(config);
