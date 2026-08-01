const https = require('https');
const HOST = 'app-taxes-production-ec67.up.railway.app';
const USERNAME = 'paniol@contenedoreshugo.com.ar';

function apiCall(method, path, bodyData) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      path: path,
      method: method,
      headers: {
        'x-user-username': USERNAME,
      }
    };

    let payload = '';
    if (bodyData) {
      payload = JSON.stringify(bodyData);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    } else {
      options.headers['Content-Length'] = 0;
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { resolve(data); });
    });
    req.on('error', (err) => { reject(err); });
    if (bodyData) req.write(payload);
    req.end();
  });
}

async function run() {
  console.log('Fetching live orders from Railway...');
  const rawData = await apiCall('GET', '/api/orders');
  const orders = JSON.parse(rawData);
  console.log(`Loaded ${orders.length} orders.`);
  
  const stuck = orders.filter(o => o.syncStatus === 'syncing');
  console.log(`Found ${stuck.length} orders stuck in "syncing" status.`);
  
  for (const o of stuck) {
    console.log(`Resetting order ${o.id} (Interno: ${o.interno}) back to "pending"...`);
    await apiCall('POST', `/api/orders/local-sync-result/${o.id}`, {
      syncStatus: 'pending',
      syncError: 'Sincronización reiniciada tras quedar bloqueada.',
      verifiedStatus: 'pending',
      verifiedError: null
    });
    console.log(`  ✓ Reset complete for ${o.interno}`);
  }

  // Also, let's fix any orders that failed with "Faltan configurar las credenciales del supervisor"
  // Wait, let's check if there are any that have that error
  const credErrors = orders.filter(o => (o.syncError || '').includes('Faltan configurar'));
  console.log(`Found ${credErrors.length} orders with missing credentials error.`);
  for (const o of credErrors) {
    console.log(`Resetting order ${o.id} (Interno: ${o.interno}) back to "pending" to retry with local settings...`);
    await apiCall('POST', `/api/orders/local-sync-result/${o.id}`, {
      syncStatus: 'pending',
      syncError: null,
      verifiedStatus: 'pending',
      verifiedError: null
    });
  }
  
  console.log('All resets finished.');
}

run().catch(console.error);
