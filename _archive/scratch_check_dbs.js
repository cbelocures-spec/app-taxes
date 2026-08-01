const fs = require('fs');

['db.json', 'db_live.json', 'db_live_recovered.json', 'prod_orders.json'].forEach(file => {
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const orders = Array.isArray(data) ? data : (data.orders || []);
      console.log(`File ${file}: ${orders.length} orders`);
      
      let running = 0;
      orders.forEach(o => {
        (o.tasks || []).forEach(t => {
          if (t && (t.timerStarted || (t.timerStart !== null && t.timerStart > 0))) {
            running++;
            console.log(`  [${file}] Running task in OT ${o.taxesOrderNumber || o.id}: ${t.descripcion} (Mechanic: ${t.empleado})`);
          }
        });
      });
      console.log(`  Total running timers in ${file}: ${running}`);
    } catch (e) {
      console.error(`Error parsing ${file}: ${e.message}`);
    }
  } else {
    console.log(`File ${file} does not exist`);
  }
});
