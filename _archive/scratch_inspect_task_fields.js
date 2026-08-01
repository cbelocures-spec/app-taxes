const https = require('https');

const host = 'app-taxes-production-ec67.up.railway.app';
const username = 'paniol@contenedoreshugo.com.ar';

function get(path) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: host,
      path: path,
      headers: { 'x-user-username': username }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', err => resolve(null));
  });
}

async function inspectTaskFields() {
  const orders = await get('/api/orders');
  if (!Array.isArray(orders)) {
    console.error("Failed to fetch orders from Railway");
    return;
  }

  console.log(`Fetched ${orders.length} orders from Railway`);

  let totalTasks = 0;
  let timerStartNotNullCount = 0;
  let timerStartGtZeroCount = 0;
  let timerStartedTrueCount = 0;
  let statusNotFinalizadaCount = 0;

  const statuses = {};

  orders.forEach(o => {
    (o.tasks || []).forEach(t => {
      if (!t) return;
      totalTasks++;
      statuses[t.status] = (statuses[t.status] || 0) + 1;

      if (t.timerStart !== null) timerStartNotNullCount++;
      if (t.timerStart !== null && t.timerStart > 0) timerStartGtZeroCount++;
      if (t.timerStarted === true) timerStartedTrueCount++;
      if (t.status !== 'Finalizada') statusNotFinalizadaCount++;
    });
  });

  console.log(`Task Status Counts:`, statuses);
  console.log(`Total Tasks: ${totalTasks}`);
  console.log(`Tasks with status !== 'Finalizada': ${statusNotFinalizadaCount}`);
  console.log(`Tasks with timerStart !== null: ${timerStartNotNullCount}`);
  console.log(`Tasks with timerStart > 0: ${timerStartGtZeroCount}`);
  console.log(`Tasks with timerStarted === true: ${timerStartedTrueCount}`);

  if (totalTasks > 0) {
    console.log('\nSample tasks (first 5 non-finalized):');
    let sampleCount = 0;
    for (const o of orders) {
      for (const t of (o.tasks || [])) {
        if (t && t.status !== 'Finalizada' && sampleCount < 5) {
          sampleCount++;
          console.log(`Order ${o.taxesOrderNumber || o.id} | Task: ${t.descripcion}`);
          console.log(`  status: "${t.status}", timerStart: ${t.timerStart}, timerStarted: ${t.timerStarted}`);
          console.log(`  timerHistory:`, t.timerHistory);
        }
      }
    }
  }
}

inspectTaskFields();
