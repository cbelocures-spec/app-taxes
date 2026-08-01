const { Client } = require('ssh2');
const https = require('https');
const http = require('http');

const RAILWAY_HOST = 'app-taxes-production-ec67.up.railway.app';
const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

function getUrl(url, headers = {}) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const t0 = Date.now();
    lib.get(url, { headers }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const ms = Date.now() - t0;
        resolve({ status: res.statusCode, ms, body });
      });
    }).on('error', err => resolve({ status: 500, ms: Date.now() - t0, body: err.message }));
  });
}

function runCmd(conn, cmd) {
  return new Promise((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return resolve("Error: " + err.message);
      let out = '';
      stream.on('close', () => resolve(out)).on('data', d => out += d);
    });
  });
}

async function run() {
  console.log("=== 1. TESTING API RESPONSE SPEED ===");
  const debPerf = await getUrl('http://192.168.50.4/api/orders', { 'x-user-username': 'paniol@contenedoreshugo.com.ar' });
  console.log(`Debian GET /api/orders: ${debPerf.ms} ms (Status ${debPerf.status}, size ${debPerf.body.length})`);

  const rwPerf = await getUrl('https://app-taxes-production-ec67.up.railway.app/api/orders', { 'x-user-username': 'paniol@contenedoreshugo.com.ar' });
  console.log(`Railway GET /api/orders: ${rwPerf.ms} ms (Status ${rwPerf.status}, size ${rwPerf.body.length})`);

  console.log("\n=== 2. COMPARING ACTIVE ORDERS ON BOTH SERVERS ===");
  try {
    const debOrders = JSON.parse(debPerf.body);
    const rwOrders = JSON.parse(rwPerf.body);

    console.log(`Debian active orders: ${debOrders.length}`);
    debOrders.forEach(o => {
      console.log(`  Debian OT Interno ${o.interno} (${o.rodado}) - ID: ${o.id}:`);
      (o.tasks || []).forEach(t => console.log(`    Task: [${t.empleado}] - Status: ${t.status} - TimerStart: ${t.timerStart}`));
    });

    console.log(`\nRailway active orders: ${rwOrders.length}`);
    rwOrders.forEach(o => {
      console.log(`  Railway OT Interno ${o.interno} (${o.rodado}) - ID: ${o.id}:`);
      (o.tasks || []).forEach(t => console.log(`    Task: [${t.empleado}] - Status: ${t.status} - TimerStart: ${t.timerStart}`));
    });
  } catch(e) {
    console.error("Parse error:", e.message);
  }

  console.log("\n=== 3. INSPECTING DEBIAN CPU/RAM AND NODE PROCESSES ===");
  const conn = new Client();
  conn.on('ready', async () => {
    const topOut = await runCmd(conn, 'top -b -n 1 | head -n 25 || true');
    console.log("\n--- Top Processes ---\n" + topOut);

    const psOut = await runCmd(conn, 'ps aux | grep -E "node|chrome|puppeteer|python" || true');
    console.log("\n--- Running Puppeteer/Node/Python Processes ---\n" + psOut);

    conn.end();
  }).connect(DEBIAN_CONFIG);
}

run().catch(console.error);
