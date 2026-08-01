const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Client Ready');
  conn.sftp((err, sftp) => {
    if (err) throw err;
    console.log('Uploading db.json to /home/cbelocures/gestion/db.json ...');
    sftp.fastPut('db.json', '/home/cbelocures/gestion/db.json', (err) => {
      if (err) {
        console.error('Error uploading db.json:', err);
      } else {
        console.log('db.json uploaded successfully!');
      }
      conn.end();
    });
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
});
