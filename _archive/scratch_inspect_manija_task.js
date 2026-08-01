const https = require('https');

const host = 'app-taxes-production-ec67.up.railway.app';
const username = 'paniol@contenedoreshugo.com.ar';

function get(path) {
  return new Promise((resolve) => {
    https.get({
      hostname: host,
      path: path,
      headers: { 'x-user-username': username }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function inspectTask() {
  const orders = await get('/api/orders/all');
  if (!Array.isArray(orders)) return;

  const targetOrder = orders.find(o => String(o.id) === '1784834497857' || String(o.interno) === '90');
  if (targetOrder) {
    console.log(`Found Order ID: ${targetOrder.id} | Interno: ${targetOrder.interno}`);
    console.log(JSON.stringify(targetOrder.tasks, null, 2));
  } else {
    console.log("Order not found directly by ID, searching all tasks for 'manija'...");
    orders.forEach(o => {
      (o.tasks || []).forEach(t => {
        if (t && t.descripcion && t.descripcion.includes('manija')) {
          console.log(`Found task in Order ${o.id} (Int ${o.interno}):`, JSON.stringify(t, null, 2));
        }
      });
    });
  }
}

inspectTask();
