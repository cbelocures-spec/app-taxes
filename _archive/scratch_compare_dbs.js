const fs = require('fs');

function inspectFile(filename) {
  console.log(`\n=================== ${filename} ===================`);
  try {
    const raw = fs.readFileSync(filename, 'utf8');
    const data = JSON.parse(raw);
    const orders = data.workOrders || data.orders || (Array.isArray(data) ? data : []);
    console.log(`Total orders: ${orders.length}`);

    let totalTasks = 0;
    let runningTasks = [];
    let archivedOrders = 0;

    orders.forEach(o => {
      if (o.archived || o.status === 'Archivada') archivedOrders++;
      (o.tasks || []).forEach(t => {
        totalTasks++;
        if (t && (t.timerStarted || (t.timerStart !== null && t.timerStart > 0))) {
          runningTasks.push({
            orderId: o.id,
            ot: o.taxesOrderNumber || o.id,
            interno: o.interno,
            rodado: o.rodado,
            desc: t.descripcion,
            empleado: t.empleado,
            timerStart: t.timerStart,
            timerStartFormatted: t.timerStart ? new Date(t.timerStart).toISOString() : 'N/A'
          });
        }
      });
    });

    console.log(`Archived orders: ${archivedOrders}`);
    console.log(`Total tasks: ${totalTasks}`);
    console.log(`Running tasks count: ${runningTasks.length}`);
    if (runningTasks.length > 0) {
      console.log('Sample running tasks (first 5):');
      runningTasks.slice(0, 5).forEach(t => {
        console.log(`  - OT: ${t.ot} | Interno: ${t.interno} | Mech: ${t.empleado} | Started: ${t.timerStartFormatted} | Desc: ${t.desc}`);
      });
      // Get min and max timerStart
      const starts = runningTasks.map(t => t.timerStart).filter(Boolean);
      if (starts.length > 0) {
        console.log(`Earliest timer start: ${new Date(Math.min(...starts)).toISOString()}`);
        console.log(`Latest timer start:   ${new Date(Math.max(...starts)).toISOString()}`);
      }
    }
  } catch (e) {
    console.error(`Error reading ${filename}: ${e.message}`);
  }
}

inspectFile('db.json');
inspectFile('db_live.json');
inspectFile('db_live_recovered.json');
