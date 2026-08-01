const https = require('https');
const fs = require('fs');

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
          resolve({ status: res.statusCode, body: JSON.parse(resp) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') });
        }
      });
    });
    req.on('error', err => resolve({ error: err.message }));
    req.write(payload);
    req.end();
  });
}

async function removeDuplicateDashboardTasks() {
  console.log("Fetching all active orders from Railway...");
  const res = await get('/api/orders/all');
  const orders = Array.isArray(res) ? res : (res && res.workOrders ? res.workOrders : []);

  console.log(`Fetched ${orders.length} total orders.`);

  let removedDuplicatesCount = 0;
  const seenTaskKeys = new Set();

  const cleanedOrders = orders.map(order => {
    if (!order.tasks || !Array.isArray(order.tasks)) return order;

    // Deduplicate active/paused tasks
    const newTasks = [];
    order.tasks.forEach(task => {
      if (!task) return;

      if (task.status === 'Finalizada') {
        newTasks.push(task);
        return;
      }

      // Key based on order + mechanic + description
      const taskKey = `${order.interno || order.id}_${task.empleado}_${(task.descripcion || '').toLowerCase().trim()}`;

      if (seenTaskKeys.has(taskKey)) {
        removedDuplicatesCount++;
        console.log(`🧹 Removing DUPLICATE task: Int ${order.interno} | OT ${order.taxesOrderNumber || order.id} | Mech ${task.empleado} | Desc: ${task.descripcion}`);
        newTasks.push({
          ...task,
          status: 'Finalizada',
          timerStart: null,
          timerStarted: false
        });
      } else {
        seenTaskKeys.add(taskKey);
        newTasks.push(task);
      }
    });

    order.tasks = newTasks;
    return order;
  });

  console.log(`\nRemoved ${removedDuplicatesCount} duplicate active tasks.`);

  // Save to local db.json
  const dbData = {
    workOrders: cleanedOrders,
    catalogs: await get('/api/catalogs') || {},
    settings: await get('/api/settings') || {}
  };
  fs.writeFileSync('db.json', JSON.stringify(dbData, null, 2));

  console.log("Uploading deduplicated DB to Railway...");
  const uploadRes = await post('/api/admin/upload-db', {
    secret: secret,
    dbData: dbData
  });

  console.log("Upload result:", uploadRes);
}

removeDuplicateDashboardTasks();
