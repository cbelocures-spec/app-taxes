const https = require('https');

const RAILWAY_HOST = 'app-taxes-production-ec67.up.railway.app';

function getOrders() {
  return new Promise((resolve) => {
    https.get({
      hostname: RAILWAY_HOST,
      path: '/api/orders/all',
      headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

function putOrder(id, data) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(data);
    const req = https.request({
      hostname: RAILWAY_HOST,
      path: `/api/orders/${id}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-user-username': 'paniol@contenedoreshugo.com.ar',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', err => resolve({ error: err.message }));
    req.write(payload);
    req.end();
  });
}

async function run() {
  const orders = await getOrders();
  const o119 = orders.find(o => String(o.interno) === '119');

  console.log("=== INSPECTING ORDER 119 ON RAILWAY ===");
  if (o119) {
    console.log(`ID: ${o119.id}, Interno: ${o119.interno}, Archived: ${o119.archived}, Deleted: ${o119.deleted}, Status: ${o119.status}`);
    
    // Restore order 119 to active status
    o119.archived = false;
    o119.deleted = false;
    o119.status = 'Pendiente';
    o119.tasks = [
      {
        id: "task-119-morel-1",
        centroCosto: "15",
        empleado: "Morel, Luis Maximiliano",
        horasEstimadas: 4.5,
        status: "Pendiente",
        descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
        timerStart: null,
        timerStarted: false
      },
      {
        id: "task-119-canaviri-2",
        centroCosto: "15",
        empleado: "Canaviri Fernandez, Jesús",
        horasEstimadas: 4.5,
        status: "Pendiente",
        descripcion: "armado motor y todo el pereferico turbo multiple bomba agua y aceite etc",
        timerStart: null,
        timerStarted: false
      }
    ];

    const res = await putOrder(o119.id, o119);
    console.log("Updated 119 response:", res);
  } else {
    console.log("Order 119 not found on Railway");
  }
}

run();
