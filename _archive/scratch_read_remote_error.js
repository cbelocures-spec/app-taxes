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
    console.log('=== Checking /home/cbelocures/gestion/last_error.log ===');
    await runCmd('cat /home/cbelocures/gestion/last_error.log');
  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    conn.end();
  }
}).on('error', err => console.error('SSH error:', err.message)).connect(config);
