const fs = require('fs');

const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
const orders = db.workOrders || db.orders || [];

console.log("=== TASKS ASSIGNED TO ROCHA (ID 365 / Rocha) ===");

orders.forEach(o => {
  (o.tasks || []).forEach(t => {
    if (!t) return;
    const emp = String(t.empleado || '');
    if (emp === '365' || emp.toLowerCase().includes('rocha')) {
      console.log(`OT ID: ${o.id} | OT #: ${o.taxesOrderNumber || 'Sin OT'} | Int: ${o.interno} | TaskID: ${t.id} | Status: ${t.status} | Mech: ${t.empleado} | Desc: ${t.descripcion}`);
    }
  });
});
