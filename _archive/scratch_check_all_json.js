const fs = require('fs');

const files = fs.readdirSync('.').filter(f => f.endsWith('.json'));

files.forEach(f => {
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const orders = data.workOrders || data.orders || (Array.isArray(data) ? data : null);
    if (orders) {
      console.log(`File: ${f} -> ${orders.length} orders`);
      let runningCount = 0;
      orders.forEach(o => {
        (o.tasks || []).forEach(t => {
          if (t && (t.timerStarted || (t.timerStart !== null && t.timerStart > 0))) {
            runningCount++;
          }
        });
      });
      console.log(`  -> Active timers count: ${runningCount}`);
    }
  } catch (e) {
    // ignore
  }
});
