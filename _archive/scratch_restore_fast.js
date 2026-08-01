const https = require('https');
const fs = require('fs');

const host = 'app-taxes-production-ec67.up.railway.app';
const secret = 'Paniol2015';

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: host,
      path: path,
      headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' }
    }, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function postJson(path, body) {
  return new Promise((resolve, reject) => {
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
          resolve(JSON.parse(resp));
        } catch (e) {
          resolve({ raw: Buffer.concat(chunks).toString('utf8') });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function doRestoreFast() {
  console.log("1. Fetching all orders on Railway...");
  const allOrders = await fetchJson('/api/orders/all');
  console.log(`Received ${allOrders.length} orders from Railway.`);

  let backupOrders = [];
  try {
    if (fs.existsSync('db_live_recovered.json')) {
      const bData = JSON.parse(fs.readFileSync('db_live_recovered.json', 'utf8'));
      backupOrders = bData.workOrders || bData.orders || [];
    }
  } catch (e) {}

  const orderMap = new Map();
  allOrders.forEach(o => orderMap.set(String(o.id), o));
  backupOrders.forEach(bo => {
    const id = String(bo.id);
    if (!orderMap.has(id)) {
      orderMap.set(id, bo);
    }
  });

  let restoredCount = 0;
  let activeTimersCount = 0;

  const finalOrders = Array.from(orderMap.values()).map(order => {
    const tasks = (order.tasks || []).filter(Boolean);
    const hasUnfinishedTask = tasks.some(t => t.status !== 'Finalizada');
    const hasActiveTimer = tasks.some(t => t.timerStarted || (t.timerStart !== null && t.timerStart > 0));

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
      tasks.forEach(t => {
        if (t.timerStarted || (t.timerStart !== null && t.timerStart > 0)) {
          activeTimersCount++;
        }
      });
    }
    return order;
  });

  console.log(`Restoring ${restoredCount} deleted/archived orders back to ACTIVE.`);
  console.log(`Total active timers across active orders: ${activeTimersCount}`);

  const catalogs = await fetchJson('/api/catalogs').catch(() => ({}));
  const settings = await fetchJson('/api/settings').catch(() => ({}));

  console.log("2. Uploading payload to Railway...");
  const result = await postJson('/api/admin/upload-db', {
    secret: secret,
    dbData: {
      workOrders: finalOrders,
      catalogs: catalogs,
      settings: settings
    }
  });

  console.log("Upload result:", result);

  console.log("3. Verifying Railway active orders...");
  const activeOrdersNow = await fetchJson('/api/orders');
  console.log(`Active orders returned by /api/orders now: ${activeOrdersNow.length}`);
}

doRestoreFast();
