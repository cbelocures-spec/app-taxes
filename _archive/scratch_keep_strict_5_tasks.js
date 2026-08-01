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

async function keepOnlyStrict5TodayTasks() {
  console.log("Fetching all orders from Railway...");
  const allOrders = await get('/api/orders/all');
  if (!Array.isArray(allOrders)) {
    console.error("Could not fetch orders from Railway");
    return;
  }

  console.log(`Fetched ${allOrders.length} orders.`);

  // Strictly allowed 5 tasks for today:
  // 1. Int 144 - "se quedo bloqueado" (Perino)
  // 2. Int 100 - "calefaccion" (Cuba Orosco)
  // 3. Int 90 - "revisar perdida de aire" (Musdalino)
  // 4. Int 155 - "Reparar piso de cabina lado izq" (Sosa)
  // 5. Volquete Nico - "GGZ481 revisar perdida de aire" (Musdalino)

  let archivedOthersCount = 0;
  let keptTasksCount = 0;

  const cleanedOrders = allOrders.map(order => {
    if (!order.tasks || !Array.isArray(order.tasks)) return order;

    const intStr = String(order.interno || '').toLowerCase();
    const otStr = String(order.taxesOrderNumber || order.id || '');

    order.tasks = order.tasks.map(task => {
      if (!task) return task;
      const desc = (task.descripcion || '').toLowerCase();

      // Check if it matches one of the 5 allowed today tasks
      const isPerino144 = (intStr === '144' || otStr.includes('1785359896231')) && desc.includes('bloqueado');
      const isCuba100 = (intStr === '100' || otStr.includes('1785360410943')) && desc.includes('calefaccion');
      const isMusdalino90 = (intStr === '90' || otStr.includes('27850')) && desc.includes('perdida de aire');
      const isSosa155 = (intStr === '155' || otStr.includes('26926')) && desc.includes('piso de cabina lado izq');
      const isVolqueteNico = (intStr.includes('volquete') || otStr.includes('27779')) && desc.includes('ggz481');

      const isAllowedTodayTask = isPerino144 || isCuba100 || isMusdalino90 || isSosa155 || isVolqueteNico;

      if (isAllowedTodayTask) {
        keptTasksCount++;
        console.log(`✅ KEPT TASK: Int ${order.interno} | Mech ${task.empleado} | ${task.descripcion}`);
        return task;
      } else {
        if (task.status !== 'Finalizada') {
          archivedOthersCount++;
          console.log(`🧹 ARCHIVING non-today task: Int ${order.interno} | Mech ${task.empleado} | ${task.descripcion}`);
        }
        return {
          ...task,
          status: 'Finalizada',
          timerStart: null,
          timerStarted: false
        };
      }
    });

    return order;
  });

  console.log(`\nSummary: Kept ${keptTasksCount} tasks, archived ${archivedOthersCount} extra tasks.`);

  // Save to local db.json
  const dbData = {
    workOrders: cleanedOrders,
    catalogs: await get('/api/catalogs') || {},
    settings: await get('/api/settings') || {}
  };
  fs.writeFileSync('db.json', JSON.stringify(dbData, null, 2));

  console.log("Uploading cleaned DB to Railway...");
  const uploadRes = await post('/api/admin/upload-db', {
    secret: secret,
    dbData: dbData
  });

  console.log("Upload result:", uploadRes);

  // Also upload db.json to SSH server 192.168.50.4
  console.log("Uploading db.json to SSH server 192.168.50.4...");
  const { Client } = require('ssh2');
  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) return conn.end();
      sftp.fastPut('db.json', '/home/cbelocures/gestion/db.json', () => conn.end());
    });
  }).connect({
    host: '192.168.50.4',
    port: 22,
    username: 'cbelocures',
    password: 'CesarHernan3550'
  });
}

keepOnlyStrict5TodayTasks();
