const fs = require('fs');
const https = require('https');

const dbPath = 'db.json';
const host = 'app-taxes-production-ec67.up.railway.app';
const secret = 'Paniol2015';

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

function fixLocalDbAndUpload() {
  console.log("Reading local db.json...");
  if (!fs.existsSync(dbPath)) {
    console.error("db.json not found!");
    return;
  }

  const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const orders = dbData.workOrders || dbData.orders || [];

  let fixedCount = 0;

  orders.forEach(order => {
    if (!order.tasks || !Array.isArray(order.tasks)) return;

    order.tasks = order.tasks.map(task => {
      if (!task) return task;

      const desc = (task.descripcion || '').toLowerCase();
      const horas = parseFloat(String(task.horasEstimadas).replace(',', '.')) || 0;

      if (desc.includes('manija') || horas > 10 || (task.timerHistory && task.timerHistory.some(h => h.timestamp < 1785300000000))) {
        fixedCount++;
        console.log(`🔧 Correcting Task: OT ${order.taxesOrderNumber || order.id} (Int ${order.interno}) | Desc: ${task.descripcion} | Old Horas: ${task.horasEstimadas} -> New Horas: 1.00 (Finalizada)`);
        return {
          ...task,
          horasEstimadas: 1.00,
          timerStart: null,
          timerStarted: false,
          status: 'Finalizada'
        };
      }
      return task;
    });
  });

  console.log(`\nCorrected ${fixedCount} tasks in local db.json.`);

  // Write back local db.json
  fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2));

  console.log("Uploading updated db.json to Railway...");
  post('/api/admin/upload-db', {
    secret: secret,
    dbData: {
      workOrders: orders
    }
  }).then(res => {
    console.log("Upload result:", res);
  });
}

fixLocalDbAndUpload();
