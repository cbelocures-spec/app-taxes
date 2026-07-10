const { Client } = require('ssh2');

const conn = new Client();
const config = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

function uploadFile(localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const path = require('path');
      const base = path.basename(localPath);
      console.log(`Uploading ${base} -> ${remotePath}`);
      sftp.fastPut(localPath, remotePath, (err) => {
        sftp.end();
        if (err) return reject(err);
        console.log(`  OK.`);
        resolve();
      });
    });
  });
}

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
    await uploadFile('server.js', '/home/cbelocures/gestion/server.js');
    await uploadFile('database.js', '/home/cbelocures/gestion/database.js');
    await uploadFile('syncWorker.js', '/home/cbelocures/gestion/syncWorker.js');
    await uploadFile('public/app.js', '/home/cbelocures/gestion/public/app.js');
    await runCmd('echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
    await new Promise(r => setTimeout(r, 3000));
    await runCmd('systemctl status app-taxes.service --no-pager -l');
  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    conn.end();
  }
}).on('error', err => console.error('SSH error:', err.message)).connect(config);
