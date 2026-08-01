const fs = require('fs');

try {
  const data = JSON.parse(fs.readFileSync('./db.json', 'utf8'));
  const orders = (data.workOrders || []).filter(o => !o.archived && !o.deleted);

  console.log("=== ACTIVE ORDERS VERIFICATION STATUS ===");
  orders.forEach(o => {
    console.log(`OT: ${o.taxesOrderNumber || '—'} | ID: ${o.id} | Interno: ${o.interno} | syncStatus: ${o.syncStatus} | verifiedStatus: ${o.verifiedStatus} | verifiedError: ${o.verifiedError || 'None'}`);
  });
} catch(e) {
  console.error("Error reading db.json:", e.message);
}
