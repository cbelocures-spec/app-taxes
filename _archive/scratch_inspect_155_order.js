const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("cat /home/cbelocures/data/db.json", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      try {
        const dbData = JSON.parse(out);
        const order155 = (dbData.workOrders || []).find(o => String(o.interno) === '155' || o.taxesOrderNumber === '26926');
        console.log("=== INSPECTING INTERNO 155 / OT 26926 IN DB ===");
        if (order155) {
          console.log("Order ID:", order155.id);
          console.log("Taxes OT:", order155.taxesOrderNumber);
          console.log("Interno:", order155.interno);
          console.log("Clasificación:", order155.clasificacion);
          console.log("Archived?:", order155.archived || order155.status === 'Archivada');
          console.log("Tasks Count:", (order155.tasks || []).length);
          (order155.tasks || []).forEach((t, i) => {
            console.log(`   Task #${i+1}: ID=${t.id} | Desc=${t.descripcion} | Status=${t.status} | timerStart=${t.timerStart}`);
          });
        } else {
          console.error("❌ Order 155 / 26926 not found in workOrders!");
        }
      } catch(e) {
        console.error("JSON error:", e.message);
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
