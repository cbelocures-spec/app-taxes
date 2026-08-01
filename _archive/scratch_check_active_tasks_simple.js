const https = require('https');

https.get('https://app-taxes-production-ec67.up.railway.app/api/orders', {
  headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' }
}, res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    try {
      const orders = JSON.parse(body);
      console.log(`Returned ${orders.length} active orders.`);
      let totalPendingTasks = 0;
      orders.forEach(o => {
        const pending = (o.tasks || []).filter(t => t.status === 'Pendiente' || !t.status);
        if (pending.length > 0) {
          console.log(`- Order ${o.id} (Interno ${o.interno}, Rodado ${o.rodado}): ${pending.length} pending tasks`);
          pending.forEach(t => console.log(`    [${t.empleado}] ${t.descripcion}`));
          totalPendingTasks += pending.length;
        }
      });
      console.log(`Total active pending tasks: ${totalPendingTasks}`);
    } catch(e) {
      console.error(e.message);
    }
  });
}).on('error', console.error);
