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
        
        console.log(`=== ACTIVE WORK ORDERS COUNT: ${active.length} ===`);
        
        active.forEach(o => {
          const isH = String(o.clasificacion || '').toLowerCase().includes('herrer');
          const isE = String(o.clasificacion || '').toLowerCase().includes('edilic');
          const pendingTasks = (o.tasks || []).filter(t => t.status !== 'Finalizada');

          console.log(`OT: ${o.taxesOrderNumber || '—'} | Interno: ${o.interno} | Clasificación: ${o.clasificacion} | isHerreria: ${isH} | isEdilicio: ${isE} | Pending Tasks Count: ${pendingTasks.length}`);
          pendingTasks.forEach(t => {
            console.log(`   └─ Task ID: ${t.id} | Desc: ${t.descripcion} | Emp: ${t.empleado} | Status: ${t.status} | timerStart: ${t.timerStart}`);
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
