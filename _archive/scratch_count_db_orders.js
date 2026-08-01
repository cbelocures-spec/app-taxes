const fs = require('fs');

try {
  const data = JSON.parse(fs.readFileSync('./db.json', 'utf8'));
  const orders = data.workOrders || [];
  const active = orders.filter(o => !o.archived && !o.deleted);
  const archived = orders.filter(o => o.archived === true && !o.deleted);
  const deleted = orders.filter(o => o.deleted === true);
  console.log(`Total DB orders: ${orders.length} | Active: ${active.length} | Archived (Historial): ${archived.length} | Deleted log: ${deleted.length}`);
} catch (e) {
  console.error("Error reading db.json:", e.message);
}
