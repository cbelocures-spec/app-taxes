/**
 * fix_railway_orders.js
 * Fixes orders 142 and 144 on Railway:
 *   - Sets responsable to "Belocures, Cesar Hernán" (instead of AUTO or email)
 *   - Resets syncStatus to "pending" so the worker retries
 */
const https = require('https');

const HOST = 'app-taxes-production-ec67.up.railway.app';
const USERNAME = 'paniol@contenedoreshugo.com.ar';

function apiCall(method, path, bodyData) {
  return new Promise((resolve, reject) => {
    const body = bodyData ? JSON.stringify(bodyData) : null;
    const headers = {
      'x-user-username': USERNAME,
      'Content-Type': 'application/json'
    };
    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    const req = https.request({
      hostname: HOST,
      path,
      method,
      headers,
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  // 1. Get all orders and find 142 and 144
  console.log('Fetching orders from Railway...');
  const ordersRaw = await apiCall('GET', '/api/orders');
  const orders = JSON.parse(ordersRaw);

  const targets = orders.filter(o => o.interno == 142 || o.interno == 144);
  if (targets.length === 0) {
    console.log('No orders found with interno 142 or 144.');
    return;
  }

  for (const order of targets) {
    console.log(`\nFixing OT interno=${order.interno} id=${order.id}`);
    console.log(`  Current responsable: ${order.responsable}`);
    console.log(`  Current syncStatus: ${order.syncStatus}`);

    // 2. Patch responsable to Belocures and reset sync
    const patchBody = {
      responsable: 'Belocures, Cesar Hernán',
      syncStatus: 'pending',
      syncError: null
    };

    const patchRes = await apiCall('PUT', `/api/orders/${order.id}`, patchBody);
    console.log(`  PATCH response:`, patchRes.substring(0, 200));
  }

  // 3. Wait a moment then trigger retry for each
  console.log('\nTriggering retries...');
  await new Promise(r => setTimeout(r, 2000));
  for (const order of targets) {
    const retryRes = await apiCall('POST', `/api/orders/retry/${order.id}`);
    console.log(`  Retry OT ${order.interno}:`, retryRes.substring(0, 100));
  }

  console.log('\nDone! Orders queued for retry. Check the app in ~2 minutes.');
}

main().catch(console.error);
