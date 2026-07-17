const worker = require('./syncWorker');
const db = require('./database');

const HOST = 'app-taxes-production-ec67.up.railway.app';
const USERNAME = 'paniol@contenedoreshugo.com.ar';
const POLL_INTERVAL_MS = 20000; // 20 seconds

// Promise-based API call using modern fetch (avoids https.request DNS/timeout issues)
function apiCall(method, path, bodyData) {
  return new Promise((resolve, reject) => {
    const url = `https://${HOST}${path}`;
    const headers = { 'x-user-username': USERNAME };
    const options = { method, headers };

    if (bodyData) {
      options.body = JSON.stringify(bodyData);
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    options.signal = controller.signal;

    fetch(url, options)
      .then(async (res) => {
        clearTimeout(timeoutId);
        const text = await res.text();
        resolve(text);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
  });
}

let isAgentRunning = false;
let startupDone = false;

async function checkAndSync() {
  if (isAgentRunning) return;
  isAgentRunning = true;

  try {
    // ── 0. On first startup: reset any 'syncing' orders on Railway back to 'pending'
    //       (mirrors what syncWorker does locally on boot)
    if (!startupDone) {
      startupDone = true;
      try {
        const rawAll = await apiCall('GET', '/api/orders/all', null);
        const allOrders = JSON.parse(rawAll);
        if (Array.isArray(allOrders)) {
          const stuck = allOrders.filter(o => o.syncStatus === 'syncing');
          for (const o of stuck) {
            console.log(`[RailwayAgent] Resetting stuck 'syncing' order ${o.interno} (${o.id}) to 'pending'...`);
            await apiCall('POST', `/api/orders/local-sync-result/${o.id}`, { syncStatus: 'pending' })
              .catch(e => console.warn(`[RailwayAgent] Failed to reset ${o.id}:`, e.message));
          }
        }
      } catch (startupErr) {
        console.warn('[RailwayAgent] Startup reset failed:', startupErr.message);
      }
    }

    // ── 1. Sync catalogs to Railway if Railway has empty catalogs
    try {
      const rawCat = await apiCall('GET', '/api/catalogs', null);
      const remoteCat = JSON.parse(rawCat);
      if (!remoteCat.rodados || remoteCat.rodados.length === 0) {
        const localCat = db.getCatalogs();
        if (localCat && localCat.rodados && localCat.rodados.length > 0) {
          console.log(`[RailwayAgent] Railway catalogs empty. Uploading ${localCat.rodados.length} local rodados to Railway...`);
          await apiCall('POST', '/api/catalogs/update', localCat).catch(() => {});
        }
      }
    } catch (catErr) {
      // Non-fatal — continue
    }

    // ── 2. Fetch ALL orders from Railway
    let orders;
    try {
      const rawData = await apiCall('GET', '/api/orders/all', null);
      orders = JSON.parse(rawData);
    } catch (fetchErr) {
      console.error('[RailwayAgent] Error fetching orders:', fetchErr.message);
      isAgentRunning = false;
      return;
    }

    if (!Array.isArray(orders)) {
      console.error('[RailwayAgent] Received non-array response from Railway:', orders);
      isAgentRunning = false;
      return;
    }

    // ── 3. Sync all Railway orders into local database
    for (const target of orders) {
      try {
        const existing = db.getWorkOrderById(target.id);
        const isArchivedLocallyOrRemotely = target.estadoUnidad === 'fuera_de_servicio'
          ? false
          : (existing ? (existing.archived === true || target.archived === true) : (target.archived === true));

        if (!existing) {
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
        } else if (existing.syncStatus !== 'syncing') {
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
      } catch (dbErr) {
        console.error(`[RailwayAgent] Error updating local DB for order ${target.id}:`, dbErr.message);
      }
    }

    // ── 4. Push local orders to Railway if missing or if local status differs
    //        (This is how AutoFix results propagate back to Railway)
    try {
      const allLocal = db.read().workOrders || [];
      for (const localOrd of allLocal) {
        const rwMatch = orders.find(o => o.id === localOrd.id);
        const statusDiffers = rwMatch && (
          localOrd.syncStatus !== rwMatch.syncStatus ||
          localOrd.verifiedStatus !== rwMatch.verifiedStatus ||
          localOrd.taxesOrderNumber !== rwMatch.taxesOrderNumber ||
          localOrd.archived !== rwMatch.archived
        );

        if (!rwMatch || statusDiffers) {
          if (statusDiffers) {
            console.log(`[RailwayAgent] Pushing updated status for ${localOrd.interno} (sync:${localOrd.syncStatus} verified:${localOrd.verifiedStatus}) to Railway...`);
          } else {
            console.log(`[RailwayAgent] Pushing local order ${localOrd.interno} (${localOrd.id}) to Railway...`);
          }
          await apiCall('POST', `/api/orders/local-sync-result/${localOrd.id}`, {
            rodado: localOrd.rodado,
            responsable: localOrd.responsable,
            fechaEntrega: localOrd.fechaEntrega,
            horario: localOrd.horario,
            interno: localOrd.interno,
            clasificacion: localOrd.clasificacion,
            incidente: localOrd.incidente,
            syncStatus: localOrd.syncStatus || 'success',
            syncError: localOrd.syncError,
            syncDate: localOrd.syncDate,
            tasks: localOrd.tasks,
            estadoUnidad: localOrd.estadoUnidad,
            combustibleReset: localOrd.combustibleReset,
            taxesOrderNumber: localOrd.taxesOrderNumber,
            verifiedStatus: localOrd.verifiedStatus || 'success',
            verifiedError: localOrd.verifiedError,
            verifiedCount: localOrd.verifiedCount,
            archived: !!localOrd.archived
          }).catch(pushErr => console.warn(`[RailwayAgent] Push failed for ${localOrd.id}:`, pushErr.message));
        }
      }
    } catch (pushErr) {
      console.error('[RailwayAgent] Error pushing local orders:', pushErr.message);
    }

    // ── 5. Find any PENDING order from Railway and sync it locally
    const pending = orders.filter(o => o.syncStatus === 'pending');
    if (pending.length === 0) {
      isAgentRunning = false;
      return;
    }

    const target = pending[0];
    console.log(`[RailwayAgent] Found pending order for ${target.interno} (Taxes: ${target.taxesOrderNumber || 'NEW'}). Running sync locally...`);

    // Mark as 'syncing' on Railway
    await apiCall('POST', `/api/orders/local-sync-result/${target.id}`, { syncStatus: 'syncing' })
      .catch(() => {});

    try {
      // Make sure local DB has this order
      const existing = db.getWorkOrderById(target.id);
      if (existing) {
        db.updateWorkOrder(target.id, target);
      } else {
        db.createWorkOrder(target);
      }

      // Run the full Puppeteer sync
      const result = await worker.syncWorkOrder(target.id);
      console.log(`[RailwayAgent] Sync result:`, result);

      // Gather updated values from local DB
      const updated = db.getWorkOrderById(target.id);
      const payload = {
        syncStatus: updated ? updated.syncStatus : 'synced',
        syncError: updated ? updated.syncError : null,
        syncDate: updated ? updated.syncDate : new Date().toISOString(),
        tasks: updated ? updated.tasks : target.tasks.map(t => ({ ...t, synced: true })),
        verifiedStatus: updated ? updated.verifiedStatus : 'ok',
        verifiedError: updated ? updated.verifiedError : null,
        verifiedCount: updated ? updated.verifiedCount : 1,
        taxesOrderNumber: updated ? updated.taxesOrderNumber : null,
        archived: updated ? updated.archived === true : false
      };

      await apiCall('POST', `/api/orders/local-sync-result/${target.id}`, payload)
        .then(() => console.log('[RailwayAgent] Uploaded sync result to Railway successfully.'))
        .catch(e => console.error('[RailwayAgent] Error uploading sync result:', e.message));

    } catch (syncErr) {
      console.error('[RailwayAgent] Sync exception:', syncErr.message);
      await apiCall('POST', `/api/orders/local-sync-result/${target.id}`, {
        syncStatus: 'error',
        syncError: syncErr.message
      }).catch(() => {});
    }

  } catch (err) {
    console.error('[RailwayAgent] Main loop exception:', err.message);
  }

  isAgentRunning = false;
}

function startAgent() {
  console.log('[RailwayAgent] Agent started. Polling Railway every 20 seconds...');
  setInterval(checkAndSync, POLL_INTERVAL_MS);
  // Initial check
  checkAndSync();
}

module.exports = { startAgent };
