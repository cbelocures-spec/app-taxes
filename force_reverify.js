/**
 * Script to force re-verify specific OTs on Taxes and update Railway status.
 * Run: node force_reverify.js
 */
const worker = require('./syncWorker');
const db = require('./database');

const HOST = 'app-taxes-production-ec67.up.railway.app';

async function apiCall(method, path, body) {
  const res = await fetch(`https://${HOST}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

async function forceReverify(orderId, interno, taxesOT) {
  console.log(`\n--- Force re-verifying OT#${interno} (taxesOT: ${taxesOT}, ID: ${orderId}) ---`);

  // Create order temporarily in local DB so syncWorkOrder can work on it
  const existing = db.getWorkOrderById(orderId);
  if (!existing) {
    // Fetch from Railway to get full data
    const allOrders = await apiCall('GET', '/api/orders/all', null);
    const target = allOrders.find(o => o.id === orderId);
    if (!target) {
      console.error(`  Order ${orderId} not found on Railway!`);
      return;
    }
    console.log(`  Creating local copy for sync...`);
    db.createWorkOrder(target);
    db.updateWorkOrder(orderId, {
      syncStatus: target.syncStatus,
      syncError: target.syncError,
      syncDate: target.syncDate,
      verifiedStatus: target.verifiedStatus,
      verifiedError: target.verifiedError,
      verifiedCount: target.verifiedCount,
      taxesOrderNumber: target.taxesOrderNumber,
      tasks: target.tasks,
      archived: target.archived
    });
  }

  // Run full re-sync (reconcile + verify)
  try {
    console.log(`  Running syncWorkOrder...`);
    const result = await worker.syncWorkOrder(orderId);
    console.log(`  Result:`, result);

    // Get updated local data
    const updated = db.getWorkOrderById(orderId);
    if (updated) {
      console.log(`  Local result → sync:${updated.syncStatus} verified:${updated.verifiedStatus}`);

      // Push to Railway
      const payload = {
        syncStatus: updated.syncStatus,
        syncError: updated.syncError,
        syncDate: updated.syncDate,
        tasks: updated.tasks,
        verifiedStatus: updated.verifiedStatus,
        verifiedError: updated.verifiedError,
        verifiedCount: updated.verifiedCount,
        taxesOrderNumber: updated.taxesOrderNumber,
        archived: !!updated.archived
      };
      const uploaded = await apiCall('POST', `/api/orders/local-sync-result/${orderId}`, payload);
      console.log(`  Railway upload:`, uploaded);
    }
  } catch (err) {
    console.error(`  Error:`, err.message);
    // Push error to Railway
    await apiCall('POST', `/api/orders/local-sync-result/${orderId}`, {
      syncStatus: 'error',
      syncError: err.message
    }).catch(() => {});
  }
}

async function main() {
  console.log('Fetching all orders from Railway...');
  const allOrders = await apiCall('GET', '/api/orders/all', null);

  // Orders that need re-verification (verified: error with a taxesOrderNumber)
  const broken = allOrders.filter(o =>
    o.verifiedStatus === 'error' && o.taxesOrderNumber && o.syncStatus !== 'syncing'
  );

  console.log(`Found ${broken.length} orders needing re-verification:`);
  broken.forEach(o => console.log(`  OT#${o.interno} taxesOT:${o.taxesOrderNumber} (${o.id})`));

  for (const o of broken) {
    await forceReverify(o.id, o.interno, o.taxesOrderNumber);
  }

  console.log('\nDone!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
