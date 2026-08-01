const https = require('https');

const host = 'app-taxes-production-ec67.up.railway.app';

function get(path) {
  return new Promise((resolve) => {
    https.get({
      hostname: host,
      path: path,
      headers: {
        'x-user-username': 'paniol@contenedoreshugo.com.ar'
      }
    }, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

async function checkRailwayErrors() {
  console.log("Fetching live orders from Railway...");
  const orders = await get('/api/orders/all');
  if (!Array.isArray(orders)) {
    console.error("Failed to fetch orders from Railway");
    return;
  }

  console.log(`Fetched ${orders.length} total orders from Railway.\n`);

  let erroredOrders = [];
  orders.forEach(o => {
    const cls = String(o.clasificacion || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    const isHerreria = cls.includes('herreria');

    if (o.syncStatus === 'error' || o.syncError || o.verifiedStatus === 'error' || o.verifiedError) {
      erroredOrders.push({ ...o, isHerreria });
    }
  });

  console.log(`FOUND ${erroredOrders.length} ORDERS WITH ERRORS ON RAILWAY:\n`);
  erroredOrders.forEach(o => {
    console.log(`OT: ${o.taxesOrderNumber || o.id} | Int: ${o.interno} | Sector: ${o.clasificacion} | IsHerreria: ${o.isHerreria}`);
    console.log(`  - syncStatus: ${o.syncStatus} | syncError: ${o.syncError}`);
    console.log(`  - verifiedStatus: ${o.verifiedStatus} | verifiedError: ${o.verifiedError}`);
    console.log(`  - Tasks: ${JSON.stringify(o.tasks, null, 2)}\n`);
  });
}

checkRailwayErrors();
