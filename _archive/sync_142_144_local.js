const worker = require('./syncWorker');
const db = require('./database');
const https = require('https');

const HOST = 'app-taxes-production-ec67.up.railway.app';
const USERNAME = 'paniol@contenedoreshugo.com.ar';

function apiCall(method, path, bodyData) {
  return new Promise((resolve, reject) => {
    const body = bodyData ? JSON.stringify(bodyData) : null;
    const headers = { 'x-user-username': USERNAME, 'Content-Type': 'application/json' };
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ hostname: HOST, path, method, headers, timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runLocalSync() {
  console.log("Fetching orders from Railway to get fresh data for 142 and 144...");
  const ordersRaw = await apiCall('GET', '/api/orders');
  const orders = JSON.parse(ordersRaw);

  const targets = orders.filter(o => o.interno == 142 || o.interno == 144);
  console.log(`Found ${targets.length} target orders.`);

  for (const order of targets) {
    console.log(`\n==================================================`);
    console.log(`Processing OT interno=${order.interno} id=${order.id}...`);

    // Ensure order is saved in local DB
    const existing = db.getWorkOrderById(order.id);
    if (!existing) {
      db.createWorkOrder(order);
    } else {
      db.updateWorkOrder(order.id, order);
    }

    try {
      const res = await worker.syncWorkOrder(order.id);
      console.log(`Result for OT ${order.interno}:`, res);

      // Get updated local order and push to Railway
      const updated = db.getWorkOrderById(order.id);
      if (updated) {
        console.log(`Pushing updated OT ${order.interno} to Railway (taxesOT=${updated.taxesOrderNumber})...`);
        await apiCall('PUT', `/api/orders/${order.id}`, {
          syncStatus: updated.syncStatus,
          syncError: updated.syncError,
          taxesOrderNumber: updated.taxesOrderNumber,
          responsable: updated.responsable
        });
      }
    } catch (e) {
      console.error(`Error syncing OT ${order.interno}:`, e.message);
    }
  }

  console.log("\nAll done!");
}

runLocalSync();
