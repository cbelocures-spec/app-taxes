const http = require('http');

const testOrder = {
  rodado: "Interno 999",
  responsable: "Belocures, Cesar Hernán",
  interno: "999",
  clasificacion: "Correctivo",
  fechaEntrega: new Date().toISOString().split('T')[0],
  horario: "12:00",
  incidente: "Prueba de persistencia de tareas múltiples",
  tasks: [
    {
      centroCosto: "15",
      empleado: "426",
      horasEstimadas: "1.5",
      status: "Pendiente",
      descripcion: "Tarea 1: Cambiar aceite"
    },
    {
      centroCosto: "15",
      empleado: "426",
      horasEstimadas: "2.0",
      status: "Pendiente",
      descripcion: "Tarea 2: Ajustar frenos"
    },
    {
      centroCosto: "15",
      empleado: "426",
      horasEstimadas: "1.0",
      status: "Pendiente",
      descripcion: "Tarea 3: Revisar luces"
    }
  ],
  estadoUnidad: "operativo"
};

const postData = JSON.stringify(testOrder);

const req = http.request({
  hostname: '192.168.50.4',
  port: 80,
  path: '/api/orders',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
    'x-user-username': 'paniol@contenedoreshugo.com.ar'
  }
}, (res) => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    console.log("=== POST /api/orders RESPONSE STATUS:", res.statusCode);
    try {
      const created = JSON.parse(body);
      console.log("Created Order ID:", created.id);
      console.log("Tasks count returned in response:", (created.tasks || []).length);
      
      // Now fetch order by ID from GET /api/orders to verify persistence
      http.get(`http://192.168.50.4/api/orders`, (res2) => {
        let body2 = '';
        res2.on('data', c => body2 += c);
        res2.on('end', () => {
          const allOrders = JSON.parse(body2);
          const found = allOrders.find(o => o.id === created.id);
          if (found) {
            console.log("✅ Order found in database! Saved tasks count:", (found.tasks || []).length);
            (found.tasks || []).forEach((t, i) => {
              console.log(`   Task #${i+1}: ID=${t.id} | Desc=${t.descripcion} | Status=${t.status}`);
            });
          } else {
            console.error("❌ Order not found in database!");
          }
        });
      });
    } catch(e) {
      console.error("Parse error:", e.message, "Body:", body);
    }
  });
});

req.on('error', (e) => {
  console.error("Request error:", e.message);
});

req.write(postData);
req.end();
