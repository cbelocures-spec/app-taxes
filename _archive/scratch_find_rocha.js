const fs = require('fs');

const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
const orders = db.workOrders || db.orders || [];

console.log("=== SEARCHING FOR ROCHA IN ALL ORDERS & TASKS ===");

orders.forEach(o => {
  (o.tasks || []).forEach(t => {
    if (!t) return;
    const emp = String(t.empleado || '').toLowerCase();
    const desc = String(t.descripcion || '').toLowerCase();
    const diag = String(t.diagnostico || '').toLowerCase();
    if (emp.includes('rocha') || desc.includes('rocha') || diag.includes('rocha')) {
      console.log(`FOUND ROCHA: Status=${t.status} | OT=${o.taxesOrderNumber || o.id} | Int=${o.interno} | Mech=${t.empleado} | Desc=${t.descripcion} | Start=${t.timerStart}`);
    }
  });
});
