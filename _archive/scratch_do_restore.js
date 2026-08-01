const https = require('https');
const fs = require('fs');

const host = 'app-taxes-production-ec67.up.railway.app';
const secret = 'Paniol2015';

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
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

function post(path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: host,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-user-username': 'paniol@contenedoreshugo.com.ar'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', err => resolve({ error: err.message }));
    req.write(payload);
    req.end();
  });
}

async function performRestore() {
  console.log("Fetching all orders from Railway...");
  const allOrders = await get('/api/orders/all');
  if (!Array.isArray(allOrders)) {
    console.error("Error: Failed to fetch orders from Railway");
    return;
  }

  console.log(`Fetched ${allOrders.length} total orders from Railway.`);

  // Load db_live_recovered.json to merge any extra historical active orders/timers if needed
  let backupOrders = [];
  try {
    if (fs.existsSync('db_live_recovered.json')) {
      const bData = JSON.parse(fs.readFileSync('db_live_recovered.json', 'utf8'));
      backupOrders = bData.workOrders || bData.orders || [];
      console.log(`Loaded ${backupOrders.length} backup orders from db_live_recovered.json`);
    }
  } catch (e) {
    console.warn("Could not load db_live_recovered.json:", e.message);
  }

  // Create map of existing orders by ID
  const orderMap = new Map();
  allOrders.forEach(o => orderMap.set(String(o.id), o));

  // Merge backup orders if they exist and are missing
  backupOrders.forEach(bo => {
    const id = String(bo.id);
    if (!orderMap.has(id)) {
      orderMap.set(id, bo);
    }
  });

  let activeCount = 0;
  let restoredCount = 0;
  let totalActiveTimers = 0;

  const finalOrders = Array.from(orderMap.values()).map(order => {
    const tasks = (order.tasks || []).filter(Boolean);
    const hasUnfinishedTask = tasks.some(t => t.status !== 'Finalizada');
    const hasActiveTimer = tasks.some(t => t.timerStarted || (t.timerStart !== null && t.timerStart > 0));

    // If an order has unfinished tasks or active timers, IT MUST BE ACTIVE!
    if (hasUnfinishedTask || hasActiveTimer) {
      if (order.deleted || order.archived) {
        restoredCount++;
      }
      order.deleted = false;
      order.deletedAt = null;
      order.archived = false;
      order.archivedAt = null;
    }

    if (!order.deleted && !order.archived) {
      activeCount++;
      tasks.forEach(t => {
        if (t.timerStarted || (t.timerStart !== null && t.timerStart > 0)) {
          totalActiveTimers++;
        }
      });
    }

    return order;
  });

  console.log(`Summary before upload:`);
  console.log(`  - Total Orders: ${finalOrders.length}`);
  console.log(`  - Active Orders: ${activeCount}`);
  console.log(`  - Orders Restored from deleted/archived: ${restoredCount}`);
  console.log(`  - Active Tasks/Timers across Active Orders: ${totalActiveTimers}`);

  // Fetch current catalogs & settings to ensure upload-db doesn't wipe them
  const catalogs = await get('/api/catalogs') || {};
  const settings = await get('/api/settings') || {};

  console.log("\nUploading restored DB payload to Railway /api/admin/upload-db ...");

  const payload = {
    secret: secret,
    dbData: {
      workOrders: finalOrders,
      catalogs: catalogs,
      settings: settings
    }
  };

  const res = await post('/api/admin/upload-db', payload);
  console.log("Upload result:", res);

  // Verify Railway DB state
  const verifyDebug = await get('/api/db-debug');
  console.log("\nRailway DB State after restore:", verifyDebug);

  const activeOrdersNow = await get('/api/orders');
  if (Array.isArray(activeOrdersNow)) {
    console.log(`\n✅ Active Orders now returned by /api/orders: ${activeOrdersNow.length}`);
  }
}

performRestore();
