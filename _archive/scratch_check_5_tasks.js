const https = require('https');
const { Client } = require('ssh2');

const RAILWAY_HOST = 'app-taxes-production-ec67.up.railway.app';

function getRailwayOrders() {
  return new Promise((resolve) => {
    https.get({
      hostname: RAILWAY_HOST,
      path: '/api/orders/all',
      headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

async function run() {
  const orders = await getRailwayOrders();
  const o155 = orders.find(o => String(o.interno) === '155' || o.taxesOrderNumber === '26926');
  const o119 = orders.find(o => String(o.interno) === '119' || o.taxesOrderNumber === '27889');

  console.log("=== RAILWAY ORDER 155 ===");
  if (o155) {
    console.log(`OT ID: ${o155.id}, Rodado: ${o155.rodado}, Clasif: ${o155.clasificacion}, Archived: ${o155.archived}`);
    (o155.tasks || []).forEach((t, i) => {
      console.log(`  Task #${i+1}: Emp=${t.empleado}, Status=${t.status}, Desc=${t.descripcion}`);
    });
  } else {
    console.log("Not found on Railway");
  }

  console.log("\n=== RAILWAY ORDER 119 ===");
  if (o119) {
    console.log(`OT ID: ${o119.id}, Rodado: ${o119.rodado}, Clasif: ${o119.clasificacion}, Archived: ${o119.archived}`);
    (o119.tasks || []).forEach((t, i) => {
      console.log(`  Task #${i+1}: Emp=${t.empleado}, Status=${t.status}, Desc=${t.descripcion}`);
    });
  } else {
    console.log("Not found on Railway");
  }
}

run();
