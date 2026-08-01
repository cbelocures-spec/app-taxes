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
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
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
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

async function cleanPreTodayDashboardTasks() {
  const allOrders = await get('/api/orders/all');
  if (!Array.isArray(allOrders)) {
    console.error("Error: Could not fetch orders");
    return;
  }

  console.log(`Fetched ${allOrders.length} orders from Railway.`);

  // Timestamp for start of today (July 29 2026 00:00 UTC)
  const todayStartMs = 1785300000000;

  let finishedOldTasksCount = 0;
  let remainingDashboardTasksCount = 0;

  const cleanedOrders = allOrders.map(order => {
    if (!order.tasks || !Array.isArray(order.tasks)) return order;

    order.tasks = order.tasks.map(task => {
      if (!task || task.status === 'Finalizada') return task;

      // Check if task had activity today (July 29)
      const lastHistoryEntry = (task.timerHistory && task.timerHistory.length > 0)
        ? task.timerHistory[task.timerHistory.length - 1]
        : null;
      const lastActivityMs = lastHistoryEntry ? lastHistoryEntry.timestamp : (task.timerStart || 0);

      const isTaskFromToday = lastActivityMs > todayStartMs;

      if (!isTaskFromToday) {
        finishedOldTasksCount++;
        console.log(`🧹 Finishing old task (pre-July 29): OT ${order.taxesOrderNumber || order.id} (Int ${order.interno}) | Desc: ${task.descripcion} | Last activity: ${new Date(lastActivityMs).toISOString()}`);
        return {
          ...task,
          status: 'Finalizada',
          timerStart: null,
          timerStarted: false
        };
      } else {
        remainingDashboardTasksCount++;
        console.log(`✅ Keeping TODAY task: OT ${order.taxesOrderNumber || order.id} (Int ${order.interno}) | Desc: ${task.descripcion} | Status: ${task.status} | Timer: ${task.timerStart ? 'WORKING' : 'PAUSED'}`);
        return task;
      }
    });

    return order;
  });

  console.log(`\nCleanup Summary:`);
  console.log(`  - Old pre-today tasks finished/archived: ${finishedOldTasksCount}`);
  console.log(`  - Active/Paused tasks remaining for today: ${remainingDashboardTasksCount}`);

  const catalogs = await get('/api/catalogs') || {};
  const settings = await get('/api/settings') || {};

  console.log("\nUploading cleaned DB payload to Railway...");
  const uploadRes = await post('/api/admin/upload-db', {
    secret: secret,
    dbData: {
      workOrders: cleanedOrders,
      catalogs: catalogs,
      settings: settings
    }
  });

  console.log("Upload result:", uploadRes);
}

cleanPreTodayDashboardTasks();
