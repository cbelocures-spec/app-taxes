const https = require('https');
const worker = require('./syncWorker');
const db = require('./database');

const HOST = 'app-taxes-production.up.railway.app';
const USERNAME = 'paniol@contenedoreshugo.com.ar';
const TARGET_ID = '1782944762767'; // OT 25548 (Interno 88)

function apiCall(method, path, bodyData, callback) {
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
    res.on('end', () => { callback(null, data); });
  });
  req.on('error', (err) => { callback(err); });
  if (bodyData) req.write(payload);
  req.end();
}

console.log('Fetching target order from Railway...');
apiCall('GET', '/api/orders', null, async (err, rawData) => {
  if (err) {
    console.error('Error fetching orders:', err.message);
    process.exit(1);
  }

  let orders = [];
  try {
    orders = JSON.parse(rawData);
  } catch (e) {
    console.error('Parse error:', e.message);
    process.exit(1);
  }

  const target = orders.find(o => o.id === TARGET_ID);
  if (!target) {
    console.error(`Order ${TARGET_ID} not found on Railway!`);
    process.exit(1);
  }

  console.log(`Found target order on Railway: ${target.id} | OT: ${target.taxesOrderNumber}`);

  console.log('Updating Railway syncStatus to syncing...');
  apiCall('POST', `/api/orders/local-sync-result/${target.id}`, { syncStatus: 'syncing' }, async (upErr) => {
    if (upErr) {
      console.error('Failed to set syncing status on Railway:', upErr.message);
    } else {
      console.log('Railway status set to syncing.');
    }

    console.log('Saving order to local database copy...');
    const existing = db.getWorkOrderById(target.id);
    if (existing) {
      db.updateWorkOrder(target.id, target);
    } else {
      db.createWorkOrder(target);
    }

    console.log('Launching syncWorker locally...');
    try {
      const result = await worker.syncWorkOrder(target.id);
      console.log('Local sync completed successfully. Result:', result);

      const updatedLocal = db.getWorkOrderById(target.id);
      console.log('Uploading results back to Railway...');
      apiCall('POST', `/api/orders/local-sync-result/${target.id}`, {
        syncStatus: updatedLocal.syncStatus,
        syncError: updatedLocal.syncError,
        syncDate: updatedLocal.syncDate,
        tasks: updatedLocal.tasks,
        verifiedStatus: updatedLocal.verifiedStatus,
        verifiedError: updatedLocal.verifiedError,
        verifiedCount: updatedLocal.verifiedCount
      }, (uploadErr) => {
        if (uploadErr) {
          console.error('Error uploading results:', uploadErr.message);
          process.exit(1);
        } else {
          console.log('Sync results successfully saved on Railway!');
          process.exit(0);
        }
      });
    } catch (syncErr) {
      console.error('Sync failed with error:', syncErr.message);
      apiCall('POST', `/api/orders/local-sync-result/${target.id}`, {
        syncStatus: 'error',
        syncError: syncErr.message
      }, () => {
        process.exit(1);
      });
    }
  });
});
