const http = require('http');

http.get('http://192.168.50.4/api/orders', { headers: { 'x-user-username': 'paniol@contenedoreshugo.com.ar' } }, res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    try {
      const orders = JSON.parse(body);
      console.log(`=== ACTIVE ORDERS ON DEBIAN API: ${orders.length} ===`);
      let taskCount = 0;
      orders.forEach(o => {
        console.log(`OT Interno ${o.interno} (${o.rodado}) - Tasks count: ${o.tasks.length}`);
        o.tasks.forEach(t => {
          taskCount++;
          console.log(`  [${taskCount}] ${t.empleado} - Status: ${t.status} - TimerStart: ${t.timerStart}`);
        });
      });
      console.log(`TOTAL ACTIVE TASKS ON DEBIAN: ${taskCount}`);
    } catch(e) { console.error("Parse error:", e.message); }
  });
}).on('error', e => console.error(e.message));
