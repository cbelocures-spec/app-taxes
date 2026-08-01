/**
 * fix_railway_orders_v2.js
 * Sets responsable to just "Belocures" (no comma) so the OLD Taxes search works,
 * then retries sync.
 */
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

async function main() {
  console.log('Fetching orders...');
  const orders = JSON.parse(await apiCall('GET', '/api/orders'));
  const targets = orders.filter(o => o.interno == 142 || o.interno == 144);

  for (const order of targets) {
    console.log(`\nFixing OT interno=${order.interno} id=${order.id}`);
    // Use a search term without comma that will find Belocures in the Taxes dropdown
    const patchRes = JSON.parse(await apiCall('PUT', `/api/orders/${order.id}`, {
      responsable: 'Belocures',
      syncStatus: 'pending',
      syncError: null
    }));
    console.log(`  New responsable: ${patchRes.responsable}, syncStatus: ${patchRes.syncStatus}`);
  }

  await new Promise(r => setTimeout(r, 2000));

  for (const order of targets) {
    const retryRes = JSON.parse(await apiCall('POST', `/api/orders/retry/${order.id}`));
    console.log(`  Retry OT ${order.interno}: ${retryRes.message || retryRes.success}`);
  }

  console.log('\n✅ Done! Watching status in 60s...');
  await new Promise(r => setTimeout(r, 60000));

  const orders2 = JSON.parse(await apiCall('GET', '/api/orders'));
  const t2 = orders2.filter(o => o.interno == 142 || o.interno == 144);
  t2.forEach(o => {
    console.log(`OT ${o.interno}: syncStatus=${o.syncStatus} taxesOT=${o.taxesOrderNumber} error=${o.syncError}`);
  });
}

main().catch(console.error);
