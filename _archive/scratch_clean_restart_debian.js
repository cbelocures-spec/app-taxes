const { Client } = require('ssh2');

const config = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

function runCmd(conn, cmd) {
  return new Promise((resolve, reject) => {
    console.log(`Executing SSH: ${cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      stream.on('close', () => resolve({ out, errOut }))
        .on('data', d => { out += d.toString(); process.stdout.write(d.toString()); })
        .stderr.on('data', d => { errOut += d.toString(); process.stderr.write(d.toString()); });
    });
  });
}

const conn = new Client();
conn.on('ready', async () => {
  try {
    console.log("=== KILLING OLD NODE PROCESSES ON DEBIAN ===");
    await runCmd(conn, 'echo CesarHernan3550 | sudo -S pkill -9 -f node || true');
    await new Promise(r => setTimeout(r, 2000));
    
    console.log("=== RESTARTING APP-TAXES SERVICE ON DEBIAN ===");
    await runCmd(conn, 'echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service');
    
    await new Promise(r => setTimeout(r, 3000));
    console.log("=== CHECKING JOURNAL LOGS ===");
    await runCmd(conn, 'journalctl -u app-taxes.service -n 25 --no-pager');
  } catch (e) {
    console.error("Error:", e.message);
  } finally {
    conn.end();
  }
}).on('error', err => console.error("SSH error:", err.message)).connect(config);
