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
        const catalogEmp = dbData.catalogs ? dbData.catalogs.empleados || [] : [];
        const catalogCC = dbData.catalogs ? dbData.catalogs.centrosCosto || [] : [];

        console.log("=== CATALOG EMPLEADOS ===");
        console.log(JSON.stringify(catalogEmp.slice(0, 15), null, 2));

        console.log("=== ALL RAW TASKS EMPLEADO & CC VALUES ===");
        active.forEach(o => {
          (o.tasks || []).forEach((t, i) => {
            const empMatch = catalogEmp.find(e => String(e.value) === String(t.empleado));
            const ccMatch = catalogCC.find(c => String(c.value) === String(t.centroCosto));
            console.log(`OT: ${o.taxesOrderNumber || '—'} | Interno: ${o.interno} | Task #${i+1}: EmpRaw = "${t.empleado}" (${empMatch ? empMatch.label : 'NOT IN CATALOG'}) | CCRaw = "${t.centroCosto}" (${ccMatch ? ccMatch.label : 'NOT IN CATALOG'})`);
          });
        });

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
