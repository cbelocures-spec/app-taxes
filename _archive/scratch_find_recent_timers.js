const fs = require('fs');

function inspectTimers(filename) {
  if (!fs.existsSync(filename)) return;
  console.log(`\n================ ${filename} ================`);
  const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const orders = data.workOrders || data.orders || (Array.isArray(data) ? data : []);

  const tasksWithTimers = [];

  orders.forEach(o => {
    (o.tasks || []).forEach(t => {
      if (t && (t.timerStarted || (t.timerStart !== null && t.timerStart > 0))) {
        tasksWithTimers.push({
          orderId: o.id,
          ot: o.taxesOrderNumber || o.id,
          interno: o.interno,
          rodado: o.rodado,
          clasificacion: o.clasificacion,
          empleado: t.empleado,
          descripcion: t.descripcion,
          timerStart: t.timerStart,
          timerStartISO: t.timerStart ? new Date(t.timerStart).toISOString() : 'N/A',
          createdAt: o.createdAt,
          timerHistory: t.timerHistory
        });
      }
    });
  });

  console.log(`Found ${tasksWithTimers.length} tasks with active timers.`);

  // Sort by timerStart descending (newest first)
  tasksWithTimers.sort((a, b) => (b.timerStart || 0) - (a.timerStart || 0));

  console.log('Top 10 most recent active timer tasks:');
  tasksWithTimers.slice(0, 10).forEach((t, i) => {
    console.log(`${i+1}. OT ${t.ot} (Interno ${t.interno}) | Mech: ${t.empleado} | Sector: ${t.clasificacion}`);
    console.log(`   Start: ${t.timerStartISO} | Desc: ${t.descripcion}`);
    if (t.timerHistory) console.log(`   History:`, JSON.stringify(t.timerHistory));
  });
}

inspectTimers('db.json');
inspectTimers('db_live.json');
inspectTimers('db_live_recovered.json');
