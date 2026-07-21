const worker = require('./syncWorker');
const db = require('./database');
const https = require('https');

const HOST = 'app-taxes-production-ec67.up.railway.app';
const USERNAME = 'paniol@contenedoreshugo.com.ar';
const POLL_INTERVAL_MS = 20000; // 20 seconds

// Promise-based API call using https.request (HTTP/1.1) — avoids HTTP/2 routing issues
// with Railway's edge network that cause persistent 404 "Application not found" errors
// when using Node.js built-in fetch which defaults to HTTP/2.
function apiCall(method, path, bodyData) {
  return new Promise((resolve, reject) => {
    // Append timestamp query parameter to bypass edge CDN caching on GET requests
    const cleanPath = path + (path.includes('?') ? '&' : '?') + 't=' + Date.now();
    const body = bodyData ? JSON.stringify(bodyData) : null;
    const headers = { 
      'x-user-username': USERNAME,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const options = {
      hostname: HOST,
      path: cleanPath,
      method,
      headers,
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out after 30s: ${method} ${path}`)); });
    req.on('error', (err) => reject(err));

    if (body) req.write(body);
    req.end();
  });
}


let isAgentRunning = false;
let startupDone = false;

async function checkAndSync() {
  if (isAgentRunning) return;
  isAgentRunning = true;

  try {
    // ── 0. On first startup: resolve any 'syncing' orders on Railway
    //       If local DB already has a definitive result (success/error), push it to Railway.
    //       Only reset to 'pending' if the daemon genuinely crashed mid-sync (no local result yet).
    if (!startupDone) {
      startupDone = true;
      try {
        const rawAll = await apiCall('GET', '/api/orders/all', null);
        const allOrders = JSON.parse(rawAll);
        if (Array.isArray(allOrders)) {
          const stuck = allOrders.filter(o => o.syncStatus === 'syncing' && o.deleted !== true);
          for (const o of stuck) {
            const localOrd = db.getWorkOrderById(o.id);
            const localSyncStatus = localOrd ? localOrd.syncStatus : null;
            const localVerifiedStatus = localOrd ? localOrd.verifiedStatus : null;
            if (localSyncStatus === 'success' || localSyncStatus === 'error' || localVerifiedStatus === 'success') {
              // Local has a definitive result — push it to Railway instead of resetting
              console.log(`[RailwayAgent] Startup: order ${o.interno} (${o.id}) has local status ${localSyncStatus}/${localVerifiedStatus}. Pushing to Railway...`);
              await apiCall('POST', `/api/orders/local-sync-result/${o.id}`, {
                syncStatus: localOrd.syncStatus,
                syncError: localOrd.syncError,
                syncDate: localOrd.syncDate,
                verifiedStatus: localOrd.verifiedStatus,
                verifiedError: localOrd.verifiedError,
                verifiedCount: localOrd.verifiedCount,
                taxesOrderNumber: localOrd.taxesOrderNumber,
                tasks: localOrd.tasks,
                estadoUnidad: localOrd.estadoUnidad,
                archived: !!localOrd.archived,
                deleted: !!localOrd.deleted,
                deletedAt: localOrd.deletedAt || null
              }).catch(e => console.warn(`[RailwayAgent] Startup push failed for ${o.id}:`, e.message));
            } else {
              // No definitive local result — daemon crashed mid-sync, reset to pending so it retries
              console.log(`[RailwayAgent] Startup: resetting stuck 'syncing' order ${o.interno} (${o.id}) to 'pending'...`);
              await apiCall('POST', `/api/orders/local-sync-result/${o.id}`, { syncStatus: 'pending' })
                .catch(e => console.warn(`[RailwayAgent] Failed to reset ${o.id}:`, e.message));
            }
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
          : (target.archived === true);

        const isDeletedLocallyOrRemotely = target.deleted === true || (existing && existing.deleted === true);

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
            archived: isArchivedLocallyOrRemotely,
            deleted: isDeletedLocallyOrRemotely,
            deletedAt: target.deletedAt || (isDeletedLocallyOrRemotely ? new Date().toISOString() : null)
          });
        } else {
          const preserveLocalSync = (existing.syncStatus === 'success' || existing.syncStatus === 'error') &&
                                    (target.syncStatus === 'syncing' || target.syncStatus === 'pending');
          const preserveLocalVerify = (existing.verifiedStatus === 'success' || existing.verifiedStatus === 'error') &&
                                      (target.verifiedStatus === 'pending');

          db.updateWorkOrder(target.id, {
            rodado: target.rodado,
            responsable: target.responsable,
            fechaEntrega: target.fechaEntrega,
            horario: target.horario,
            interno: target.interno,
            clasificacion: target.clasificacion,
            incidente: target.incidente,
            syncStatus: preserveLocalSync ? existing.syncStatus : target.syncStatus,
            syncError: preserveLocalSync ? existing.syncError : target.syncError,
            syncDate: preserveLocalSync ? existing.syncDate : target.syncDate,
            tasks: target.tasks,
            estadoUnidad: target.estadoUnidad,
            combustibleReset: target.combustibleReset,
            taxesOrderNumber: target.taxesOrderNumber,
            verifiedStatus: preserveLocalVerify ? existing.verifiedStatus : target.verifiedStatus,
            verifiedError: preserveLocalVerify ? existing.verifiedError : target.verifiedError,
            verifiedCount: preserveLocalVerify ? existing.verifiedCount : target.verifiedCount,
            archived: isArchivedLocallyOrRemotely,
            deleted: isDeletedLocallyOrRemotely,
            deletedAt: target.deletedAt || existing.deletedAt || (isDeletedLocallyOrRemotely ? new Date().toISOString() : null)
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

        // If this order is soft-deleted locally, push the deletion to Railway and skip further sync
        if (localOrd.deleted === true) {
          if (!rwMatch || rwMatch.deleted !== true) {
            console.log(`[RailwayAgent] Propagating soft-delete for order ${localOrd.interno} (${localOrd.id}) to Railway...`);
            await apiCall('POST', `/api/orders/local-sync-result/${localOrd.id}`, {
              deleted: true,
              deletedAt: localOrd.deletedAt || new Date().toISOString()
            }).catch(e => console.warn(`[RailwayAgent] Delete push failed for ${localOrd.id}:`, e.message));
          }
          continue; // Skip further processing for deleted orders
        }

        const statusDiffers = rwMatch && (
          localOrd.syncStatus !== rwMatch.syncStatus ||
          localOrd.verifiedStatus !== rwMatch.verifiedStatus ||
          localOrd.taxesOrderNumber !== rwMatch.taxesOrderNumber ||
          localOrd.archived !== rwMatch.archived ||
          !!localOrd.deleted !== !!rwMatch.deleted
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
            archived: !!localOrd.archived,
            deleted: false,
            deletedAt: null
          }).catch(pushErr => console.warn(`[RailwayAgent] Push failed for ${localOrd.id}:`, pushErr.message));
        }
      }
    } catch (pushErr) {
      console.error('[RailwayAgent] Error pushing local orders:', pushErr.message);
    }

    // ── 5. Find any PENDING order from Railway and sync it locally (skip soft-deleted/already-done orders)
    const pending = orders.filter(o => {
      if (o.syncStatus !== 'pending' || o.deleted === true) return false;
      
      const localOrd = db.getWorkOrderById(o.id);
      if (localOrd && (localOrd.syncStatus === 'success' || localOrd.verifiedStatus === 'success')) {
        console.log(`[RailwayAgent] Pending order ${o.interno} (${o.id}) is already completed locally. Pushing status instead of running Puppeteer.`);
        apiCall('POST', `/api/orders/local-sync-result/${o.id}`, {
          syncStatus: localOrd.syncStatus,
          syncError: localOrd.syncError,
          syncDate: localOrd.syncDate,
          verifiedStatus: localOrd.verifiedStatus,
          verifiedError: localOrd.verifiedError,
          verifiedCount: localOrd.verifiedCount,
          taxesOrderNumber: localOrd.taxesOrderNumber,
          tasks: localOrd.tasks,
          estadoUnidad: localOrd.estadoUnidad,
          archived: !!localOrd.archived,
          deleted: !!localOrd.deleted,
          deletedAt: localOrd.deletedAt || null
        }).catch(e => console.warn(`[RailwayAgent] Failed to push local status for ${o.id}:`, e.message));
        return false;
      }
      return true;
    });

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
