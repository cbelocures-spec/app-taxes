const https = require('https');
const fs = require('fs');
const { Client } = require('ssh2');

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

async function keepOnlyRochaTaskOnDashboard() {
  console.log("Fetching orders from Railway...");
  const orders = await get('/api/orders/all');
  if (!Array.isArray(orders)) {
    console.error("Failed to fetch orders");
    return;
  }

  console.log(`Fetched ${orders.length} total orders.`);

  const now = Date.now();
  let rochaTaskActivated = false;
  let otherTasksFinalizedCount = 0;

  const cleanedOrders = orders.map(order => {
    if (!order.tasks || !Array.isArray(order.tasks)) return order;

    order.tasks = order.tasks.map(task => {
      if (!task) return task;

      const emp = String(task.empleado || '');
      const desc = String(task.descripcion || '').toLowerCase();

      const isRochaTask = (emp === '365' || emp.toLowerCase().includes('rocha')) && desc.includes('pisos cabina');

      if (isRochaTask) {
        rochaTaskActivated = true;
        console.log(`⚡ KEEPING ROCHA TASK ACTIVE: OT ${order.taxesOrderNumber || order.id} | Int ${order.interno} | Mech ${task.empleado} | ${task.descripcion}`);
        return {
          ...task,
          status: 'Pendiente',
          timerStart: now - (1800 * 1000), // 30 min running
          timerStarted: true,
          timerHistory: [
            { type: 'Inició', formatted: '07:00', timestamp: now - (1800 * 1000) }
          ]
        };
      } else {
        if (task.status !== 'Finalizada') {
          otherTasksFinalizedCount++;
          console.log(`🧹 FINALIZING OTHER DASHBOARD TASK: OT ${order.taxesOrderNumber || order.id} | Int ${order.interno} | Mech ${task.empleado} | ${task.descripcion}`);
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

  console.log(`\nRocha task activated: ${rochaTaskActivated}. Finalized ${otherTasksFinalizedCount} other tasks.`);

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
  console.log("Railway upload result:", uploadRes);

  console.log("Uploading cleaned DB to 192.168.50.4...");
  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) return conn.end();
      sftp.fastPut('db.json', '/home/cbelocures/gestion/db.json', () => {
        console.log("✅ Successfully uploaded to 192.168.50.4");
        conn.end();
      });
    });
  }).connect({
    host: '192.168.50.4',
    port: 22,
    username: 'cbelocures',
    password: 'CesarHernan3550'
  });
}

keepOnlyRochaTaskOnDashboard();
