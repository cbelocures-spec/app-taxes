const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("cat /home/cbelocures/data/db.json", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      try {
        const dbData = JSON.parse(out);
        const active = (dbData.workOrders || []).filter(o => !o.archived && !o.deleted && o.status !== 'Archivada' && o.status !== 'Eliminada');
        
        console.log(`=== TOTAL ACTIVE ORDERS: ${active.length} ===`);
        
        const o155 = active.find(o => String(o.interno) === '155' || o.taxesOrderNumber === '26926');
        const o119 = active.find(o => String(o.interno) === '119' || o.taxesOrderNumber === '27889');

        if (o155) {
          console.log("=== ORDER 155 (OT 26926) ===");
          console.log("Sector/Clasif:", o155.clasificacion);
          console.log("Tasks count:", (o155.tasks || []).length);
          (o155.tasks || []).forEach((t, i) => {
            console.log(`  Task #${i+1}: ID=${t.id} | Status=${t.status} | Emp=${t.empleado} | Desc=${t.descripcion}`);
          });
        } else {
          console.error("❌ Order 155 NOT FOUND!");
        }

        if (o119) {
          console.log("=== ORDER 119 (OT 27889) ===");
          console.log("Sector/Clasif:", o119.clasificacion);
          console.log("Tasks count:", (o119.tasks || []).length);
          (o119.tasks || []).forEach((t, i) => {
            console.log(`  Task #${i+1}: ID=${t.id} | Status=${t.status} | Emp=${t.empleado} | Desc=${t.descripcion}`);
          });
        } else {
          console.error("❌ Order 119 NOT FOUND!");
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
