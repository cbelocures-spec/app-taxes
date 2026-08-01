const http = require('http');

http.get({
  hostname: '192.168.50.4',
  port: 80,
  path: '/api/orders',
  headers: {
    'x-user-username': 'paniol@contenedoreshugo.com.ar'
  }
}, (res) => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    try {
      const orders = JSON.parse(body);
      console.log(`=== GET /api/orders RETURNED ${orders.length} ORDERS ===`);
      const o155 = orders.find(o => String(o.interno) === '155' || o.taxesOrderNumber === '26926');
      const o119 = orders.find(o => String(o.interno) === '119' || o.taxesOrderNumber === '27889');

      console.log("Order 155 in API response:", o155 ? `Found! Tasks count: ${o155.tasks ? o155.tasks.length : 0}` : "NOT FOUND!");
      if (o155 && o155.tasks) {
        o155.tasks.forEach((t, i) => console.log(`   Task #${i+1}: status=${t.status} | timerStart=${t.timerStart} | desc=${t.descripcion}`));
      }

      console.log("Order 119 in API response:", o119 ? `Found! Tasks count: ${o119.tasks ? o119.tasks.length : 0}` : "NOT FOUND!");
      if (o119 && o119.tasks) {
        o119.tasks.forEach((t, i) => console.log(`   Task #${i+1}: status=${t.status} | timerStart=${t.timerStart} | desc=${t.descripcion}`));
      }

    } catch(e) {
      console.error("Parse error:", e.message, "Body snippet:", body.slice(0, 200));
    }
  });
});
