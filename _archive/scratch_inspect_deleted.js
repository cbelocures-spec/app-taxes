const https = require('https');

const host = 'app-taxes-production-ec67.up.railway.app';

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
          resolve({ raw: data.substring(0, 500) });
        }
      });
    }).on('error', err => resolve({ error: err.message }));
  });
}

async function inspectDeleted() {
  const allOrders = await get('/api/orders/all');
  if (Array.isArray(allOrders)) {
    const deleted = allOrders.filter(o => o.deleted);
    console.log(`Total deleted orders: ${deleted.length}`);
    let deletedRunningTasks = [];
    deleted.forEach(o => {
      (o.tasks || []).forEach(t => {
        if (t && (t.timerStarted || (t.timerStart !== null && t.timerStart > 0) || t.status !== 'Finalizada')) {
          deletedRunningTasks.push({
            orderId: o.id,
            ot: o.taxesOrderNumber || o.id,
            interno: o.interno,
            rodado: o.rodado,
            clasificacion: o.clasificacion,
            taskDesc: t.descripcion,
            empleado: t.empleado,
            status: t.status,
            timerStart: t.timerStart,
            timerStarted: t.timerStarted
          });
        }
      });
    });

    console.log(`Unfinished/Running tasks in DELETED orders: ${deletedRunningTasks.length}`);
    console.log('Sample deleted active tasks:');
    deletedRunningTasks.slice(0, 20).forEach(t => {
      console.log(`  - OT: ${t.ot} | Interno: ${t.interno} | Sector: ${t.clasificacion} | Mech: ${t.empleado} | Status: ${t.status} | Running: ${t.timerStarted || t.timerStart > 0} | Desc: ${t.taskDesc}`);
    });
  }
}

inspectDeleted();
