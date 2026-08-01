const { Client } = require('ssh2');

const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

function runCmd(conn, cmd) {
  return new Promise((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return resolve("Error: " + err.message);
      let out = '';
      stream.on('close', () => resolve(out)).on('data', d => out += d);
    });
  });
}

const conn = new Client();
conn.on('ready', async () => {
  const gitStatus = await runCmd(conn, 'cd /home/cbelocures/gestion && git status || true');
  console.log("--- Git Status on Debian ---\n" + gitStatus);

  const gitRemotes = await runCmd(conn, 'cd /home/cbelocures/gestion && git remote -v || true');
  console.log("\n--- Git Remotes on Debian ---\n" + gitRemotes);

  conn.end();
}).connect(DEBIAN_CONFIG);
