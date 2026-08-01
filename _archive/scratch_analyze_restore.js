const https = require('https');

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

async function analyzeRestore() {
  const allOrders = await get('/api/orders/all');
  if (!Array.isArray(allOrders)) {
    console.error("Failed to fetch all orders from Railway");
    return;
  }

  console.log(`Total orders fetched from Railway: ${allOrders.length}`);

  let restoredCount = 0;
  const updatedOrders = allOrders.map(order => {
    let shouldBeActive = false;

    // Check if order has non-finished tasks or active timers
    const tasks = (order.tasks || []).filter(Boolean);
    const hasUnfinishedTask = tasks.some(t => t.status !== 'Finalizada');
    const hasActiveTimer = tasks.some(t => t.timerStarted || (t.timerStart !== null && t.timerStart > 0));

    if (hasUnfinishedTask || hasActiveTimer) {
      shouldBeActive = true;
    }

    if (shouldBeActive && (order.deleted || order.archived)) {
      restoredCount++;
      return {
        ...order,
        deleted: false,
        deletedAt: null,
        archived: false,
        archivedAt: null
      };
    }
    return order;
  });

  console.log(`Orders that need to be restored to ACTIVE state: ${restoredCount}`);
}

analyzeRestore();
