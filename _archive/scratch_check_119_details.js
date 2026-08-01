const fs = require('fs');

const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
const orders119 = (db.workOrders || []).filter(o => String(o.interno) === '119' || (o.rodado && o.rodado.includes('119')));

console.log(`Found ${orders119.length} orders for 119 in db.json:`);
orders119.forEach((o, i) => {
  console.log(`\nOrder #${i+1}: ID=${o.id}, Clasificacion="${o.clasificacion}", Archived=${o.archived}, Deleted=${o.deleted}, Status="${o.status}"`);
  console.log(`  Rodado: "${o.rodado}"`);
  console.log(`  TaxesOrderNumber: "${o.taxesOrderNumber}"`);
  console.log(`  Tasks (${(o.tasks || []).length}):`);
  (o.tasks || []).forEach((t, ti) => {
    console.log(`    - Task #${ti+1}: ID=${t.id}, Emp="${t.empleado}", Status="${t.status}", Synced=${t.synced}, Desc="${t.descripcion}"`);
  });
});
