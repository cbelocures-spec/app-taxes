const https = require('https');
const http = require('http');

function getUrl(url, headers = {}) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', err => resolve({ status: 500, body: err.message }));
  });
}

async function compare() {
  console.log("=== COMPARING RAILWAY VS DEBIAN SERVER ===");

  const rwAppJs = await getUrl('https://app-taxes-production-ec67.up.railway.app/app.js');
  const debAppJs = await getUrl('http://192.168.50.4/app.js');

  console.log(`\n1. app.js Size:`);
  console.log(`   Railway: ${rwAppJs.body.length} bytes`);
  console.log(`   Debian:  ${debAppJs.body.length} bytes`);

  const rwOrders = await getUrl('https://app-taxes-production-ec67.up.railway.app/api/orders/all', { 'x-user-username': 'paniol@contenedoreshugo.com.ar' });
  const debOrders = await getUrl('http://192.168.50.4/api/orders/all', { 'x-user-username': 'paniol@contenedoreshugo.com.ar' });

  console.log(`\n2. /api/orders/all Status & Size:`);
  console.log(`   Railway: status ${rwOrders.status}, size ${rwOrders.body.length} bytes`);
  console.log(`   Debian:  status ${debOrders.status}, size ${debOrders.body.length} bytes`);

  try {
    const rwObj = JSON.parse(rwOrders.body);
    const debObj = JSON.parse(debOrders.body);

    console.log(`\n3. Total Work Orders Count:`);
    console.log(`   Railway: ${rwObj.length} orders`);
    console.log(`   Debian:  ${debObj.length} orders`);

    console.log("\n4. Active Orders Check (Non-Archived, Non-Deleted):");
    const rwActive = rwObj.filter(o => !o.archived && !o.deleted);
    const debActive = debObj.filter(o => !o.archived && !o.deleted);
    console.log(`   Railway active orders: ${rwActive.length}`);
    console.log(`   Debian active orders:  ${debActive.length}`);

    console.log("\n5. Active Tasks Comparison:");
    console.log("   --- RAILWAY ACTIVE TASKS ---");
    rwActive.forEach(o => {
      (o.tasks || []).forEach(t => {
        if (t.status === 'Pendiente' || !t.status) {
          console.log(`   OT Interno ${o.interno} (${o.rodado}): [${t.empleado}] - TimerStart: ${t.timerStart} - Desc: ${t.descripcion}`);
        }
      });
    });

    console.log("\n   --- DEBIAN ACTIVE TASKS ---");
    debActive.forEach(o => {
      (o.tasks || []).forEach(t => {
        if (t.status === 'Pendiente' || !t.status) {
          console.log(`   OT Interno ${o.interno} (${o.rodado}): [${t.empleado}] - TimerStart: ${t.timerStart} - Desc: ${t.descripcion}`);
        }
      });
    });

  } catch(e) {
    console.error("JSON parse error during comparison:", e.message);
  }
}

compare().catch(console.error);
