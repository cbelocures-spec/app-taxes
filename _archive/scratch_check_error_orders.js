const https = require('https');

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

async function checkSyncErrorOrders() {
  console.log("Fetching all active orders from Railway...");
  const res = await get('/api/orders');
  const orders = Array.isArray(res) ? res : (res && res.workOrders ? res.workOrders : (res && res.orders ? res.orders : []));

  console.log(`Fetched ${orders.length} active orders.`);

  const errorOrders = orders.filter(o => o.syncStatus === 'error');
  const pendingOrders = orders.filter(o => o.syncStatus === 'pending' || o.syncStatus === 'syncing');
  const localOrders = orders.filter(o => o.syncStatus === 'local');
  const successOrders = orders.filter(o => o.syncStatus === 'success');

  console.log(`\n=== SYNC STATUS SUMMARY ===`);
  console.log(`  - Success (Synced to Taxes): ${successOrders.length}`);
  console.log(`  - Error (Sync Failed):       ${errorOrders.length}`);
  console.log(`  - Pending/Syncing:          ${pendingOrders.length}`);
  console.log(`  - Local Only:                ${localOrders.length}`);

  if (errorOrders.length > 0) {
    console.log(`\n=== ORDERS WITH SYNC ERRORS (${errorOrders.length}) ===`);
    errorOrders.forEach(o => {
      console.log(`OT ID: ${o.id} | OT #: ${o.taxesOrderNumber || 'Sin OT'} | Interno: ${o.interno} | Rodado: ${o.rodado}`);
      console.log(`  -> syncStatus: ${o.syncStatus}`);
      console.log(`  -> syncError: ${o.syncError || 'Ninguno especificado'}`);
      console.log(`  -> Tasks count: ${(o.tasks || []).length}`);
    });
  }
}

checkSyncErrorOrders();
