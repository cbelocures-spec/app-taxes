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

async function fixOnly4ActiveTimers() {
  const allOrders = await get('/api/orders/all');
  if (!Array.isArray(allOrders)) {
    console.error("Error: Could not fetch orders from Railway");
    return;
  }

  console.log(`Fetched ${allOrders.length} orders from Railway.`);

  // Threshold: Timers started TODAY (timestamp > 1785300000000 -> 2026-07-29 00:00 UTC)
  const todayTimestampThreshold = 1785300000000;

  let activeTimerCount = 0;
  let clearedStaleTimerCount = 0;

  const cleanedOrders = allOrders.map(order => {
    if (!order.tasks) return order;

    let hasActiveTodayTimer = false;
    let hasUnfinishedTaskToday = false;

    const newTasks = order.tasks.map(task => {
      if (!task) return task;

      const isTodayTimer = task.timerStart !== null && task.timerStart > todayTimestampThreshold;

      if (isTodayTimer) {
        activeTimerCount++;
        hasActiveTodayTimer = true;
        console.log(`✅ KEPT ACTIVE TIMER: OT ${order.taxesOrderNumber || order.id} (Int ${order.interno}) | Desc: ${task.descripcion} | Start: ${new Date(task.timerStart).toISOString()}`);
        return {
          ...task,
          timerStarted: true
        };
      } else if (task.timerStart !== null && task.timerStart <= todayTimestampThreshold) {
        // Clear old stale timerStart from previous weeks/months
        clearedStaleTimerCount++;
        return {
          ...task,
          timerStart: null,
          timerStarted: false
        };
      }
      return task;
    });

    order.tasks = newTasks;

    // Restore order to active if it was created today or has today's active task
    const orderDate = new Date(order.createdAt || order.syncDate || Date.now()).getTime();
    if (orderDate > todayTimestampThreshold || hasActiveTodayTimer) {
      order.deleted = false;
      order.deletedAt = null;
      order.archived = false;
      order.archivedAt = null;
    }

    return order;
  });

  console.log(`\nCleaned up orders:`);
  console.log(`  - Active timers kept (from today): ${activeTimerCount}`);
  console.log(`  - Stale old timers cleared: ${clearedStaleTimerCount}`);

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

  console.log("Upload response:", uploadRes);

  // Verify Railway /api/orders
  const activeOrdersNow = await get('/api/orders');
  if (Array.isArray(activeOrdersNow)) {
    console.log(`\nActive orders returned by /api/orders: ${activeOrdersNow.length}`);
    let activeTasksNow = 0;
    activeOrdersNow.forEach(o => {
      (o.tasks || []).forEach(t => {
        if (t && t.timerStart !== null && t.timerStart > 0) {
          activeTasksNow++;
          console.log(`  -> Running Task: OT ${o.taxesOrderNumber || o.id} | Int ${o.interno} | Mech ${t.empleado} | Desc: ${t.descripcion}`);
        }
      });
    });
    console.log(`Total running timer tasks in /api/orders: ${activeTasksNow}`);
  }
}

fixOnly4ActiveTimers();
