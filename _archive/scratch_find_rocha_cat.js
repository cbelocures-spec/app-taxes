const fs = require('fs');

const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
const emps = db.catalogs?.empleados || [];

console.log("=== EMPLOYEES MATCHING RO... ===");
emps.forEach(e => {
  if (e.label.toLowerCase().includes('roc') || e.label.toLowerCase().includes('rocha')) {
    console.log(`  - [${e.value}] ${e.label}`);
  }
});

console.log("\n=== ALL TASKS THAT WERE FINALIZED TODAY OR RECENTLY ===");
const orders = db.workOrders || db.orders || [];
orders.forEach(o => {
  (o.tasks || []).forEach(t => {
    if (!t) return;
    if (t.timerHistory && t.timerHistory.length > 0) {
      console.log(`Task: OT=${o.taxesOrderNumber || o.id} | Int=${o.interno} | Status=${t.status} | Mech=${t.empleado} | Desc=${t.descripcion}`);
    }
  });
});
