const https = require('https');
const fs = require('fs');

const host = 'app-taxes-production-ec67.up.railway.app';
const secret = 'Paniol2015';

function get(path) {
  return new Promise((resolve) => {
    https.get({
      hostname: host,
      path: path,
      headers: {
        'x-user-username': 'paniol@contenedoreshugo.com.ar',
        'X-User-Username': 'paniol@contenedoreshugo.com.ar'
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

function post(path, body) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      hostname: host,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'x-user-username': 'paniol@contenedoreshugo.com.ar'
      }
    }, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const resp = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, body: JSON.parse(resp) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') });
        }
      });
    });
    req.on('error', err => resolve({ error: err.message }));
    req.write(payload);
    req.end();
  });
}

async function resetAndUploadAllErrors() {
  console.log("Fetching all orders from Railway...");
  const allOrders = await get('/api/orders/all');
  if (!Array.isArray(allOrders)) {
    console.error("Could not fetch orders array from Railway");
    return;
  }

  let resetCount = 0;
  const cleaned = allOrders.map(order => {
    if (order.syncStatus === 'error') {
      resetCount++;
      console.log(`🔄 Resetting error for OT ID ${order.id} (Int ${order.interno}) | Previous error: ${order.syncError}`);
      return {
        ...order,
        syncStatus: 'pending',
        syncError: null
      };
    }
    return order;
  });

  console.log(`\nReset ${resetCount} orders to 'pending'. Uploading to Railway...`);
  const catalogs = await get('/api/catalogs') || {};
  const settings = await get('/api/settings') || {};

  const res = await post('/api/admin/upload-db', {
    secret: secret,
    dbData: {
      workOrders: cleaned,
      catalogs: catalogs,
      settings: settings
    }
  });

  console.log("Upload result:", res);
}

resetAndUploadAllErrors();
