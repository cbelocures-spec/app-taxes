const https = require('https');
const worker = require('./syncWorker');
const db = require('./database');

const HOST = 'app-taxes-production-ec67.up.railway.app';
const USERNAME = 'paniol@contenedoreshugo.com.ar';
const POLL_INTERVAL_MS = 20000; // 20 seconds

function apiCall(method, path, bodyData, callback) {
  const options = {
    hostname: HOST,
    path: path,
    method: method,
    headers: {
      'x-user-username': USERNAME,
    }
  };

  let payload = '';
  if (bodyData) {
    payload = JSON.stringify(bodyData);
    options.headers['Content-Type'] = 'application/json';
    options.headers['Content-Length'] = Buffer.byteLength(payload);
  } else {
    options.headers['Content-Length'] = 0;
  }

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => { callback(null, data); });
  });
  req.setTimeout(15000, () => {
    req.destroy(new Error('Request timeout (15s)'));
  });
  req.on('error', (err) => { callback(err); });
  if (bodyData) req.write(payload);
  req.end();
}

let isAgentRunning = false;

async function checkAndSync() {
  if (isAgentRunning) return;
  isAgentRunning = true;

  try {
    // 1. Fetch ALL orders (active + archived) from Railway
    apiCall('GET', '/api/orders/all', null, async (err, rawData) => {
      if (err) {
        console.error('[RailwayAgent] Error fetching orders:', err.message);
        isAgentRunning = false;
        return;
      }

      let orders = [];
      try {
        orders = JSON.parse(rawData);
      } catch (e) {
        console.error('[RailwayAgent] Parse error:', e.message);
        isAgentRunning = false;
        return;
      }

      if (!Array.isArray(orders)) {
        console.error('[RailwayAgent] Received non-array response from Railway:', orders);
        isAgentRunning = false;
        return;
      }
      // 1.5 Delete local orders not present on Railway to keep databases in sync (ONLY if Railway returned valid orders)
      if (orders.length > 0) {
        try {
          const localAll = db.read().workOrders || [];
          const railwayIds = new Set(orders.map(o => o.id));
          const idsToDelete = localAll.filter(o => !railwayIds.has(o.id)).map(o => o.id);
          if (idsToDelete.length > 0) {
            console.log(`[RailwayAgent] Deleting ${idsToDelete.length} local orders not present on Railway...`);
            db.deleteWorkOrders(idsToDelete);
          }
        } catch (pruneErr) {
          console.error('[RailwayAgent] Error pruning local database:', pruneErr.message);
        }
      }

      // 2. Synchronize all Railway orders with the local database copy
      for (const target of orders) {
        try {
          const existing = db.getWorkOrderById(target.id);
          const isArchivedLocallyOrRemotely = existing ? (existing.archived === true || target.archived === true) : (target.archived === true);
          if (!existing) {
            // Create locally and preserve original values
            db.createWorkOrder(target);
            db.updateWorkOrder(target.id, {
              syncStatus: target.syncStatus,
              syncError: target.syncError,
              syncDate: target.syncDate,
              verifiedStatus: target.verifiedStatus,
              verifiedError: target.verifiedError,
              verifiedCount: target.verifiedCount,
              taxesOrderNumber: target.taxesOrderNumber,
              tasks: target.tasks,
              archived: isArchivedLocallyOrRemotely
            });
          } else {
            // Update fields if it is not currently syncing locally
            if (existing.syncStatus !== 'syncing') {
              db.updateWorkOrder(target.id, {
                rodado: target.rodado,
                responsable: target.responsable,
                fechaEntrega: target.fechaEntrega,
                horario: target.horario,
                interno: target.interno,
                clasificacion: target.clasificacion,
                incidente: target.incidente,
                syncStatus: target.syncStatus,
                syncError: target.syncError,
                syncDate: target.syncDate,
                tasks: target.tasks,
                estadoUnidad: target.estadoUnidad,
                combustibleReset: target.combustibleReset,
                taxesOrderNumber: target.taxesOrderNumber,
                verifiedStatus: target.verifiedStatus,
                verifiedError: target.verifiedError,
                verifiedCount: target.verifiedCount,
                archived: isArchivedLocallyOrRemotely
              });
            }
          }
        } catch (dbErr) {
          console.error(`[RailwayAgent] Error updating local database for order ${target.id}:`, dbErr.message);
        }
      }

      // 2.5 Push locally archived orders to Railway so Railway's database archives them too
      try {
        const localArchived = db.getArchivedOrders() || [];
        for (const archOrder of localArchived) {
          const rwMatch = orders.find(o => o.id === archOrder.id);
          if (rwMatch && !rwMatch.archived) {
            console.log(`[RailwayAgent] Pushing local archived status to Railway for order ${archOrder.id}...`);
            apiCall('POST', `/api/orders/local-sync-result/${archOrder.id}`, {
              syncStatus: archOrder.syncStatus || 'success',
              verifiedStatus: archOrder.verifiedStatus || 'success',
              archived: true
            }, () => {});
          }
        }
      } catch (archPushErr) {
        console.error('[RailwayAgent] Error pushing archived status to Railway:', archPushErr.message);
      }

      // 3. Find any order that strictly needs sync (syncStatus is 'pending' only).
      const pending = orders.filter(o => o.syncStatus === 'pending');

      if (pending.length === 0) {
        isAgentRunning = false;
        return;
      }

      const target = pending[0];
      console.log(`[RailwayAgent] Found pending order for ${target.interno} (Taxes: ${target.taxesOrderNumber || 'NEW'}). Running sync locally...`);

      // Set Railway sync status to 'syncing'
      apiCall('POST', `/api/orders/local-sync-result/${target.id}`, { syncStatus: 'syncing' }, () => {
        // Run sync in next tick
        setTimeout(async () => {
          try {
            // Update local database copy of this order so syncWorker can read it
            const existing = db.getWorkOrderById(target.id);
            if (existing) {
              db.updateWorkOrder(target.id, target);
            } else {
              db.createWorkOrder(target);
            }

            // Run syncWorker
            const result = await worker.syncWorkOrder(target.id);
            console.log(`[RailwayAgent] Sync result:`, result);

            // Get updated order from local DB
            const updatedLocal = db.getWorkOrderById(target.id);

            // If it was deleted during cleanup, it means it synced successfully!
            const syncStatus = updatedLocal ? updatedLocal.syncStatus : 'synced';
            const syncError = updatedLocal ? updatedLocal.syncError : null;
            const syncDate = updatedLocal ? updatedLocal.syncDate : new Date().toISOString();
            const tasks = updatedLocal ? updatedLocal.tasks : target.tasks.map(t => ({ ...t, synced: true, taxesRealizadaSynced: true }));
            const verifiedStatus = updatedLocal ? updatedLocal.verifiedStatus : 'ok';
            const verifiedError = updatedLocal ? updatedLocal.verifiedError : null;
            const verifiedCount = updatedLocal ? updatedLocal.verifiedCount : 1;
            const archived = updatedLocal ? updatedLocal.archived === true : false;

            // Upload results back to Railway
            apiCall('POST', `/api/orders/local-sync-result/${target.id}`, {
              syncStatus,
              syncError,
              syncDate,
              tasks,
              verifiedStatus,
              verifiedError,
              verifiedCount,
              taxesOrderNumber: updatedLocal ? updatedLocal.taxesOrderNumber : null,
              archived
            }, (uploadErr) => {
              if (uploadErr) {
                console.error('[RailwayAgent] Error uploading sync result:', uploadErr.message);
              } else {
                console.log('[RailwayAgent] Uploaded sync result to Railway successfully.');
              }
              isAgentRunning = false;
            });
          } catch (syncErr) {
            console.error('[RailwayAgent] Sync exception:', syncErr.message);
            apiCall('POST', `/api/orders/local-sync-result/${target.id}`, {
              syncStatus: 'error',
              syncError: syncErr.message
            }, () => {
              isAgentRunning = false;
            });
          }
        }, 100);
      });
    });
  } catch (err) {
    console.error('[RailwayAgent] Main loop exception:', err.message);
    isAgentRunning = false;
  }
}

function startAgent() {
  console.log('[RailwayAgent] Agent started. Polling Railway every 20 seconds...');
  setInterval(checkAndSync, POLL_INTERVAL_MS);
  // Initial check
  checkAndSync();
}

module.exports = { startAgent };
