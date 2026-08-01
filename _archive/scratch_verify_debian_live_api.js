const http = require('http');

http.get('http://192.168.50.4/api/orders', res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    try {
      const orders = JSON.parse(body);
      console.log("=== LIVE DEBIAN GET /api/orders VERIFICATION ===");
      let count = 0;
      orders.forEach(o => {
        (o.tasks || []).forEach(t => {
          if (t.status === 'Pendiente' || !t.status) {
            count++;
            console.log(`[#${count}] OT Interno ${o.interno} (${o.rodado}):`);
            console.log(`     Empleado: ${t.empleado}`);
            console.log(`     TimerStart: ${t.timerStart} (Started: ${t.timerStarted})`);
            console.log(`     Descripcion: ${t.descripcion}\n`);
          }
        });
      });
      console.log(`TOTAL ACTIVE PENDING TASKS ON LIVE DEBIAN: ${count}`);
    } catch(e) {
      console.error("JSON parse error:", e.message);
    }
  });
}).on('error', e => console.error("HTTP error:", e.message));
