const fs = require('fs');

const dbPath = 'db.json';
const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const orders = dbData.workOrders || dbData.orders || [];

function isHerreriaOrder(order) {
  if (!order) return false;
  const cls = String(order.clasificacion || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  if (cls.includes('herreria')) return true;
  const desc = String(order.descripcion || '').toLowerCase();
  if (desc.includes('herreria')) return true;
  const tasks = order.tasks || [];
  return tasks.some(t => {
    const td = String(t.descripcion || '').toLowerCase();
    return td.includes('herreria') || td.includes('soldadura') || td.includes('paragolpe') || td.includes('volquete');
  });
}

console.log("=== INSPECTING ALL HERRERÍA ORDERS FOR ERRORS ===");

let herreriaOrders = [];
orders.forEach(o => {
  if (isHerreriaOrder(o)) {
    herreriaOrders.push(o);
  }
});

console.log(`Found ${herreriaOrders.length} total Herrería orders.\n`);

herreriaOrders.forEach(o => {
  const ot = o.taxesOrderNumber || o.id;
  const int = o.interno || 'Sin Int';
  const syncStatus = o.syncStatus;
  const syncError = o.syncError;
  const verifiedStatus = o.verifiedStatus;
  const verifiedError = o.verifiedError;

  const hasErr = syncStatus === 'error' || syncError || verifiedStatus === 'error' || verifiedError;

  if (hasErr) {
    console.log(`❌ HERRERÍA ORDER WITH ERROR: OT ${ot} | Int ${int} | Status: ${o.status}`);
    console.log(`   - syncStatus: ${syncStatus} | syncError: ${syncError}`);
    console.log(`   - verifiedStatus: ${verifiedStatus} | verifiedError: ${verifiedError}`);
    console.log(`   - Tasks: ${JSON.stringify(o.tasks, null, 2)}\n`);
  }
});
