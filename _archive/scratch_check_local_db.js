const fs = require('fs');

const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
const orders = db.workOrders || db.orders || [];
const catalogs = db.catalogs || {};

console.log("=== LOCAL DB.JSON CHECK ===");
console.log("WorkOrders count:", orders.length);
console.log("Catalogs empleados count:", (catalogs.empleados || []).length);
console.log("Catalogs rodados count:  ", (catalogs.rodados || []).length);

const activeOrders = orders.filter(o => !o.deleted && o.status !== 'Archivada');
console.log("Active (non-deleted) orders count:", activeOrders.length);

let dashboardTasks = [];
activeOrders.forEach(o => {
  (o.tasks || []).forEach(t => {
    if (t && t.status !== 'Finalizada') {
      dashboardTasks.push({ ot: o.taxesOrderNumber || o.id, int: o.interno, desc: t.descripcion, mech: t.empleado, start: t.timerStart });
    }
  });
});
console.log(`\nActive Dashboard Tasks (${dashboardTasks.length}):`);
dashboardTasks.forEach(dt => console.log(`  - [${dt.start > 0 ? 'WORKING' : 'PAUSED'}] OT ${dt.ot} | Int ${dt.int} | Mech: ${dt.mech} | ${dt.desc}`));
