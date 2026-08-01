const fs = require('fs');

const dbPath = 'db.json';
const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const orders = dbData.workOrders || dbData.orders || [];

console.log(`=== AUDITING ${orders.length} ORDERS FOR SYNC & VERIFICATION ERRORS ===\n`);

let syncErrors = [];
let pendingSync = [];
let verifyErrors = [];

orders.forEach(o => {
  const ot = o.taxesOrderNumber || o.id;
  const int = o.interno || 'Sin Int';

  if (o.syncStatus === 'error' || o.syncError) {
    syncErrors.push({ ot, int, error: o.syncError, status: o.syncStatus });
  }

  if (o.syncStatus === 'pending') {
    pendingSync.push({ ot, int, status: o.syncStatus });
  }

  if (o.verifiedStatus === 'error' || o.verifiedError) {
    verifyErrors.push({ ot, int, error: o.verifiedError, status: o.verifiedStatus });
  }
});

console.log(`❌ ORDERS WITH SYNC ERROR (${syncErrors.length}):`);
syncErrors.forEach(s => console.log(`   - OT ${s.ot} (Int ${s.int}): ${s.error}`));

console.log(`\n⏳ ORDERS PENDING SYNC (${pendingSync.length}):`);
pendingSync.forEach(p => console.log(`   - OT ${p.ot} (Int ${p.int})`));

console.log(`\n⚠️ ORDERS WITH VERIFICATION ERROR (${verifyErrors.length}):`);
verifyErrors.forEach(v => console.log(`   - OT ${v.ot} (Int ${v.int}): ${v.error}`));
