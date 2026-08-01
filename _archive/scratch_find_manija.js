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

async function findManijaTask() {
  const orders = await get('/api/orders');
  if (!Array.isArray(orders)) {
    console.error("Could not fetch orders");
    return;
  }

  orders.forEach(o => {
    (o.tasks || []).forEach(t => {
      if (t && t.descripcion && t.descripcion.toLowerCase().includes('manija')) {
        console.log(`FOUND MANIJA TASK:`);
        console.log(`Order ID: ${o.id} | OT: ${o.taxesOrderNumber || o.id} | Interno: ${o.interno}`);
        console.log(`Task:`, JSON.stringify(t, null, 2));
      }
    });
  });
}

findManijaTask();
