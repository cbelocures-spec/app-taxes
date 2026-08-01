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

async function restoreTodayDashboardTasks() {
  console.log("Fetching all orders from Railway...");
  const allOrders = await get('/api/orders/all');
  if (!Array.isArray(allOrders)) {
    console.error("Could not fetch orders from Railway");
    return;
  }

  console.log(`Fetched ${allOrders.length} total orders.`);

  // Current timestamp for today (July 29 18:17 = 1785359860167)
  const now = Date.now();

  // The 5 active tasks of today:
  // 1. OT 1785359896231 (Int 144) | Perino Martin Adrian | se quedo bloqueado -> WORKING
  // 2. OT 1785360410943 (Int 100) | Cuba Orosco, Kevin Genaro | calefaccion -> PAUSED (0.47h)
  // 3. OT 27850 (Int 90) | MUSDALINO FRANCO | revisar perdida de aire -> PAUSED (1.29h)
  // 4. OT 26926 (Int 155) | Sosa, Alejandro Damian | Reparar piso de cabina lado izq -> PAUSED (4.44h)
  // 5. OT 27779 (Int VOLQUETE NICO) | Mech: 253 | GGZ481 revisar perdida de aire -> PAUSED (0.88h)

  let restoredCount = 0;

  const cleanedOrders = allOrders.map(order => {
    if (!order.tasks || !Array.isArray(order.tasks)) return order;

    const intStr = String(order.interno || '');
    const otStr = String(order.taxesOrderNumber || order.id || '');

    order.tasks = order.tasks.map(task => {
      if (!task) return task;
      const desc = (task.descripcion || '').toLowerCase();

      // 1. Task: se quedo bloqueado (Int 144) -> WORKING
      if (desc.includes('bloqueado') || (intStr === '144' && desc.includes('quedo'))) {
        restoredCount++;
        console.log(`⚡ RESTORING WORKING TASK: Int 144 | Perino | se quedo bloqueado`);
        return {
          ...task,
          status: 'Pendiente',
          timerStart: now - (3600 * 1000), // 1 hour running
          timerStarted: true,
          horasEstimadas: 2.5,
          timerHistory: [ { type: 'Inició', formatted: '18:17', timestamp: now - (3600 * 1000) } ]
        };
      }

      // 2. Task: calefaccion (Int 100) -> PAUSED (0.47h)
      if (desc.includes('calefaccion') || intStr === '100') {
        restoredCount++;
        console.log(`⏸ RESTORING PAUSED TASK: Int 100 | Cuba Orosco | calefaccion`);
        return {
          ...task,
          status: 'Pendiente',
          timerStart: null,
          timerStarted: true,
          horasEstimadas: 3.5,
          timerHistory: [
            { type: 'Inició', formatted: '18:26', timestamp: now - (3600 * 1000 * 1.5) },
            { type: 'Pausó', formatted: '19:12', timestamp: now - (3600 * 1000 * 1.03) }
          ]
        };
      }

      // 3. Task: revisar perdida de aire (Int 90) -> PAUSED (1.29h)
      if (desc.includes('perdida de aire') && (intStr === '90' || otStr.includes('27850'))) {
        restoredCount++;
        console.log(`⏸ RESTORING PAUSED TASK: Int 90 | Musdalino | revisar perdida de aire`);
        return {
          ...task,
          status: 'Pendiente',
          timerStart: null,
          timerStarted: true,
          horasEstimadas: 3.5,
          timerHistory: [
            { type: 'Inició', formatted: '17:43', timestamp: now - (3600 * 1000 * 2.5) },
            { type: 'Pausó', formatted: '19:12', timestamp: now - (3600 * 1000 * 1.21) }
          ]
        };
      }

      // 4. Task: Reparar piso de cabina (Int 155) -> PAUSED (4.44h)
      if (desc.includes('piso de cabina') || (intStr === '155' && otStr.includes('26926'))) {
        restoredCount++;
        console.log(`⏸ RESTORING PAUSED TASK: Int 155 | Sosa | Reparar piso de cabina`);
        return {
          ...task,
          status: 'Pendiente',
          timerStart: null,
          timerStarted: true,
          horasEstimadas: 6.5,
          timerHistory: [
            { type: 'Inició', formatted: '14:28', timestamp: now - (3600 * 1000 * 5.5) },
            { type: 'Pausó', formatted: '19:12', timestamp: now - (3600 * 1000 * 1.06) }
          ]
        };
      }

      // 5. Task: GGZ481 revisar perdida de aire (Volquete Nico) -> PAUSED (0.88h)
      if (desc.includes('ggz481') || (intStr.toLowerCase().includes('volquete') && desc.includes('aire'))) {
        restoredCount++;
        console.log(`⏸ RESTORING PAUSED TASK: Volquete Nico | GGZ481 revisar perdida de aire`);
        return {
          ...task,
          status: 'Pendiente',
          timerStart: null,
          timerStarted: true,
          horasEstimadas: 2.5,
          timerHistory: [
            { type: 'Inició', formatted: '14:03', timestamp: now - (3600 * 1000 * 5.8) },
            { type: 'Pausó', formatted: '14:55', timestamp: now - (3600 * 1000 * 4.92) }
          ]
        };
      }

      return task;
    });

    return order;
  });

  console.log(`\nRestored ${restoredCount} tasks for today's dashboard.`);

  // Save to local db.json
  const dbData = {
    workOrders: cleanedOrders,
    catalogs: await get('/api/catalogs') || {},
    settings: await get('/api/settings') || {}
  };
  fs.writeFileSync('db.json', JSON.stringify(dbData, null, 2));

  console.log("Uploading restored DB to Railway...");
  const uploadRes = await post('/api/admin/upload-db', {
    secret: secret,
    dbData: dbData
  });

  console.log("Upload result:", uploadRes);
}

restoreTodayDashboardTasks();
