const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("cat /home/cbelocures/data/db.json", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      try {
        const dbData = JSON.parse(out);
        const active = (dbData.workOrders || []).filter(o => !o.archived && !o.deleted);
        console.log(`=== ACTIVE ORDERS ON 192.168.50.4 (Total: ${active.length}) ===`);
        active.slice(0, 10).forEach((o, idx) => {
          console.log(`Order #${idx+1} | ID: ${o.id} | Interno: ${o.interno} | Clasificación: ${o.clasificacion} | Tasks Count: ${(o.tasks || []).length}`);
          (o.tasks || []).forEach(t => {
            console.log(`   └─ Task ID: ${t.id} | Desc: ${t.descripcion} | Status: ${t.status} | Emp: ${t.empleado} | CC: ${t.centroCosto}`);
          });
        });
      } catch(e) {
        console.error("JSON parse error:", e.message);
      }
      conn.end();
    });
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
});
