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
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', (err) => { reject(err); });
  });
}

async function checkDetails() {
  const orders = await get('/api/orders');
  if (Array.isArray(orders)) {
    console.log(`Total active orders on Railway: ${orders.length}`);

    let workingCount = 0;
    let pausedCount = 0;
    let finishedCount = 0;

    orders.forEach(o => {
      (o.tasks || []).forEach(t => {
        if (!t) return;
        const isRunning = t.timerStarted || (t.timerStart !== null && t.timerStart > 0);
        if (isRunning) {
          workingCount++;
        } else if (t.status !== 'Finalizada') {
          pausedCount++;
        } else {
          finishedCount++;
        }
      });
    });

    console.log(`--- TASK STATS ON RAILWAY ---`);
    console.log(`Working tasks (running timers): ${workingCount}`);
    console.log(`Paused / Pending tasks:         ${pausedCount}`);
    console.log(`Finished tasks:                 ${finishedCount}`);
  }
}

checkDetails();
