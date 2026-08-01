const https = require('https');

function check() {
  https.get('https://app-taxes-production-ec67.up.railway.app/api/orders', {
    headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' }
  }, res => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      try {
        const orders = JSON.parse(body);
        console.log("=== ACTIVE ORDERS & PENDING TASKS ON RAILWAY ===");
        let count = 0;
        orders.forEach(o => {
          (o.tasks || []).forEach(t => {
            if (t.status === 'Pendiente' || !t.status) {
              count++;
              console.log(`[#${count}] OT Interno ${o.interno} (${o.rodado}):`);
              console.log(`     Empleado: ${t.empleado}`);
              console.log(`     Descripcion: ${t.descripcion}`);
              console.log(`     Horas: ${t.horasEstimadas} hs\n`);
            }
          });
        });
        console.log(`TOTAL ACTIVE PENDING TASKS: ${count}`);
      } catch(e) {
        console.error(e.message);
      }
    });
  });
}

check();
