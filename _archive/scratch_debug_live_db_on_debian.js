const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log("=== SSH CONNECTED ===");
  conn.exec("curl -s http://localhost:3000/api/orders", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      try {
        const orders = JSON.parse(out);
        console.log(`API returned ${orders.length} orders.`);
        const o155 = orders.find(o => String(o.interno) === '155' || o.taxesOrderNumber === '26926');
        const o119 = orders.find(o => String(o.interno) === '119' || o.taxesOrderNumber === '27889');

        console.log("=== API ORDER 155 ===");
        if (o155) {
          console.log("Tasks count:", (o155.tasks || []).length);
          (o155.tasks || []).forEach((t, i) => console.log(`   Task #${i+1}: id=${t.id} | status=${t.status} | timerStart=${t.timerStart} | desc=${t.descripcion}`));
        } else {
          console.error("Order 155 NOT FOUND in API response!");
        }

        console.log("=== API ORDER 119 ===");
        if (o119) {
          console.log("Tasks count:", (o119.tasks || []).length);
          (o119.tasks || []).forEach((t, i) => console.log(`   Task #${i+1}: id=${t.id} | status=${t.status} | timerStart=${t.timerStart} | desc=${t.descripcion}`));
        } else {
          console.error("Order 119 NOT FOUND in API response!");
        }

      } catch(e) {
        console.error("JSON error:", e.message, "Output snippet:", out.slice(0, 200));
      }
      conn.end();
    });
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550',
  readyTimeout: 30000
});
