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
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data.substring(0, 500) });
        }
      });
    }).on('error', (err) => { reject(err); });
  });
}

async function checkDetails() {
  console.log('--- ACTIVE MECHANICS ---');
  const mechanics = await get('/api/active-mechanics');
  console.log(JSON.stringify(mechanics.body, null, 2));

  console.log('--- CATALOGS ---');
  const catalogs = await get('/api/catalogs');
  if (catalogs.body) {
    console.log('Empleados count:', catalogs.body.empleados ? catalogs.body.empleados.length : 'none');
    console.log('Sample empleados:', catalogs.body.empleados ? catalogs.body.empleados.slice(0, 5) : []);
  }

  console.log('--- ORDERS STATUSES ---');
  const ordersRes = await get('/api/orders');
  if (Array.isArray(ordersRes.body)) {
    console.log('Total orders:', ordersRes.body.length);
    const statuses = {};
    ordersRes.body.forEach(o => {
      statuses[o.status] = (statuses[o.status] || 0) + 1;
    });
    console.log('Order status counts:', statuses);

    let tasksCount = 0;
    let runningTasks = 0;
    ordersRes.body.forEach(o => {
      if (o.tasks) {
        tasksCount += o.tasks.length;
        o.tasks.forEach(t => {
          if (t.status === 'in_progress' || t.status === 'paused' || t.isTimerRunning) {
            runningTasks++;
            console.log(`Task found: OT ${o.taxesOrderNumber || o.id}, Task: ${t.description}, Mechanic: ${t.assignedTo}, Status: ${t.status}, Running: ${t.isTimerRunning}`);
          }
        });
      }
    });
    console.log(`Total tasks across all orders: ${tasksCount}, active/paused tasks: ${runningTasks}`);
  }
}

checkDetails();
