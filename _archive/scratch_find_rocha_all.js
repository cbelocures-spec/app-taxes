const fs = require('fs');

const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
const emps = db.catalogs?.empleados || [];

console.log("=== EMPLOYEES SEARCH FOR 'ROCHA' OR 'ROCH' OR 'R' ===");
emps.forEach(e => {
  if (e.label.toLowerCase().includes('rocha') || e.label.toLowerCase().includes('rocha')) {
    console.log(`EMPLOYEE MATCH: [${e.value}] ${e.label}`);
  }
});

const orders = db.workOrders || db.orders || [];
orders.forEach(o => {
  (o.tasks || []).forEach(t => {
    if (!t) return;
    const str = (JSON.stringify(t) + JSON.stringify(o)).toLowerCase();
    if (str.includes('rocha')) {
      console.log(`ORDER MATCH: OT=${o.taxesOrderNumber || o.id} | Int=${o.interno} | Task=${JSON.stringify(t)}`);
    }
  });
});
