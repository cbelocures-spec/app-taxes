const https = require('https');

const host = 'app-taxes-production-ec67.up.railway.app';
const username = 'paniol@contenedoreshugo.com.ar';

function get(path) {
  return new Promise((resolve) => {
    https.get({
      hostname: host,
      path: path,
      headers: {
        'x-user-username': username,
        'X-User-Username': username
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

async function inspectRailwayState() {
  console.log("Checking Railway /api/orders...");
  const ordersRes = await get('/api/orders');
  console.log("Orders response type:", typeof ordersRes, "Is Array:", Array.isArray(ordersRes));
  const orders = Array.isArray(ordersRes) ? ordersRes : (ordersRes && ordersRes.workOrders ? ordersRes.workOrders : []);
  console.log("Active orders count on Railway:", orders.length);

  console.log("\nChecking Railway /api/catalogs...");
  const catalogs = await get('/api/catalogs');
  if (catalogs) {
    console.log("Catalogs empleados count:", (catalogs.empleados || []).length);
    console.log("Catalogs rodados count:  ", (catalogs.rodados || []).length);
  } else {
    console.log("Catalogs returned null/empty!");
  }
}

inspectRailwayState();
