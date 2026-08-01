const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec("cat /home/cbelocures/data/db.json", (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      try {
        const dbData = JSON.parse(out);
        const activeOrders = (dbData.workOrders || []).filter(o => !o.archived && !o.deleted);
        console.log(`=== CHECKING ${activeOrders.length} ACTIVE ORDERS ON 192.168.50.4 ===`);

        const missing = [];
        activeOrders.forEach(o => {
          (o.tasks || []).forEach((t, idx) => {
            const empEmpty = !t.empleado || t.empleado === '' || t.empleado === '—' || t.empleado === 'Desconocido';
            const ccEmpty = !t.centroCosto || t.centroCosto === '' || t.centroCosto === '—';
            if (empEmpty || ccEmpty) {
              missing.push({
                orderId: o.id,
                otNumber: o.taxesOrderNumber || '—',
                interno: o.interno,
                rodado: o.rodado,
                clasificacion: o.clasificacion,
                taskIdx: idx + 1,
                taskDesc: t.descripcion,
                empleado: t.empleado || '(VACÍO)',
                centroCosto: t.centroCosto || '(VACÍO)',
                responsable: o.responsable,
                createdBy: o.createdBy
              });
            }
          });
        });

        console.log(`Found ${missing.length} tasks on 192.168.50.4 with missing/unknown Empleado or Centro Costo:`);
        console.log(JSON.stringify(missing, null, 2));

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
