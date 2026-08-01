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

// Calculate elapsed seconds from timer history
function calculateElapsedSeconds(history, currentStart) {
  let totalMs = 0;
  if (Array.isArray(history)) {
    for (let i = 0; i < history.length; i++) {
      const ev = history[i];
      if (ev.type === 'Inició' || ev.type === 'Reanudó') {
        const nextEv = history[i + 1];
        const endTs = nextEv ? nextEv.timestamp : (currentStart || Date.now());
        totalMs += (endTs - ev.timestamp);
      }
    }
  }
  return Math.max(0, Math.floor(totalMs / 1000));
}

async function removeOver100HourTasks() {
  const allOrders = await get('/api/orders/all');
  if (!Array.isArray(allOrders)) {
    console.error("Could not fetch orders from Railway");
    return;
  }

  console.log(`Fetched ${allOrders.length} total orders from Railway.`);

  let finishedOverdueTasksCount = 0;

  const cleanedOrders = allOrders.map(order => {
    if (!order.tasks || !Array.isArray(order.tasks)) return order;

    order.tasks = order.tasks.map(task => {
      if (!task || task.status === 'Finalizada') return task;

      // Calculate total elapsed hours for this task
      const elapsedSeconds = calculateElapsedSeconds(task.timerHistory, task.timerStart);
      const elapsedHours = elapsedSeconds / 3600;

      // Also check if timer history started before July 29 (timestamp < 1785300000000)
      const firstEntry = (task.timerHistory && task.timerHistory.length > 0) ? task.timerHistory[0] : null;
      const firstStartMs = firstEntry ? firstEntry.timestamp : (task.timerStart || 0);

      const isOver24Hours = elapsedHours > 24;
      const isBeforeToday = firstStartMs < 1785300000000;

      if (isOver24Hours || isBeforeToday) {
        finishedOverdueTasksCount++;
        console.log(`🧹 FINISHING TASK (>24h or old date): OT ${order.taxesOrderNumber || order.id} (Int ${order.interno}) | Mech: ${task.empleado} | Desc: ${task.descripcion} | Hours: ${elapsedHours.toFixed(2)}h | First start: ${new Date(firstStartMs).toISOString()}`);
        return {
          ...task,
          status: 'Finalizada',
          timerStart: null,
          timerStarted: false
        };
      } else {
        console.log(`✅ KEEPING TODAY TASK (<24h): OT ${order.taxesOrderNumber || order.id} (Int ${order.interno}) | Mech: ${task.empleado} | Desc: ${task.descripcion} | Hours: ${elapsedHours.toFixed(2)}h`);
        return task;
      }
    });

    return order;
  });

  console.log(`\nFinished ${finishedOverdueTasksCount} overdue tasks (>24h or pre-today).`);

  const catalogs = await get('/api/catalogs') || {};
  const settings = await get('/api/settings') || {};

  console.log("Uploading cleaned database to Railway...");
  const res = await post('/api/admin/upload-db', {
    secret: secret,
    dbData: {
      workOrders: cleanedOrders,
      catalogs: catalogs,
      settings: settings
    }
  });

  console.log("Upload result:", res);

  const activeOrdersNow = await get('/api/orders');
  if (Array.isArray(activeOrdersNow)) {
    console.log(`\nRemaining dashboard tasks on Railway:`);
    activeOrdersNow.forEach(o => {
      (o.tasks || []).forEach(t => {
        if (t && t.status !== 'Finalizada') {
          const hrs = (calculateElapsedSeconds(t.timerHistory, t.timerStart) / 3600).toFixed(2);
          console.log(`  - [${t.timerStart > 0 ? 'WORKING' : 'PAUSED'}] OT ${o.taxesOrderNumber || o.id} | Int ${o.interno} | Mech ${t.empleado} | ${hrs} hrs | Desc: ${t.descripcion}`);
        }
      });
    });
  }
}

removeOver100HourTasks();
