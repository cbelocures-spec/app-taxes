const https = require('https');

const host = 'app-taxes-production-ec67.up.railway.app';

function get(path) {
  return new Promise((resolve) => {
    https.get({
      hostname: host,
      path: path,
      headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data.substring(0, 500) });
        }
      });
    }).on('error', err => resolve({ error: err.message }));
  });
}

async function run() {
  const dbDebug = await get('/api/db-debug');
  console.log('=== DB DEBUG ON RAILWAY ===');
  console.log(JSON.stringify(dbDebug, null, 2));

  const allOrders = await get('/api/orders/all');
  console.log('=== ALL ORDERS ON RAILWAY ===');
  if (Array.isArray(allOrders)) {
    console.log(`Total orders in DB: ${allOrders.length}`);
    const active = allOrders.filter(o => !o.archived && !o.deleted);
    const archived = allOrders.filter(o => o.archived && !o.deleted);
    const deleted = allOrders.filter(o => o.deleted);
    console.log(`Active: ${active.length}, Archived: ${archived.length}, Deleted: ${deleted.length}`);
  } else {
    console.log(allOrders);
  }
}

run();
