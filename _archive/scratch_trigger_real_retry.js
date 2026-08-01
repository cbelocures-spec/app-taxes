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
  const getOrders = await runCmd(conn, 'curl -s http://localhost:3000/api/orders || true');
  let orders = [];
  try { orders = JSON.parse(getOrders); } catch(e) {}

  if (orders.length > 0) {
    const target = orders[0];
    console.log(`Triggering retry for Order ID ${target.id} (Interno ${target.interno})...`);
    const retryRes = await runCmd(conn, `curl -s -X POST http://localhost:3000/api/orders/retry/${target.id} -H "x-user-username: paniol@contenedoreshugo.com.ar" || true`);
    console.log("Retry response:", retryRes);

    await new Promise(r => setTimeout(r, 4000));

    const logs = await runCmd(conn, 'journalctl -u app-taxes.service -n 25 --no-pager || true');
    console.log("\n--- Journalctl Output ---\n" + logs);
  } else {
    console.log("No active orders found to retry.");
  }
  conn.end();
}).connect(DEBIAN_CONFIG);
