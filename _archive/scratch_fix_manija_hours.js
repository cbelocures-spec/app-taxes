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
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          console.error(`Parse error for ${path} (status ${res.statusCode}):`, e.message, body.substring(0, 200));
          resolve(null);
        }
      });
    }).on('error', (err) => {
      console.error(`Network error for ${path}:`, err.message);
      resolve(null);
    });
  });
}

function post(path, body) {
  return new Promise((resolve) => {
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
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

async function fixManijaAndLargeHours() {
  console.log("Fetching all orders from Railway...");
  const fetchRes = await get('/api/orders');
  console.log("Response type:", typeof fetchRes, "Is Array:", Array.isArray(fetchRes));
  const allOrders = Array.isArray(fetchRes) ? fetchRes : (fetchRes && fetchRes.orders ? fetchRes.orders : (fetchRes && fetchRes.workOrders ? fetchRes.workOrders : null));
  if (!allOrders) {
    console.error("Could not fetch orders array from Railway. Response was:", fetchRes ? JSON.stringify(fetchRes).substring(0, 200) : "null");
    return;
  }

  console.log(`Fetched ${allOrders.length} orders from Railway.`);

  let fixedCount = 0;

  const cleanedOrders = allOrders.map(order => {
    if (!order.tasks || !Array.isArray(order.tasks)) return order;

    order.tasks = order.tasks.map(task => {
      if (!task) return task;

      const desc = (task.descripcion || '').toLowerCase();
      const horas = parseFloat(String(task.horasEstimadas).replace(',', '.')) || 0;

      // Check if task is 'Arreglar manija de cierre de cabina' or has > 10 hours
      if (desc.includes('manija') || horas > 10) {
        fixedCount++;
        console.log(`🔧 FIXING TASK HOURS: OT ${order.taxesOrderNumber || order.id} (Int ${order.interno}) | Desc: ${task.descripcion} | Old Horas: ${task.horasEstimadas} -> New Horas: 1.00`);
        return {
          ...task,
          horasEstimadas: 1.00,
          timerStart: null,
          timerStarted: false,
          status: 'Finalizada' // Mark finished so it's archived cleanly without uploading 142h to Taxes!
        };
      }
      return task;
    });

    return order;
  });

  console.log(`\nFixed and capped ${fixedCount} tasks with huge hours.`);

  const catalogs = await get('/api/catalogs') || {};
  const settings = await get('/api/settings') || {};

  console.log("Uploading fixed DB to Railway...");
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
    console.log(`\nRemaining TAREAS EN PAUSA on Railway:`);
    activeOrdersNow.forEach(o => {
      (o.tasks || []).forEach(t => {
        if (t && t.status !== 'Finalizada') {
          console.log(`  - OT ${o.taxesOrderNumber || o.id} | Int ${o.interno} | Mech ${t.empleado} | Horas: ${t.horasEstimadas} | Desc: ${t.descripcion}`);
        }
      });
    });
  }
}

fixManijaAndLargeHours();
