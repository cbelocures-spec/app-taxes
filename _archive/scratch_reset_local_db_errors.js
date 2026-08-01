const fs = require('fs');

const dbPath = 'db.json';
if (!fs.existsSync(dbPath)) {
  console.error("db.json not found!");
  process.exit(1);
}

const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const orders = dbData.workOrders || dbData.orders || [];

let resetCount = 0;

orders.forEach(order => {
  if (order.syncStatus === 'error') {
    resetCount++;
    console.log(`Resetting error for OT ${order.id} (Int ${order.interno}) | Prev error: ${order.syncError}`);
    order.syncStatus = 'pending';
    order.syncError = null;
  }
});

console.log(`Reset ${resetCount} orders to pending in db.json.`);
fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2));
