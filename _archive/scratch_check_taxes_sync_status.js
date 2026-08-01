const fs = require('fs');

try {
  const data = JSON.parse(fs.readFileSync('./db.json', 'utf8'));
  const orders = data.workOrders || [];
  
  const successCount = orders.filter(o => o.syncStatus === 'success').length;
  const pendingCount = orders.filter(o => o.syncStatus === 'pending').length;
  const errorCount = orders.filter(o => o.syncStatus === 'error').length;
  const otherCount = orders.filter(o => !['success', 'pending', 'error'].includes(o.syncStatus)).length;

  console.log(`=== SYNC STATUS BREAKDOWN FOR ALL 543 ORDERS ===`);
  console.log(`✅ Synced to Taxes (success): ${successCount}`);
  console.log(`⏳ Pending sync (pending): ${pendingCount}`);
  console.log(`❌ Sync Error (error): ${errorCount}`);
  console.log(`ℹ️ Other / null: ${otherCount}`);
} catch (e) {
  console.error("Error checking sync status:", e.message);
}
