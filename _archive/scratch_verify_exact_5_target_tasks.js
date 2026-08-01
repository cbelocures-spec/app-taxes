const fs = require('fs');

const dbData = JSON.parse(fs.readFileSync('./db.json', 'utf8'));
const o155 = (dbData.workOrders || []).find(o => String(o.interno) === '155' || o.taxesOrderNumber === '26926');
const o119 = (dbData.workOrders || []).find(o => String(o.interno) === '119' || o.taxesOrderNumber === '27889');

console.log("=== INTERNO 155 TASKS ===");
(o155.tasks || []).forEach((t, i) => {
  console.log(`Task #${i+1}: ID=${t.id} | Status=${t.status} | Emp=${t.empleado} | Desc=${t.descripcion}`);
});

console.log("=== INTERNO 119 TASKS ===");
(o119.tasks || []).forEach((t, i) => {
  console.log(`Task #${i+1}: ID=${t.id} | Status=${t.status} | Emp=${t.empleado} | Desc=${t.descripcion}`);
});
