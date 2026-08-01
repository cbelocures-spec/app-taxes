const https = require('https');

const host = 'app-taxes-production-ec67.up.railway.app';
const username = 'paniol@contenedoreshugo.com.ar';

function get(path) {
  return new Promise((resolve) => {
    https.get({
      hostname: host,
      path: path,
      headers: { 'x-user-username': username }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function listCurrentDashboardTasks() {
  const res = await get('/api/orders');
  const orders = Array.isArray(res) ? res : (res && res.workOrders ? res.workOrders : (res && res.orders ? res.orders : []));
  console.log(`Fetched ${orders.length} active orders.`);

  console.log("=== CURRENT DASHBOARD TASKS ===");
  orders.forEach(o => {
    (o.tasks || []).forEach(t => {
      if (!t || t.status === 'Finalizada') return;
      const isRunning = t.timerStart !== null && t.timerStart > 0;
      const startISO = t.timerStart ? new Date(t.timerStart).toISOString() : 'N/A';
      console.log(`[${isRunning ? 'WORKING' : 'PAUSED'}] OT ${o.taxesOrderNumber || o.id} (Int ${o.interno}) | Mech: ${t.empleado} | Desc: ${t.descripcion}`);
      console.log(`  -> status: "${t.status}", timerStart: ${startISO}, timerStarted: ${t.timerStarted}`);
      console.log(`  -> timerHistory:`, t.timerHistory);
    });
  });
}

listCurrentDashboardTasks();
