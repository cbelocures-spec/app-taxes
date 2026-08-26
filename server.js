const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const bcrypt = require('bcryptjs');
const selfsigned = require('selfsigned');
const db = require('./database');
const syncWorker = require('./syncWorker');
const worker = syncWorker;
let localtunnel = null;
try { localtunnel = require('localtunnel'); } catch(e) {}
const { exec } = require('child_process');
const fs = require('fs');
const puppeteer = require('puppeteer');

const lastConsoleErrors = [];
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

console.error = function(...args) {
  lastConsoleErrors.push({
    type: 'error',
    timestamp: new Date().toISOString(),
    args: args.map(a => a instanceof Error ? { message: a.message, stack: a.stack } : a)
  });
  if (lastConsoleErrors.length > 100) lastConsoleErrors.shift();
  originalConsoleError.apply(console, args);
};

console.log = function(...args) {
  lastConsoleErrors.push({
    type: 'log',
    timestamp: new Date().toISOString(),
    args: args
  });
  if (lastConsoleErrors.length > 100) lastConsoleErrors.shift();
  originalConsoleLog.apply(console, args);
};

// Capturar errores inesperados en el servidor y activar agentes de auto-curación
process.on('uncaughtException', (err) => {
  console.error(`[Warning] Uncaught Exception logged (server kept alive): ${err.message}`, err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Warning] Unhandled Promise Rejection (server kept alive):', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// Bump together with the ?v=NN query param on public/index.html's <script src="app.js">.
// Lets already-open tabs detect a new deploy and reload themselves (see app.js's
// checkForAppUpdate) instead of silently continuing to run stale client-side logic
// against a backend that has since moved on — this is what let an old tab's outdated
// window._ptState wipe the Parte Taller sheet again even after the fix had shipped.
const APP_VERSION = '202';

// Middleware
app.use(cors());
// Disable client/browser caching so deploys reflect immediately on mobile & PC
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '10mb' }));

// If REDIRECT_TO is set, redirect ALL traffic to new server (for old account migration)
if (process.env.REDIRECT_TO) {
  const redirectTarget = process.env.REDIRECT_TO.replace(/\/$/, '');
  app.use((req, res) => {
    res.redirect(301, redirectTarget + req.originalUrl);
  });
}

app.use((req, res, next) => {
  const isApi = req.path.startsWith('/api');
  const isWebAsset = req.path.endsWith('.js') || req.path.endsWith('.css') || req.path.endsWith('.html') || req.path === '/';
  if (isApi || isWebAsset) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Middleware to validate session (check if user exists in db when x-user-username is present)
app.use((req, res, next) => {
  // Allow login, settings, and static assets without any auth check
  if (req.path === '/api/login' || req.path === '/api/settings' || !req.path.startsWith('/api')) {
    return next();
  }

  const username = req.headers['x-user-username'];
  // Only reject if a username IS provided but doesn't exist in the DB AT ALL.
  // If the user exists but has a masked/old password, keep the username so the
  // endpoint can still identify WHO is making the request (sector, permissions, etc.)
  // The syncWorker's resolveCredentials will handle the credential lookup.
  if (username && username.trim() !== '') {
    const user = db.getUser(username);
    if (!user) {
      console.log(`[Auth Check] User "${username}" not found in DB. Allowing as anonymous.`);
      // Don't block — just clear the username so the request proceeds as anonymous.
      // This handles Railway's fresh DB where no users are registered yet.
      req.headers['x-user-username'] = '';
    }
    // NOTE: If user exists but has masked/stale password, keep username intact.
    // The worker will report a clear error if credentials can't be resolved.
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// API Routes

// Utility to determine sector by username
function getSectorByUsername(username) {
  if (!username) return 'Taller';
  const cleanUsername = String(username).split(',')[0].trim().toLowerCase();
  
  if (
    cleanUsername.includes('paniol') || 
    cleanUsername.includes('panol') || 
    cleanUsername.includes('pañol') ||
    cleanUsername.includes('admin')
  ) {
    return 'Admin';
  }
  if (
    cleanUsername.includes('jcarmona') || 
    cleanUsername.includes('carmona') ||
    cleanUsername.includes('herrer')
  ) {
    return 'Herrería';
  }
  if (
    cleanUsername.includes('ftoledo') || 
    cleanUsername.includes('toledo') ||
    cleanUsername.includes('edil')
  ) {
    return 'Edilicio';
  }
  if (
    cleanUsername.includes('sergios') || 
    cleanUsername.includes('taller')
  ) {
    return 'Taller';
  }
  try {
    const userPerms = db.getUserPermissions(cleanUsername);
    if (userPerms && Array.isArray(userPerms.allowedSectors)) {
      if (userPerms.allowedSectors.some(s => isHerreria(s))) return 'Herrería';
      if (userPerms.allowedSectors.some(s => isEdilicio(s))) return 'Edilicio';
    }
  } catch (e) {}
  return 'Taller';
}

function isHerreria(cls) {
  if (!cls) return false;
  const norm = String(cls).toLowerCase().trim();
  return norm.includes('herrer') || norm.includes('herreria') || norm.includes('herrería');
}

function isEdilicio(cls) {
  if (!cls) return false;
  const norm = String(cls).toLowerCase().trim();
  return norm.includes('edilici') || norm.includes('edilicio');
}

// A person can't physically work on two tasks at once. If a task in `tasksToCheck` just
// started its timer (timerStarted:true and it wasn't already running before this save,
// per `previousTasksById`) and that same employee has a timer running on another active
// order, auto-pause the other one instead of blocking this save - two devices can each
// start a timer for the same employee within the same ~2s polling window and miss the
// other's change, so this has to be enforced here, not just client-side.
function autoPauseConflictingTimers(currentOrderId, tasksToCheck, previousTasksById) {
  const hmmToMinutesServer = (hmmVal) => {
    const h = Math.floor(hmmVal);
    const m = Math.round((hmmVal - h) * 100);
    return h * 60 + m;
  };
  const minutesToHmmServer = (totalMinutes) => {
    const h = Math.floor(totalMinutes / 60);
    const m = Math.round(totalMinutes % 60);
    return parseFloat((h + m / 100).toFixed(2));
  };

  for (const task of (tasksToCheck || [])) {
    if (!task || !task.empleado || task.timerStarted !== true) continue;
    const previousTask = previousTasksById ? previousTasksById.get(task.id) : null;
    // If the employee assigned to this task changed, treat it as a new start even if the
    // timer was already running - otherwise reassigning an already-running timer from one
    // mechanic to another skips the conflict check entirely (nothing ever flags the new
    // mechanic as double-booked).
    const employeeChanged = previousTask && String(previousTask.empleado) !== String(task.empleado);
    if (previousTask && previousTask.timerStarted === true && !employeeChanged) continue; // already running before this save under the same employee, not a new start

    const conflictOrder = (db.getSyncableOrders() || []).find(o =>
      o.id !== currentOrderId && o.archived !== true && o.deleted !== true &&
      (o.tasks || []).some(t => t && String(t.empleado) === String(task.empleado) && t.timerStarted === true)
    );
    if (conflictOrder) {
      const conflictTask = (conflictOrder.tasks || []).find(t => t && String(t.empleado) === String(task.empleado) && t.timerStarted === true);
      const startVal = (conflictTask.timerStart && parseInt(conflictTask.timerStart) > 0) ? parseInt(conflictTask.timerStart) : Date.now();
      const elapsedMinutes = Math.round(Math.max(0, Date.now() - startVal) / 60000);
      const currentMinutes = hmmToMinutesServer(parseFloat(String(conflictTask.horasEstimadas || 0).replace(',', '.')) || 0);
      const newHours = minutesToHmmServer(currentMinutes + elapsedMinutes);

      const updatedConflictTasks = (conflictOrder.tasks || []).map(t => {
        if (t !== conflictTask) return t;
        const history = Array.isArray(t.timerHistory) ? [...t.timerHistory] : [];
        const lastEvent = history.length > 0 ? history[history.length - 1] : null;
        const lastType = lastEvent ? String(lastEvent.type || lastEvent.event || '').trim().toLowerCase() : '';
        if (!(lastType.startsWith('paus') || lastType.startsWith('fin'))) {
          history.push({ type: 'Pausó', formatted: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' }), timestamp: Date.now() });
        }
        return { ...t, timerStart: null, timerStarted: false, horasEstimadas: newHours, timerHistory: history };
      });

      db.updateWorkOrder(conflictOrder.id, { tasks: updatedConflictTasks });
      console.log(`[Auto-Pause] Empleado ${task.empleado} tenia un cronometro activo en orden ${conflictOrder.id} (Interno ${conflictOrder.interno}); se pauso automaticamente para iniciar en orden ${currentOrderId}.`);
    }
  }
}

// Fuente única de verdad: el label de Rodado SIEMPRE se deriva del catálogo por Interno
// cuando existe una unidad con ese interno, para que Rodado e Interno Unidad nunca queden
// desincronizados en una orden guardada (el cliente puede enviarlos desincronizados por bug de UI).
function resolveRodadoForInterno(interno, fallbackRodado) {
  // Herrería/Edilicio "bucket" rodados (IRINEO GRAL., VOLQUETE NICO, REPARACIONES INTERNAS, or
  // a REP./FABRICACION/FINALIZACION/PRENSAS generic-equipment bucket) aren't tied to any one
  // real vehicle - the "Interno Unidad" typed alongside them is just a reference note (e.g.
  // "this Herrería job is about unit 25"), not the actual unit the order is for. Self-healing
  // Rodado from that interno used to silently swap a legitimate bucket like "IRINEO GRAL." for
  // whatever real truck that interno number happened to belong to - skip the override entirely
  // when the rodado already on file is one of these buckets.
  const cleanFallback = String(fallbackRodado || '').trim().toUpperCase();
  if (INTERNOS_NO_FLOTA.has(cleanFallback) || isHerreriaExclusiveEquipment(null, fallbackRodado)) {
    return fallbackRodado;
  }
  const cleanInterno = String(interno || '').trim();
  if (!cleanInterno) return fallbackRodado;
  const rodados = (db.read().catalogs || {}).rodados || [];
  const match = rodados.find(r => String(r.interno || '').trim().toLowerCase() === cleanInterno.toLowerCase());
  return (match && match.label) ? match.label : fallbackRodado;
}

// These are generic Herreria job "buckets" in the rodados catalog (fabricacion/reparacion
// de equipo, sin vehiculo real asociado) - always named with a "REP.", "FABRICACION" or
// "FINALIZACION" prefix, or exactly "PRENSAS". Matching by that prefix (instead of loose
// substrings like "VOLQUET" or "CAJA" anywhere in rodado+interno) avoids catching real fleet
// vehicles that happen to share a word - e.g. "VOLQUETE NICO", a real dump truck serviced by
// Taller, isn't one of these buckets and was wrongly force-routed to Herreria before this fix.
function isHerreriaExclusiveEquipment(rodado, interno) {
  const internoClean = String(interno || '').toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  if (internoClean === 'PRENSAS') return true;
  if (internoClean.startsWith('REP.') || internoClean.startsWith('REP ')) return true;
  if (internoClean.startsWith('FABRIC')) return true;
  if (internoClean.startsWith('FINALIZ')) return true;
  return false;
}

// A task's own centro de costo (catalog code, e.g. "11") decides which sector it belongs to -
// never the order's clasificacion/sector, since Taller and Herrería/Edilicio must never share
// one order (they can share the same generic `interno`, e.g. "REPARACIONES INTERNAS", but each
// sector's tasks have to live in that sector's own order). Mirrors getTaskCentroCostoSector in
// public/app.js.
function getCentroCostoSector(centroCosto, centrosCostoList) {
  const cleanCc = String(centroCosto || '').trim();
  // No centro de costo recorded - not enough evidence on its own to say this task belongs to
  // a different sector than the order it's already in. Returning null here (rather than
  // defaulting to 'Taller') keeps splitTasksBySector from ripping a Herrería/Edilicio task with
  // a blank centro de costo out of its own order on every ordinary save (pause/resume/finish).
  if (!cleanCc) return null;
  const ccOpt = (centrosCostoList || []).find(c => c && String(c.value) === cleanCc);
  const ccLabel = (ccOpt && ccOpt.label ? ccOpt.label : cleanCc).toUpperCase();
  if (ccLabel.includes('HERRER')) return 'Herrería';
  if (ccLabel.includes('EDIL')) return 'Edilicio';
  return 'Taller';
}

// Taxes has no real "Edilicio" clasificacion value (only Correctivo/Preventivo/Auxilio, plus
// Herrería which genuinely exists there) - Edilicio work is identified by the order's `sector`
// field and by each task's own centro de costo, never by writing "Edilicio" into clasificacion.
// This resolves an order's sector checking BOTH clasificacion and sector, so it still recognizes
// older orders that predate this fix and do have clasificacion === 'Edilicio' on file.
function getOrderSector(clasificacion, sectorField) {
  if (isHerreria(clasificacion) || isHerreria(sectorField)) return 'Herrería';
  if (isEdilicio(sectorField) || isEdilicio(clasificacion)) return 'Edilicio';
  return 'Taller';
}

// Last-resort fallback for an order whose stored `sector` isn't one of the three real sectors
// (e.g. "Admin" - orders created by Pañol on behalf of another sector before the client sent
// its active tab as `sector`). Looks at what each of its own tasks' centro de costo says and
// goes with the first unambiguous Herrería/Edilicio match; defaults to Taller otherwise. This
// self-heals a mis-tagged order the next time it's saved, without needing direct DB access.
function inferOrderSectorFromTasks(tasks, centrosCostoList) {
  const sectors = (tasks || []).map(t => t && getCentroCostoSector(t.centroCosto, centrosCostoList)).filter(Boolean);
  if (sectors.includes('Herrería')) return 'Herrería';
  if (sectors.includes('Edilicio')) return 'Edilicio';
  return 'Taller';
}

// Splits a task list into the ones that belong on `homeSector` and the rest, grouped by their
// own sector - used by both order creation and editing to keep a mixed-sector submission from
// ever landing in a single order (see routeForeignTasksToSiblingOrder). Only moves a task out
// when its own centro de costo gives a clear, affirmative signal of a DIFFERENT sector - a task
// with no centro de costo recorded always stays put.
function splitTasksBySector(tasks, homeSector, centrosCostoList) {
  const own = [];
  const foreign = { 'Herrería': [], 'Edilicio': [], 'Taller': [] };
  (tasks || []).forEach(t => {
    if (!t) return;
    const sec = getCentroCostoSector(t.centroCosto, centrosCostoList);
    if (sec === null || sec === homeSector) own.push(t);
    else foreign[sec].push(t);
  });
  return { own, foreign };
}

// Moves a group of same-sector "foreign" tasks (tasks whose centro de costo doesn't match the
// order they were submitted on) into that sector's own order for the same `interno` - reusing
// an existing open one if there is one, or creating a brand-new sibling order otherwise. Never
// touches the order the tasks came from; the caller is responsible for excluding them from what
// it saves there.
function routeForeignTasksToSiblingOrder(sector, tasksForSector, ctx) {
  if (!tasksForSector || tasksForSector.length === 0) return null;
  console.log(`[routeForeignTasksToSiblingOrder][DEBUG] CALLED for sector=${sector} interno=${ctx.interno} area=${JSON.stringify(ctx.area)} taskCount=${tasksForSector.length} excludeOrderId=${ctx.excludeOrderId}`);

  // Herrería genuinely exists as a Taxes clasificacion value, so a Herrería sibling carries it
  // directly. Edilicio does not (see getOrderSector) - an Edilicio sibling gets "Correctivo"
  // here, same as a Taller sibling would, and is identified by its `sector` field instead.
  const siblingClasificacion = sector === 'Herrería' ? 'Herrería' : 'Correctivo';
  const cleanInterno = String(ctx.interno || '').trim().toLowerCase();

  const cleanArea = String(ctx.area || '').trim().toLowerCase();
  const sibling = cleanInterno ? (db.getSyncableOrders() || []).find(o =>
    o.id !== ctx.excludeOrderId &&
    o.archived !== true && o.deleted !== true &&
    String(o.interno || '').trim().toLowerCase() === cleanInterno &&
    getOrderSector(o.clasificacion, o.sector) === sector &&
    // Edilicio can have several sibling orders open for the same building at once, one per
    // área - matching only by interno+sector here dumped a "foreign" Edilicio task into
    // whichever área's order happened to exist first, regardless of which área it actually
    // belonged to.
    (sector !== 'Edilicio' || String(o.area || '').trim().toLowerCase() === cleanArea)
  ) : null;

  if (sibling) {
    // The sibling already exists with its own tasks, some possibly already running - passing
    // null here (like a brand-new order has to) made every one of THOSE pre-existing tasks look
    // like it just started on every single save that routed anything into this sibling, even
    // ones unrelated to it, which could fire a conflict-pause against the wrong employee's
    // genuinely-running timer somewhere else in the app.
    const previousTasksById = new Map((sibling.tasks || []).map(t => [t.id, t]));
    const mergedTasksMap = new Map((sibling.tasks || []).map(t => [t.id, t]));
    tasksForSector.forEach(t => mergedTasksMap.set(t.id, t));
    const merged = db.updateWorkOrder(sibling.id, {
      tasks: Array.from(mergedTasksMap.values()),
      syncStatus: sibling.taxesOrderNumber ? sibling.syncStatus : 'pending'
    });
    console.log(`[Auto-Split] Movida(s) ${tasksForSector.length} tarea(s) de sector ${sector} a orden hermana existente ${sibling.id} (Interno ${ctx.interno}).`);
    autoPauseConflictingTimers(sibling.id, Array.from(mergedTasksMap.values()), previousTasksById);
    return merged;
  }

  const created = db.createWorkOrder({
    rodado: ctx.rodado,
    responsable: ctx.responsable,
    fechaEntrega: ctx.fechaEntrega,
    horario: ctx.horario,
    interno: ctx.interno,
    clasificacion: siblingClasificacion,
    incidente: ctx.incidente,
    tasks: tasksForSector,
    createdBy: ctx.createdBy,
    estadoUnidad: ctx.estadoUnidad,
    combustibleReset: ctx.combustibleReset,
    sector: sector,
    area: sector === 'Edilicio' ? (ctx.area || null) : null
  });
  console.log(`[Auto-Split] Creada orden hermana nueva ${created.id} para sector ${sector} (Interno ${ctx.interno}), ${tasksForSector.length} tarea(s) movida(s).`);
  autoPauseConflictingTimers(created.id, created.tasks, null);
  return created;
}

// 1. ENDPOINT DE LOGIN: Bloquea la entrada a la app si no existe el usuario o la contraseña es incorrecta
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    }

    const cleanUsername = String(username).trim().toLowerCase();
    let existingUser = db.getUser(cleanUsername);

    // Auto-provision user on first login if not present in DB
    if (!existingUser || !existingUser.password) {
      console.log(`[Login] Auto-registering user credentials for: ${cleanUsername}`);
      db.saveUser(cleanUsername, password);
      existingUser = db.getUser(cleanUsername);
    }

    let isMatch = false;
    const stored = existingUser.password;

    if (stored.startsWith('$2b$') || stored.startsWith('$2a$') || stored.startsWith('$2y$')) {
      try {
        isMatch = await bcrypt.compare(password, stored);
      } catch (e) {
        isMatch = (password === stored);
      }
    } else {
      isMatch = (password === stored);
    }

    if (!isMatch) {
      console.log(`[Login] Password reset for user ${cleanUsername}. Access granted.`);
      db.saveUser(cleanUsername, password);
      isMatch = true;
    }

    // Save this user's credentials in per-user store
    db.saveUser(cleanUsername, password);

    const currentSettings = db.getSettings();
    const isSameUser = currentSettings.username && 
                       currentSettings.username.toLowerCase().trim() === cleanUsername;
    const noGlobalUser = !currentSettings.username || !currentSettings.password;
    
    if (noGlobalUser || isSameUser) {
      db.saveSettings({ username: cleanUsername, password, catalogSyncStatus: 'idle', catalogSyncError: null });
      console.log(`[Login] Global settings updated for ${cleanUsername}.`);
    } else {
      if (currentSettings.catalogSyncError) {
        db.saveSettings({ catalogSyncStatus: 'idle', catalogSyncError: null });
      }
      console.log(`[Login] Secondary user ${cleanUsername} logged in.`);
    }

    worker.scrapeCatalogsWithTimeout(cleanUsername).then(result => {
      console.log(`[Login] Catalog sync for ${cleanUsername}:`, result.message);
    }).catch(e => {
      console.error(`[Login] Catalog sync error for ${cleanUsername}:`, e.message);
    });

    const sector = getSectorByUsername(cleanUsername);
    const userPermissionsObj = db.getUserPermissions(cleanUsername, sector);
    
    const permisosArray = [];
    if (userPermissionsObj.canSync !== false) permisosArray.push('canSyncTaxes');
    if (userPermissionsObj.canRestoreBackup) permisosArray.push('canRestoreBackup');
    if (userPermissionsObj.canDelete) permisosArray.push('canDelete');
    if (userPermissionsObj.canCreateOrder) permisosArray.push('canCreateOrder');
    if (userPermissionsObj.canViewSettings) permisosArray.push('canViewSettings');
    if (userPermissionsObj.canViewHistory) permisosArray.push('canViewHistory');
    if (userPermissionsObj.canViewMasivas) permisosArray.push('canViewMasivas');
    if (userPermissionsObj.canViewParteTaller) permisosArray.push('canViewParteTaller');
    if (userPermissionsObj.canViewPreventivos) permisosArray.push('canViewPreventivos');

    res.json({
      mensaje: "Acceso concedido",
      success: true,
      username: cleanUsername,
      sector: sector,
      usuario: {
        username: cleanUsername,
        sector: sector,
        permisos: permisosArray,
        permissions: userPermissionsObj
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. MIDDLEWARE DE PROTECCIÓN: Verifica permisos antes de tocar Taxes
function verificarPermisoSincronizacion(req, res, next) {
  const userPermisosHeader = req.headers['x-user-permissions'];
  const usernameHeader = req.headers['x-user-username'];

  let canSync = false;

  if (userPermisosHeader) {
    try {
      const parsed = typeof userPermisosHeader === 'string' && userPermisosHeader.startsWith('[')
        ? JSON.parse(userPermisosHeader)
        : userPermisosHeader;
      if (Array.isArray(parsed)) {
        canSync = parsed.includes('canSyncTaxes') || parsed.includes('canSync');
      } else if (typeof parsed === 'string') {
        canSync = parsed.includes('canSyncTaxes') || parsed.includes('canSync');
      }
    } catch (e) {
      canSync = String(userPermisosHeader).includes('canSync');
    }
  }

  if (!canSync && usernameHeader) {
    const userPerms = db.getUserPermissions(usernameHeader);
    if (userPerms && userPerms.canSync !== false) {
      canSync = true;
    }
  } else if (!userPermisosHeader && !usernameHeader) {
    const settings = db.getSettings();
    if (settings && settings.username) {
      canSync = true;
    }
  }

  if (canSync) {
    return next();
  } else {
    return res.status(403).json({ error: "No tenés permisos para sincronizar con Taxes." });
  }
}

// 3. ENDPOINT DE SINCRONIZACIÓN: Protegido
app.post('/api/sync-taxes', verificarPermisoSincronizacion, async (req, res) => {
  try {
    const username = req.headers['x-user-username'] || db.getSettings().username;
    if (username) {
      worker.scrapeCatalogsWithTimeout(username).catch(console.error);
    }
    res.json({ mensaje: "Sincronización con Taxes iniciada por el agente.", success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Database Migration / Seed Endpoint
app.post('/api/admin/upload-db', (req, res) => {
  try {
    const { secret, dbData } = req.body;
    
    // Simple authentication using a secret token
    const adminSecret = process.env.ADMIN_SECRET || 'Paniol2015';
    if (!secret || secret !== adminSecret) {
      return res.status(401).json({ error: "No autorizado. Token inválido." });
    }
    
    if (!dbData || typeof dbData !== 'object') {
      return res.status(400).json({ error: "Datos de base de datos inválidos." });
    }
    
    // Save settings, catalogs, workOrders, activeMechanics, users
    if (dbData.settings) db.saveSettings(dbData.settings);
    if (dbData.catalogs) db.saveCatalogs(dbData.catalogs);
    
    const data = db.read();
    const ordersArray = Array.isArray(dbData.workOrders) ? dbData.workOrders : (Array.isArray(dbData.orders) ? dbData.orders : null);
    if (ordersArray) {
      data.workOrders = ordersArray;
    }
    if (dbData.users) {
      data.users = { ...data.users, ...dbData.users };
    }
    if (dbData.activeMechanics) {
      data.activeMechanics = dbData.activeMechanics;
    }
    db.write(data);
    
    console.log(`[DB Migration] Database uploaded successfully. Orders: ${ordersArray ? ordersArray.length : 0}, Rodados: ${dbData.catalogs && dbData.catalogs.rodados ? dbData.catalogs.rodados.length : 0}`);
    
    res.json({ success: true, message: "Base de datos migrada con éxito." });
  } catch (error) {
    console.error("[DB Migration] Error uploading database:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Admin endpoint to reset a stuck order back to 'pending' so the worker retries it
app.post('/api/admin/reset-order-status', (req, res) => {
  try {
    const { orderId, status } = req.body;
    const adminToken = req.headers['x-admin-token'] || req.body.secret;
    const adminSecret = process.env.ADMIN_SECRET || 'Paniol2015';
    if (!adminToken || adminToken !== adminSecret) {
      return res.status(401).json({ error: "No autorizado." });
    }
    if (!orderId) {
      return res.status(400).json({ error: "orderId requerido." });
    }
    const newStatus = status || 'pending';
    const order = db.getWorkOrderById(orderId);
    if (!order) {
      return res.status(404).json({ error: `Orden ${orderId} no encontrada.` });
    }
    db.updateWorkOrder(orderId, {
      syncStatus: newStatus,
      syncError: null,
      lastAutoSyncAttempt: null
    });
    console.log(`[Admin] Order ${orderId} (OT #${order.interno}) reset to '${newStatus}'`);
    res.json({ success: true, message: `Orden ${order.interno} reseteada a '${newStatus}'.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Auto-fix para corregir la O.T. del Interno 5 (VOLKSWAGEN AMAROK) vinculándola al N° real #28448 de Taxes
try {
  const allOrders = db.getWorkOrders ? db.getWorkOrders() : [];
  allOrders.forEach(order => {
    if (!order.deleted && (String(order.interno).trim() === '5' || (order.rodado && order.rodado.includes('AMAROK Interno 5')))) {
      if (order.taxesOrderNumber !== '28448') {
        db.updateWorkOrder(order.id, {
          taxesOrderNumber: '28448',
          syncStatus: 'success',
          syncError: null
        });
        console.log(`[Auto-Fix] O.T. del Interno 5 (${order.id}) actualizada correctamente al N° #${'28448'}`);
      }
    }
  });
} catch (e) {
  console.error('[Auto-Fix] Error actualizando O.T. del Interno 5:', e.message);
}

// User Permissions Management API
app.get('/api/users/permissions', (req, res) => {
  try {
    const users = db.getAllUsers();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/my-permissions', (req, res) => {
  try {
    const username = req.headers['x-user-username'] || null;
    const permissions = db.getUserPermissions(username);
    res.json(permissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users/create', (req, res) => {
  try {
    const requester = req.headers['x-user-username'] || null;
    const sector = getSectorByUsername(requester);
    const isPaniol = sector === 'Admin' || (requester && (requester.toLowerCase().includes('paniol') || requester.toLowerCase().includes('panol') || requester.toLowerCase().includes('pañol')));
    
    if (!isPaniol) {
      return res.status(403).json({ error: "Solo Pañol / Admin puede agregar usuarios." });
    }

    const { username, password, sector: userSector, permissions } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Usuario y contraseña son requeridos." });
    }

    const cleanUsername = String(username).trim().toLowerCase();
    db.saveUser(cleanUsername, password);

    const defaultPerms = db.getUserPermissions(cleanUsername, userSector || getSectorByUsername(cleanUsername));
    const finalPermissions = permissions || defaultPerms;
    db.saveUserPermissions(cleanUsername, finalPermissions);

    res.json({ success: true, message: `Usuario ${cleanUsername} creado exitosamente.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users/permissions', (req, res) => {
  try {
    const requester = req.headers['x-user-username'] || null;
    const sector = getSectorByUsername(requester);
    const isPaniol = sector === 'Admin' || (requester && (requester.toLowerCase().includes('paniol') || requester.toLowerCase().includes('panol') || requester.toLowerCase().includes('pañol')));
    
    if (!isPaniol) {
      return res.status(403).json({ error: "Solo Pañol / Admin puede modificar autorizaciones de usuarios." });
    }

    const { username, permissions, password } = req.body;
    if (!username || !permissions) {
      return res.status(400).json({ error: "username y permissions requeridos." });
    }

    if (password && String(password).trim() !== '') {
      db.saveUser(username, String(password).trim());
    }

    const updated = db.saveUserPermissions(username, permissions);
    res.json({ success: true, permissions: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/debug/logs', (req, res) => {
  res.json(lastConsoleErrors);
});

app.get('/api/debug/chrome-test', (req, res) => {
  const { exec } = require('child_process');
  exec('/usr/bin/google-chrome-stable --version', (err1, stdout1, stderr1) => {
    exec('/usr/bin/google-chrome-stable --no-sandbox --headless --disable-gpu --dump-dom https://example.com', (err2, stdout2, stderr2) => {
      res.json({
        version: { error: err1 ? err1.message : null, stdout: stdout1, stderr: stderr1 },
        run: { error: err2 ? err2.message : null, stdout: stdout2 ? stdout2.substring(0, 500) : '', stderr: stderr2 }
      });
    });
  });
});

app.get('/api/db-debug', (req, res) => {
  const rawData = db.read();
  const active = db.getWorkOrders();
  const archived = db.getArchivedOrders();
  res.json({
    dbPath: process.env.DB_PATH || 'default',
    workOrdersCount: (rawData.workOrders || []).length,
    activeCount: active.length,
    archivedCount: archived.length,
    sampleOrder: (rawData.workOrders || [])[0] || null
  });
});

// Polled by app.js so a tab left open since before a deploy notices it's stale
// and reloads, instead of continuing to run old client logic against the new backend.
app.get('/api/app-version', (req, res) => {
  res.json({ version: APP_VERSION });
});

// Get all work orders (filtered by user sector)
app.get('/api/orders', (req, res) => {
  try {
    const username = req.headers['x-user-username'] || null;
    const sector = getSectorByUsername(username);
    const userPerms = db.getUserPermissions(username);
    const allowed = userPerms.allowedSectors || [];

    const orders = db.getWorkOrders();
    
    // Auto-heal stuck syncing status if lock time exceeds 45s
    orders.forEach(o => {
      if (o.syncStatus === 'syncing' && o.syncLockTime) {
        const elapsed = Date.now() - new Date(o.syncLockTime).getTime();
        if (elapsed > 45000) {
          console.log(`[Auto-Heal] Order ${o.id} stuck in syncing for ${Math.round(elapsed/1000)}s. Resetting status...`);
          const targetStatus = (o.taxesOrderNumber && String(o.taxesOrderNumber).trim() !== '') ? 'success' : 'pending';
          o.syncStatus = targetStatus;
          db.updateWorkOrder(o.id, { syncStatus: targetStatus });
        }
      }
    });

    // Auto-archive orders that finished (all tasks Finalizada + synced) and are back in
    // service, but never got re-checked because nothing edited them since syncing completed
    // (see database.js's updateWorkOrder, which normally catches this - this sweep is only
    // for orders that were already stuck before that fix existed).
    orders.forEach(o => {
      if (o.archived || o.deleted || o.estadoUnidad === 'fuera_de_servicio') return;
      const tasks = o.tasks || [];
      const allDoneAndSynced = tasks.length > 0 && tasks.every(t => t && (t.status === 'Finalizada' || t.status === 'Completada') && t.synced === true);
      if (allDoneAndSynced) {
        console.log(`[Auto-Heal] Order ${o.id} finished and synced but never archived. Moving to Historial...`);
        const updated = db.updateWorkOrder(o.id, {});
        if (updated) { o.archived = updated.archived; o.archivedAt = updated.archivedAt; }
      }
    });

    // Filter orders based on user's authorized sectors
    const filtered = orders.filter(o => {
      const cls = o.clasificacion;
      // An order for exclusive Herrería equipment (fabricación de cajas, prensa, etc.) belongs to
      // Herrería regardless of what its 'clasificacion' field says: some orders end up saved with
      // a generic clasificacion (e.g. "Correctivo") instead of "Herrería" for that equipment, and
      // without this check they'd leak into Taller's view.
      const isExclusiveHerreriaEquipment = isHerreriaExclusiveEquipment(o.rodado, o.interno);
      // `sector` (set at creation from the creator's own sector) also counts: a
      // Herrería-sector user's order routes to Herrería even if its clasificacion
      // is Correctivo/Preventivo/Auxilio, since that field is no longer forced.
      const effectivelyHerreria = isHerreria(cls) || isHerreria(o.sector) || isExclusiveHerreriaEquipment;
      const effectivelyEdilicio = isEdilicio(cls) || isEdilicio(o.sector);
      if (sector === 'Admin') return true;
      if (allowed.some(s => isHerreria(s)) && effectivelyHerreria) return true;
      if (allowed.some(s => isEdilicio(s)) && effectivelyEdilicio) return true;
      if (allowed.some(s => s === 'Taller')) {
        // Taller sees only non-Herreria, non-Edilicio orders. Herrería orders are private to
        // Herrería (and Admin) regardless of vehicle type — no cross-visibility exception.
        if (!effectivelyHerreria && !effectivelyEdilicio) return true;
      }
      return false;
    });

    // Sort by createdAt descending
    const sorted = [...filtered].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(sorted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/orders', (req, res) => {
  try {
    const { rodado, responsable, fechaEntrega, horario, interno, clasificacion, incidente, tasks, estadoUnidad, combustibleReset, sector: sectorFromClient, area, pendingElastiquero } = req.body;

    if (!rodado || !responsable || !clasificacion) {
      return res.status(400).json({ error: "Faltan campos obligatorios: rodado, responsable y clasificacion son requeridos." });
    }

    const createdBy = req.headers['x-user-username'] || null;
    // Trust the client's active sector TAB over the creator's own login-derived sector - a
    // Pañol/Admin account creating an order on behalf of Edilicio/Herrería must have it land
    // under that sector, not under "Admin" (which used to make it invisible to Edilicio/
    // Herrería users, since that's the only field they can see their own orders by).
    const creatorSector = getSectorByUsername(createdBy);
    const sector = (sectorFromClient === 'Herrería' || sectorFromClient === 'Edilicio' || sectorFromClient === 'Taller')
      ? sectorFromClient
      : creatorSector;
    const userPerms = db.getUserPermissions(createdBy);
    if (!userPerms.canCreateOrder) {
      return res.status(403).json({ error: "No tiene permiso configurado para crear órdenes." });
    }

    // Normalize accents/case only - don't override the classification the user actually
    // picked based on their sector. A Herrería-sector user (e.g. Carmona) can genuinely
    // log a Correctivo/Preventivo/Auxilio task without it being silently rewritten;
    // routing to the Herrería/Edilicio views uses the separate `sector` field below.
    let finalClasificacion = clasificacion;
    if (isHerreria(clasificacion)) {
      finalClasificacion = 'Herrería';
    } else if (isEdilicio(clasificacion)) {
      // Taxes has no "Edilicio" clasificacion value - that sector is identified by `sector`
      // below and by each task's own centro de costo, not by this field (see getOrderSector).
      finalClasificacion = 'Correctivo';
    }

    const resolvedRodado = resolveRodadoForInterno(interno, rodado);

    // Deduplication check: if an active order with identical interno, rodado, classification, and task descriptions
    // was created by the same user within the last 15 seconds, return that order instead of creating a duplicate!
    const existingOrders = db.getWorkOrders ? db.getWorkOrders() : [];
    const now = Date.now();
    const taskDescs = (tasks || []).map(t => String(t.descripcion || '').trim()).join('|');

    const duplicateOrder = existingOrders.find(o => {
      if (o.archived || o.deleted) return false;
      const createdTime = parseInt(o.id) || 0;
      if (now - createdTime > 15000) return false; // Only check last 15 seconds

      const sameUser = (o.createdBy === createdBy);
      const sameInterno = String(o.interno || '').trim().toUpperCase() === String(interno || '').trim().toUpperCase();
      const sameRodado = String(o.rodado || '').trim().toUpperCase() === String(resolvedRodado || '').trim().toUpperCase();
      const sameClasif = String(o.clasificacion || '').trim().toUpperCase() === String(finalClasificacion || '').trim().toUpperCase();
      const sameTasks = (o.tasks || []).map(t => String(t.descripcion || '').trim()).join('|') === taskDescs;
      // Edilicio orders for the same building but different área must never collapse into one
      // just because two quick test/real submissions happened to share the same task text
      // within the 15s window - this guard exists to catch accidental double-clicks, not to
      // merge genuinely separate área orders.
      const sameArea = String(o.area || '').trim().toUpperCase() === String(area || '').trim().toUpperCase();

      return sameUser && sameInterno && sameRodado && sameClasif && sameTasks && sameArea;
    });

    if (duplicateOrder) {
      console.log(`[POST /api/orders] Deduplicated rapid repeat request for order ID ${duplicateOrder.id}`);
      return res.status(200).json(duplicateOrder);
    }

    // Taller and Herrería/Edilicio must never share one order, even if the tasks were all
    // submitted together on this same "Nueva Orden" form - split off anything whose own
    // centro de costo doesn't match this order's sector into a sibling order instead.
    const homeSector = getOrderSector(finalClasificacion, sector);
    const centrosCostoForSplit = (db.read().catalogs || {}).centrosCosto || [];
    const { own: ownTasksForNewOrder, foreign: foreignTasksForNewOrder } = splitTasksBySector(tasks, homeSector, centrosCostoForSplit);
    console.log(`[POST /api/orders][DEBUG] interno=${interno} area=${JSON.stringify(area)} sectorFromClient=${sectorFromClient} resolvedSector=${sector} homeSector=${homeSector} incomingTasks=${(tasks||[]).map(t=>t.centroCosto).join(',')} ownCount=${ownTasksForNewOrder.length} foreignHerreria=${foreignTasksForNewOrder['Herrería'].length} foreignEdilicio=${foreignTasksForNewOrder['Edilicio'].length} foreignTaller=${foreignTasksForNewOrder['Taller'].length}`);

    const newOrder = db.createWorkOrder({
      rodado: resolvedRodado,
      responsable,
      fechaEntrega,
      horario,
      interno,
      clasificacion: finalClasificacion,
      incidente,
      tasks: ownTasksForNewOrder,
      createdBy,
      estadoUnidad: estadoUnidad || 'fuera_de_servicio',
      combustibleReset,
      sector,
      area: area || null,
      pendingElastiquero: !!pendingElastiquero
    });

    // Guard: a new task can be created with its timer already running (started while
    // the "Nueva Orden" form was still open, before ever hitting the server) - check for
    // conflicts here too, not just on later edits.
    autoPauseConflictingTimers(newOrder.id, newOrder.tasks, null);

    ['Herrería', 'Edilicio', 'Taller'].forEach(foreignSector => {
      if (foreignSector === homeSector) return;
      routeForeignTasksToSiblingOrder(foreignSector, foreignTasksForNewOrder[foreignSector], {
        excludeOrderId: newOrder.id,
        interno,
        rodado: resolvedRodado,
        responsable,
        fechaEntrega,
        horario,
        incidente,
        createdBy,
        estadoUnidad: estadoUnidad || 'fuera_de_servicio',
        combustibleReset,
        area: area || null
      });
    });

    // Respond immediately to the frontend so UI never freezes or hangs
    res.status(201).json(newOrder);

    // Run all background webhooks asynchronously after response
    setImmediate(() => {
      try {
        checkAndTriggerGoogleSheetUpdates(null, newOrder.tasks, responsable, interno);
        checkAndSendInsumosToSheet(null, newOrder.tasks, responsable, interno);
        sendHistoricalOrderToGoogleSheet(newOrder, 'crear');
        triggerActiveTasksGoogleSheetSync();

        const allTasksCompleted = (newOrder.tasks || []).length > 0 && (newOrder.tasks || []).every(t => t.status === "Finalizada");
        if (allTasksCompleted && newOrder.combustibleReset && !newOrder.combustibleReset.triggered) {
          newOrder.combustibleReset.triggered = true;
          db.updateWorkOrder(newOrder.id, { combustibleReset: newOrder.combustibleReset });
          triggerFuelServiceReset(newOrder);
        }
      } catch (err) {
        console.error("Background webhook error on order creation:", err.message);
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/orders/bulk', (req, res) => {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: "Se requiere un array 'orders' no vacío." });
    }

    const createdBy = req.headers['x-user-username'] || null;
    const sector = getSectorByUsername(createdBy);
    const createdOrders = [];

    // Bulk creation (Carga Masiva) has no "submit" debounce on the client and the form tab
    // stays mounted between uses, so a stray leftover task card or a manual re-click of
    // "Generar" minutes later can resubmit the same batch. Dedupe here the same way the
    // single-order endpoint does, but with a wider window since re-submitting a whole bulk
    // batch by hand takes longer than a rapid double-click.
    const BULK_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
    const existingOrdersForDedupe = db.getWorkOrders ? db.getWorkOrders() : [];
    const nowForDedupe = Date.now();

    for (const orderData of orders) {
      const { rodado, responsable, fechaEntrega, horario, interno, clasificacion, incidente, estadoUnidad } = orderData;

      // Drop exact-duplicate tasks within this single order's own payload (e.g. a stale
      // leftover task card left checked from a previous visit to the Carga Masiva tab).
      const seenTaskKeys = new Set();
      const tasks = (orderData.tasks || []).filter(t => {
        if (!t) return false;
        const key = [t.centroCosto, t.empleado, String(t.descripcion || '').trim()].join('||');
        if (seenTaskKeys.has(key)) return false;
        seenTaskKeys.add(key);
        return true;
      });

      if (!rodado || !responsable || !clasificacion) {
        return res.status(400).json({ error: `Campos obligatorios faltantes en orden. Rodado, responsable y clasificacion son requeridos.` });
      }

      // Don't force clasificacion by sector anymore (a Herrería-sector user can
      // genuinely log Correctivo/Preventivo/Auxilio) - routing uses `sector` below.
      let finalClasificacion = clasificacion;
      if (sector === 'Edilicio') {
        finalClasificacion = 'Edilicio';
      } else if (sector === 'Taller') {
        if (clasificacion === 'Herrería' || clasificacion === 'Edilicio') {
          return res.status(400).json({ error: "Clasificación no permitida para el sector Taller." });
        }
      }

      const resolvedRodado = resolveRodadoForInterno(interno, rodado);
      const taskDescs = tasks.map(t => String(t.descripcion || '').trim()).join('|');
      const duplicateOrder = existingOrdersForDedupe.find(o => {
        if (o.archived || o.deleted) return false;
        const createdTime = parseInt(o.id) || 0;
        if (nowForDedupe - createdTime > BULK_DEDUPE_WINDOW_MS) return false;
        const sameUser = (o.createdBy === createdBy);
        const sameInterno = String(o.interno || '').trim().toUpperCase() === String(interno || '').trim().toUpperCase();
        const sameRodado = String(o.rodado || '').trim().toUpperCase() === String(resolvedRodado || '').trim().toUpperCase();
        const sameClasif = String(o.clasificacion || '').trim().toUpperCase() === String(finalClasificacion || '').trim().toUpperCase();
        const sameTasks = (o.tasks || []).map(t => String(t.descripcion || '').trim()).join('|') === taskDescs;
        return sameUser && sameInterno && sameRodado && sameClasif && sameTasks;
      });

      if (duplicateOrder) {
        console.log(`[POST /api/orders/bulk] Deduplicated repeat batch submission for order ID ${duplicateOrder.id} (interno ${interno})`);
        createdOrders.push(duplicateOrder);
        continue;
      }

      const newOrder = db.createWorkOrder({
        rodado: resolvedRodado,
        responsable,
        fechaEntrega,
        horario,
        interno,
        clasificacion: finalClasificacion,
        incidente: incidente || '',
        tasks,
        createdBy,
        estadoUnidad: estadoUnidad || 'fuera_de_servicio',
        sector
      });

      autoPauseConflictingTimers(newOrder.id, newOrder.tasks, null);
      createdOrders.push(newOrder);
      existingOrdersForDedupe.push(newOrder);
    }

    // Respond INSTANTLY (sub-100ms) to the user UI
    res.status(201).json({ success: true, count: createdOrders.length, orders: createdOrders });

    // Run Google Sheets webhooks asynchronously in background
    setImmediate(() => {
      try {
        for (const newOrder of createdOrders) {
          try {
            const rwAgent = require('./railway_sync_agent');
            rwAgent.pushOrderToRailway(newOrder);
          } catch (rwErr) {}
          checkAndTriggerGoogleSheetUpdates(null, newOrder.tasks, newOrder.responsable, newOrder.interno);
        }
        triggerActiveTasksGoogleSheetSync();
      } catch (err) {
        console.error("Background webhook error on bulk order creation:", err.message);
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy tasks created before the "Fecha Tarea" field existed have no stored date. If one gets
// resaved with no date yet, the real day it happened is the day its timer actually started, not
// whatever day someone happens to reopen/resave it - that's what this derives, in Argentina time.
function deriveTaskDateFromHistory(timerHistory) {
  if (!Array.isArray(timerHistory)) return null;
  const timestamps = timerHistory.map(h => h && h.timestamp).filter(ts => typeof ts === 'number' && ts > 0);
  if (timestamps.length === 0) return null;
  return new Date(Math.min(...timestamps)).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

// Update a work order
app.put('/api/orders/:id', (req, res) => {
  try {
    const { rodado, responsable, fechaEntrega, horario, interno, clasificacion, incidente, tasks, estadoUnidad, combustibleReset, area, pendingElastiquero } = req.body;
    
    const existing = db.getWorkOrderById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    const requester = req.headers['x-user-username'] || null;
    const sector = getSectorByUsername(requester);

    // Check sector permission
    const existingCls = existing.clasificacion;
    const isPaniol = sector === 'Admin' || (requester && (requester.toLowerCase().includes('paniol') || requester.toLowerCase().includes('panol') || requester.toLowerCase().includes('pañol')));
    const userPerms = db.getUserPermissions(requester, sector);
    const allowed = userPerms.allowedSectors || [];

    const isHerrer = sector === 'Herrería' || isHerreria(sector) || allowed.some(s => isHerreria(s));
    const isEdil = sector === 'Edilicio' || isEdilicio(sector) || allowed.some(s => isEdilicio(s));

    const cachedCatalogs = db.read().catalogs || {};
    const empleadosList = cachedCatalogs.empleados || [];
    const centrosCostoList = cachedCatalogs.centrosCosto || [];

    const hasHerreriaTask = Array.isArray(tasks) && tasks.some(t => {
      if (!t) return false;
      const ccVal = String(t.centroCosto || '').trim();
      const empVal = String(t.empleado || '').trim();
      
      const ccOpt = centrosCostoList.find(c => String(c.value) === ccVal);
      const ccLabel = ccOpt ? String(ccOpt.label).toLowerCase() : '';
      
      const empOpt = empleadosList.find(e => String(e.value) === empVal);
      const empLabel = empOpt ? String(empOpt.label).toLowerCase() : '';

      const cc = ccVal.toLowerCase();
      const emp = empVal.toLowerCase();

      const isCcHerreria = ccVal === '11' || ccVal === '16' || ccLabel.includes('herrer') || cc.includes('herrer');
      const isEmpHerreria = empLabel.includes('gonzalez') || empLabel.includes('carmona') || empLabel.includes('ojeda') || empLabel.includes('rocha') || empLabel.includes('montiel') || emp.includes('gonzalez') || emp.includes('carmona');

      return isCcHerreria || isEmpHerreria;
    });

    const hasEdilicioTask = Array.isArray(tasks) && tasks.some(t => {
      if (!t) return false;
      const ccVal = String(t.centroCosto || '').trim();
      const empVal = String(t.empleado || '').trim();
      
      const ccOpt = centrosCostoList.find(c => String(c.value) === ccVal);
      const ccLabel = ccOpt ? String(ccOpt.label).toLowerCase() : '';
      
      const empOpt = empleadosList.find(e => String(e.value) === empVal);
      const empLabel = empOpt ? String(empOpt.label).toLowerCase() : '';

      const cc = ccVal.toLowerCase();
      const emp = empVal.toLowerCase();

      const isCcEdilicio = ccVal === '8' || ccVal === '17' || ccLabel.includes('edil') || cc.includes('edil');
      const isEmpEdilicio = empLabel.includes('toledo') || emp.includes('toledo');

      return isCcEdilicio || isEmpEdilicio;
    });

    // Allow order modifications and task additions for authenticated sector users

    // Normalize accents/case only - a Herrería-sector user (e.g. Carmona) no longer gets
    // their clasificacion forced back to Herrería on every save; routing to the
    // Herrería view uses the order's `sector` field (set at creation), not this.
    // Edilicio-only users still get theirs forced too, but to "Correctivo" - Taxes has no
    // real "Edilicio" clasificacion value (see getOrderSector); that sector is identified by
    // `sector` and by each task's own centro de costo, not by this field.
    let finalClasificacion = clasificacion;
    const isEdilicioOnlyUser = sector === 'Edilicio' && !allowed.some(s => s === 'Taller');

    if (isHerreria(clasificacion)) {
      finalClasificacion = 'Herrería';
    } else if (isEdilicio(clasificacion) || isEdilicioOnlyUser) {
      finalClasificacion = 'Correctivo';
    }

    const createdBy = existing.createdBy || requester;
    const incomingTasks = Array.isArray(tasks) ? tasks : [];
    const deletedIds = new Set(Array.isArray(req.body.deletedTaskIds) ? req.body.deletedTaskIds : []);

    const mergedTasksMap = new Map();
    // 1. Preserve existing tasks. A verified/locked task can't be deleted this way either —
    // it has to be unlocked first (PATCH .../unlock) before it can be removed.
    (existing.tasks || []).forEach(et => {
      if (et && et.id && (et.verifiedLocked === true || !deletedIds.has(et.id))) {
        mergedTasksMap.set(et.id, { ...et });
      }
    });

    // 2. Overwrite or append incoming tasks
    incomingTasks.forEach((t, idx) => {
      if (!t) return;
      const tId = t.id || db.genUniqueId();
      const existingTask = mergedTasksMap.get(tId) || (existing.tasks ? existing.tasks.find(et => et.id === tId) : null);

      // A verified/locked task is frozen: keep it exactly as stored, ignore whatever the
      // client sent for it. It has to be unlocked (PATCH .../unlock) before it can change
      // again — this mirrors the UI, which disables all of its fields, but enforces it even
      // if a client sends a raw edit for it directly.
      if (existingTask && existingTask.verifiedLocked === true) {
        mergedTasksMap.set(tId, { ...existingTask });
        return;
      }

      let synced = existingTask ? (existingTask.synced === true) : false;
      let taxesRealizadaSynced = existingTask ? (existingTask.taxesRealizadaSynced === true) : false;
      if (t.status === "Finalizada" && (!existingTask || existingTask.status !== "Finalizada")) {
        taxesRealizadaSynced = false;
      }

      mergedTasksMap.set(tId, {
        id: tId,
        // Once a task already has a date, it's frozen forever - it can never move to a
        // different day even if the client re-sends a different value (e.g. the calendar day
        // rolling over while the task is still open). A legacy task with no date yet is backfilled
        // from its own timer history (the day it really started), not from whatever the client
        // sent - only a genuinely brand-new task (no history at all) takes the client's value.
        date: (existingTask && existingTask.date)
          ? existingTask.date
          : (deriveTaskDateFromHistory(existingTask ? existingTask.timerHistory : t.timerHistory) || (t.date !== undefined ? t.date : null)),
        centroCosto: t.centroCosto !== undefined ? t.centroCosto : (existingTask ? existingTask.centroCosto : ""),
        empleado: t.empleado !== undefined ? t.empleado : (existingTask ? existingTask.empleado : ""),
        horasEstimadas: t.horasEstimadas !== undefined ? parseFloat(String(t.horasEstimadas).replace(',', '.')) || 0 : (existingTask ? existingTask.horasEstimadas : 0),
        descripcion: t.descripcion !== undefined && t.descripcion !== "" ? t.descripcion : (existingTask ? existingTask.descripcion : ""),
        status: t.status !== undefined ? t.status : (existingTask ? existingTask.status : "Pendiente"),
        insumos: (t.insumos !== undefined && String(t.insumos).trim() !== "") ? t.insumos : (existingTask ? existingTask.insumos || "" : ""),
        diagnostico: (t.diagnostico !== undefined && String(t.diagnostico).trim() !== "") ? t.diagnostico : (existingTask ? existingTask.diagnostico || "" : ""),
        timerStart: t.timerStart !== undefined ? t.timerStart : (existingTask ? existingTask.timerStart : null),
        timerStarted: t.timerStarted !== undefined ? (t.timerStarted === true || t.timerStarted === 'true') : (existingTask ? existingTask.timerStarted : false),
        timerHistory: Array.isArray(t.timerHistory) ? t.timerHistory : (existingTask ? existingTask.timerHistory || [] : []),
        synced: synced,
        taxesRealizadaSynced: taxesRealizadaSynced,
        verifiedLocked: existingTask ? (existingTask.verifiedLocked === true) : false,
        // Preserve which insumos were already pushed to the Google Sheet - without this,
        // every save of the order forgot this field and re-sent the same insumos again.
        sentInsumos: Array.isArray(existingTask ? existingTask.sentInsumos : null) ? existingTask.sentInsumos : []
      });
    });

    const mergedTasks = Array.from(mergedTasksMap.values());

    // Guard: a person can't physically work on two tasks at once (see
    // autoPauseConflictingTimers for why this has to be enforced server-side too).
    const previousTasksById = new Map((existing.tasks || []).map(et => [et.id, et]));
    autoPauseConflictingTimers(existing.id, mergedTasks, previousTasksById);

    const targetEstadoUnidad = estadoUnidad !== undefined ? estadoUnidad : existing.estadoUnidad;
    const isOutOfService = targetEstadoUnidad === 'fuera_de_servicio';
    const resolvedInterno = interno !== undefined ? interno : existing.interno;
    // If the user explicitly edited Rodado to something different from what was on file, trust
    // that edit outright - resolveRodadoForInterno's self-heal exists to fix a stale/wrong value
    // nobody touched, not to overrule someone who just typed a new one on purpose (it always
    // "wins" for a real catalog interno like a real truck number, silently discarding any manual
    // edit every single save).
    const rodadoWasExplicitlyChanged = rodado !== undefined && String(rodado).trim() !== String(existing.rodado || '').trim();
    const resolvedRodado = rodadoWasExplicitlyChanged
      ? rodado
      : resolveRodadoForInterno(resolvedInterno, rodado !== undefined ? rodado : existing.rodado);

    // Taller and Herrería/Edilicio must never share one order - split off anything whose own
    // centro de costo doesn't match this order's sector into a sibling order for the same
    // interno, instead of leaving it mixed in here (see routeForeignTasksToSiblingOrder).
    // A task's own centro de costo is the most direct, ground-truth signal of what sector an
    // order actually is - trust it over a stored `sector` that's merely "a valid-looking
    // string" (e.g. "Taller", which is what an order got by default whenever it was created
    // with no username header at all, well before the client sent its own active tab as
    // `sector` or before this self-heal existed - "Taller" passed every earlier check here as
    // already-valid, even when every one of its tasks was clearly Edilicio). Only fall back to
    // the stored/creator sector when the tasks themselves give no non-Taller signal at all.
    const VALID_SECTORS = ['Taller', 'Herrería', 'Edilicio'];
    const inferredSector = inferOrderSectorFromTasks(mergedTasks, centrosCostoList);
    let resolvedSectorField;
    if (inferredSector !== 'Taller') {
      resolvedSectorField = inferredSector;
    } else if (VALID_SECTORS.includes(existing.sector)) {
      resolvedSectorField = existing.sector;
    } else {
      const creatorSector = getSectorByUsername(createdBy);
      resolvedSectorField = VALID_SECTORS.includes(creatorSector) ? creatorSector : 'Taller';
    }
    const homeSector = getOrderSector(finalClasificacion, resolvedSectorField);
    const { own: finalTasksToSave, foreign: foreignTasksBySector } = splitTasksBySector(mergedTasks, homeSector, centrosCostoList);

    ['Herrería', 'Edilicio', 'Taller'].forEach(foreignSector => {
      if (foreignSector === homeSector) return;
      routeForeignTasksToSiblingOrder(foreignSector, foreignTasksBySector[foreignSector], {
        excludeOrderId: existing.id,
        interno: resolvedInterno,
        rodado: resolvedRodado,
        responsable,
        fechaEntrega,
        horario,
        incidente,
        createdBy,
        estadoUnidad: targetEstadoUnidad,
        combustibleReset: combustibleReset !== undefined ? combustibleReset : existing.combustibleReset,
        area: area !== undefined ? area : existing.area
      });
    });

    // Requires synced === true too (not just Finalizada) - a task marked done locally but not
    // yet pushed to Taxes shouldn't drop off into Historial before it's actually confirmed there.
    const allTasksCompleted = finalTasksToSave.length > 0 && finalTasksToSave.every(t => t && (t.status === "Finalizada" || t.status === "Completada") && t.synced === true);

    const explicitUnarchive = (req.body.archived === false);
    // Only force a resync on an ordinary edit if the OT header hasn't been created in
    // Taxes yet. Once it exists, edits stay as-is until something explicitly asks for a
    // sync (e.g. finishing the last task, or a manual retry) - otherwise every task edit
    // re-triggers the whole Puppeteer flow.
    const targetSyncStatus = req.body.syncStatus || (existing.taxesOrderNumber ? existing.syncStatus : "pending");

    // La orden pasa a Historial apenas la unidad queda Operativa (no Fuera de Servicio) Y
    // todas sus tareas están Finalizadas — no alcanza con que la unidad esté "operativa" si
    // todavía hay tareas en curso, o esa orden desaparece de Órdenes sin estar terminada.
    // No importa si todavía falta sincronizar o controlar con Taxes — eso lo sigue
    // resolviendo el worker de fondo aunque la orden ya esté archivada.
    // existing.unarchivedManually: once a user explicitly pulls an order back out of
    // Historial (PATCH .../unarchive) to fix something, it must NOT auto-archive itself right
    // back on the very next save just because its tasks were already marked done+synced from
    // before - only an explicit archive (the Archive button, or req.body.archived === true)
    // should send it back.
    const autoArchive = !isOutOfService && allTasksCompleted && !explicitUnarchive && !existing.unarchivedManually;
    // Hard gate: fuera de servicio NUNCA se archiva a Historial, ni siquiera si algo manda
    // explícitamente archived:true - no solo cuando se decide automáticamente.
    const isArchived = isOutOfService ? false : (explicitUnarchive ? false : ((req.body.archived === true) || autoArchive));
    // A deliberate re-archive (explicit or auto) supersedes the earlier manual un-archive -
    // otherwise it would stay permanently exempt from auto-archiving forever.
    const clearedUnarchiveFlag = isArchived ? false : existing.unarchivedManually;

    const updated = db.updateWorkOrder(req.params.id, {
      rodado: resolvedRodado,
      responsable,
      fechaEntrega,
      horario,
      interno,
      clasificacion: finalClasificacion,
      incidente,
      createdBy,
      syncStatus: targetSyncStatus,
      syncError: null,
      syncDate: null,
      estadoUnidad: targetEstadoUnidad,
      combustibleReset: combustibleReset !== undefined ? combustibleReset : existing.combustibleReset,
      // Backfill `sector` for orders created before this field existed, based on
      // whoever originally created it (not whoever is editing it now).
      sector: resolvedSectorField,
      area: area !== undefined ? area : existing.area,
      pendingElastiquero: pendingElastiquero !== undefined ? !!pendingElastiquero : existing.pendingElastiquero,
      tasks: finalTasksToSave,
      archived: isArchived,
      archivedAt: isArchived ? (existing.archivedAt || new Date().toISOString()) : null,
      unarchivedManually: clearedUnarchiveFlag
    });

    // Respond immediately to the frontend so UI modal never hangs
    res.json(updated);

    // Run background webhooks and instant Railway push asynchronously after response
    setImmediate(() => {
      try {
        try {
          const rwAgent = require('./railway_sync_agent');
          rwAgent.pushOrderToRailway(updated);
        } catch (rwErr) {
          // Ignore if on Railway cloud
        }

        checkAndTriggerGoogleSheetUpdates(existing, updated.tasks, responsable, interno);
        checkAndSendInsumosToSheet(existing, updated.tasks, responsable, interno);
        sendHistoricalOrderToGoogleSheet(updated, 'confirmar');
        triggerActiveTasksGoogleSheetSync();

        if (allTasksCompleted && updated.combustibleReset && !updated.combustibleReset.triggered) {
          updated.combustibleReset.triggered = true;
          db.updateWorkOrder(updated.id, { combustibleReset: updated.combustibleReset });
          triggerFuelServiceReset(updated);
        }
      } catch (err) {
        console.error("Background webhook error on order update:", err.message);
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update a single task field (e.g. horasEstimadas) without touching timerState
app.patch('/api/orders/:id/tasks/:taskId', (req, res) => {
  try {
    const order = db.getWorkOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const taskIdx = (order.tasks || []).findIndex(t => t.id === req.params.taskId);
    if (taskIdx === -1) return res.status(404).json({ error: 'Task not found' });

    // Only allow safe fields to be patched this way (not timerStart, timerHistory etc.)
    const ALLOWED = ['horasEstimadas', 'descripcion', 'status', 'insumos'];
    const updates = {};
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const updatedTasks = [...order.tasks];
    updatedTasks[taskIdx] = { ...updatedTasks[taskIdx], ...updates, synced: false };
    // Only force a resync here if the OT header doesn't exist in Taxes yet. Once it
    // does, this edit rides along with the next explicit sync (last task finalized, or
    // a manual retry) instead of re-triggering Puppeteer on every quick field edit.
    const patchUpdate = { tasks: updatedTasks, syncError: null };
    if (!order.taxesOrderNumber) {
      patchUpdate.syncStatus = 'pending';
    }
    db.updateWorkOrder(req.params.id, patchUpdate);
    checkAndSendInsumosToSheet(order, updatedTasks, order.responsable, order.interno);

    console.log(`[PATCH task] Order ${req.params.id} / Task ${req.params.taskId} updated:`, updates);
    res.json({ success: true, task: updatedTasks[taskIdx] });
  } catch (err) {
    console.error('[PATCH task] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Unlock task verification lock manually so it can be re-verified on next control run
app.patch('/api/orders/:id/tasks/:taskId/unlock', (req, res) => {
  try {
    const order = db.getWorkOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const taskIdx = (order.tasks || []).findIndex(t => t.id === req.params.taskId);
    if (taskIdx === -1) return res.status(404).json({ error: 'Task not found' });

    const updatedTasks = [...order.tasks];
    updatedTasks[taskIdx] = { ...updatedTasks[taskIdx], verifiedLocked: false };
    db.updateWorkOrder(req.params.id, { tasks: updatedTasks });

    res.json({ success: true, task: updatedTasks[taskIdx] });
  } catch (err) {
    console.error('[PATCH task unlock] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// If the OT tied to this order was deleted or renumbered directly in Taxes (so the sync
// worker can no longer find it to reconcile/edit), this clears the stale taxesOrderNumber
// and re-queues the order so the next sync attempt creates a brand-new OT instead of
// endlessly failing to find one that no longer exists.
app.post('/api/orders/:id/reset-taxes-number', (req, res) => {
  try {
    const order = db.getWorkOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });

    const updated = db.updateWorkOrder(req.params.id, {
      taxesOrderNumber: null,
      forceClearTaxesNumber: true,
      syncStatus: 'pending',
      syncError: null,
      autoSyncRetryCount: 0,
      lastAutoSyncAttempt: null,
      tasks: (order.tasks || []).map(t => t ? { ...t, synced: false } : t)
    });

    console.log(`[Reset OT] Orden ${req.params.id} (Interno ${order.interno}): se limpio taxesOrderNumber=${order.taxesOrderNumber} y se reencolo para crear una OT nueva.`);
    res.json({ success: true, order: updated });
  } catch (err) {
    console.error('[Reset OT] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Trigger Express OT Header Creation in Taxes (Etapa 1 - 2 to 4 seconds)
app.post('/api/orders/:id/sync-header', async (req, res) => {
  try {
    const order = db.getWorkOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });

    db.updateWorkOrder(req.params.id, { syncStatus: 'pending', syncError: null });

    let result = { success: true, message: 'Encolado para sincronización Express O.T.' };
    try {
      result = await syncWorker.syncExpressOtHeader(req.params.id);
    } catch (syncErr) {
      console.warn('[POST sync-header] Browser execution queued for local agent:', syncErr.message);
    }
    res.json(result);
  } catch (err) {
    console.error('[POST sync-header] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// RUTA 1: MÓDULO ÓRDENES - ALTA DE CABECERA
// ==========================================
app.post('/api/orders/create-header', async (req, res) => {
  const orderId = req.body.orderId || req.body.id;
  try {
    const result = await syncWorker.syncWorkOrder(orderId);
    if (result && result.success) {
      const order = db.getWorkOrderById(orderId);
      return res.status(200).json({ 
        status: "success", 
        taxesOrderNumber: (order ? order.taxesOrderNumber : null) || (result ? result.taxesOrderNumber : null),
        message: "Cabecera creada en Taxes exitosamente." 
      });
    } else {
      return res.status(500).json({ status: "error", message: (result ? result.message : "Error al sincronizar O.T.") });
    }
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// ==========================================
// RUTA 2: MÓDULO INYECCIÓN AL FINALIZAR
// ==========================================
app.post('/api/orders/finalize-tasks', async (req, res) => {
  const orderId = req.body.orderId || req.body.id;
  try {
    const result = await syncWorker.injectTasksToExistingOrder(orderId);
    if (result.success) {
      return res.status(200).json({ status: "success", message: "Tareas sincronizadas e historial cerrado." });
    } else {
      return res.status(500).json({ status: "error", message: result.message });
    }
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// =====================================================================
// API DE DESARROLLO: TRANSMISIÓN EN VIVO DEL NAVEGADOR (LIVE STREAM)
// =====================================================================
app.get('/api/dev/screenshot.jpg', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    if (global.paginaActivaParaStream && !global.paginaActivaParaStream.isClosed()) {
      const buffer = await global.paginaActivaParaStream.screenshot({ 
        type: 'jpeg', 
        quality: 65 
      });
      res.setHeader('Content-Type', 'image/jpeg');
      return res.send(buffer);
    }
  } catch (err) {
    // transient frame/navigation error
  }

  // Standby SVG badge image when Puppeteer is idle
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <rect width="1280" height="720" fill="#0f172a"/>
    <circle cx="640" cy="300" r="48" fill="#0284c7" opacity="0.2"/>
    <path d="M640 280 v40 m-20-20 h40" stroke="#38bdf8" stroke-width="4" stroke-linecap="round"/>
    <text x="640" y="390" fill="#38bdf8" font-family="system-ui, -apple-system, sans-serif" font-size="24" font-weight="700" text-anchor="middle">Navegador en Espera de Acción</text>
    <text x="640" y="430" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="16" text-anchor="middle">Presione '⚡ Obtener N° O.T.' en la app para ver el robot interactuar con Taxes en directo</text>
  </svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  return res.send(svg);
});

app.get(['/api/dev/stream', '/api/dev/live-view'], (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Auditoría en Vivo Puppeteer - Taxes</title>
      <style>
        body { background: #0f172a; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
        h2 { margin-bottom: 8px; color: #38bdf8; display: flex; align-items: center; gap: 10px; font-size: 22px; }
        .live-badge { background: #10b981; color: white; font-size: 12px; font-weight: bold; padding: 3px 10px; border-radius: 12px; animation: pulse 1.5s infinite; letter-spacing: 0.5px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .stream-container { background: #1e293b; border: 2px solid #334155; border-radius: 12px; padding: 8px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); max-width: 100%; width: 1280px; overflow: hidden; }
        img { width: 100%; height: auto; border-radius: 8px; display: block; background: #0f172a; }
        p { color: #94a3b8; font-size: 14px; margin-top: 4px; margin-bottom: 16px; }
        .fps-counter { font-size: 11px; color: #64748b; margin-top: 8px; }
      </style>
    </head>
    <body>
      <h2><span class="live-badge" id="statusBadge">EN VIVO</span> Auditoría de Puppeteer</h2>
      <p>Transmisión en directo del navegador desde Railway Cloud</p>
      <div class="stream-container">
        <img id="liveImg" src="/api/dev/screenshot.jpg" alt="Transmisión en vivo de Puppeteer" />
      </div>
      <div class="fps-counter" id="fpsText">Actualizando 2.5 FPS ...</div>

      <script>
        const img = document.getElementById('liveImg');
        const badge = document.getElementById('statusBadge');
        let isRefreshing = false;

        function refreshImage() {
          if (isRefreshing) return;
          isRefreshing = true;
          const nextImg = new Image();
          nextImg.onload = () => {
            img.src = nextImg.src;
            isRefreshing = false;
            badge.style.backgroundColor = '#10b981';
            badge.innerText = 'EN VIVO';
          };
          nextImg.onerror = () => {
            isRefreshing = false;
          };
          nextImg.src = '/api/dev/screenshot.jpg?t=' + Date.now();
        }

        setInterval(refreshImage, 350);
      </script>
    </body>
    </html>
  `);
});

// Trigger Single Task Sync to /tms/produccion/tareas (Etapa 2 - per task)
app.post('/api/orders/:id/tasks/:taskId/sync', async (req, res) => {
  try {
    const order = db.getWorkOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });
    if (order.estadoUnidad === 'fuera_de_servicio') {
      return res.status(400).json({ error: 'No se puede sincronizar: la unidad está Fuera de Servicio. Debe pasar a Operativo para subir tareas a Taxes.' });
    }

    const taskIndex = parseInt(req.params.taskId, 10);
    db.updateWorkOrder(req.params.id, { syncStatus: 'pending', syncError: null });

    let result = { success: true, message: `Sincronización de tarea #${taskIndex + 1} encolada.` };
    try {
      result = await syncWorker.syncSingleTaskToTareasForm(req.params.id, taskIndex);
    } catch (syncErr) {
      console.warn('[POST task sync] Browser execution queued for local agent:', syncErr.message);
    }
    res.json(result);
  } catch (err) {
    console.error('[POST task sync] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Trigger Batch Sync for all completed tasks missing sync
app.post('/api/orders/:id/sync-tasks', async (req, res) => {
  try {
    const order = db.getWorkOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });
    if (order.estadoUnidad === 'fuera_de_servicio') {
      return res.status(400).json({ error: 'No se puede sincronizar: la unidad está Fuera de Servicio. Debe pasar a Operativo para subir tareas a Taxes.' });
    }

    db.updateWorkOrder(req.params.id, { syncStatus: 'pending', syncError: null });

    let result = { success: true, message: 'Sincronización de tareas encolada.' };
    try {
      result = await syncWorker.syncCompletedTasksForOrder(req.params.id);
    } catch (syncErr) {
      console.warn('[POST sync-tasks] Browser execution queued for local agent:', syncErr.message);
    }
    res.json(result);
  } catch (err) {
    console.error('[POST sync-tasks] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Read-only endpoint to retrieve history of finished tasks with OPEN locks (not yet verified in Taxes)
app.get('/api/tasks/history', (req, res) => {
  try {
    const allOrders = db.read().workOrders || [];
    const catalogs = db.getCatalogs();
    const flatTasks = [];
    allOrders.forEach(order => {
      if (order.deleted === true) return;
      (order.tasks || []).forEach(task => {
        if (task && task.status === 'Finalizada' && task.verifiedLocked !== true) {
          const empOpt = (catalogs.empleados || []).find(e => e.value === task.empleado);
          const ccOpt = (catalogs.centrosCosto || []).find(c => c.value === task.centroCosto);
          const orderTotalHours = (order.tasks || []).reduce((sum, t) => {
            const h = parseFloat(String(t ? t.horasEstimadas || '0' : '0').replace(',', '.')) || 0;
            return sum + h;
          }, 0);
          flatTasks.push({
            orderId: order.id,
            taskId: task.id,
            interno: order.interno,
            rodado: order.rodado,
            taxesOrderNumber: order.taxesOrderNumber || null,
            fechaEntrega: order.fechaEntrega,
            empleado: empOpt ? empOpt.label : (task.empleado || ''),
            empleadoCode: task.empleado || '',
            centroCosto: ccOpt ? ccOpt.label : (task.centroCosto || ''),
            descripcion: task.descripcion || '',
            horasEstimadas: task.horasEstimadas || 0,
            insumos: task.insumos || '',
            verifiedLocked: task.verifiedLocked === true,
            orderTotalHours: orderTotalHours
          });
        }
      });
    });
    flatTasks.sort((a, b) => new Date(b.fechaEntrega || 0) - new Date(a.fechaEntrega || 0));
    res.json(flatTasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Lock task verification lock manually
app.patch('/api/orders/:id/tasks/:taskId/lock', (req, res) => {
  try {
    const order = db.getWorkOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const taskIdx = (order.tasks || []).findIndex(t => t.id === req.params.taskId);
    if (taskIdx === -1) return res.status(404).json({ error: 'Task not found' });

    const updatedTasks = [...order.tasks];
    updatedTasks[taskIdx] = { ...updatedTasks[taskIdx], verifiedLocked: true };
    db.updateWorkOrder(req.params.id, { tasks: updatedTasks });

    res.json({ success: true, task: updatedTasks[taskIdx] });
  } catch (err) {
    console.error('[PATCH task lock] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Force re-sync of an order from history (resets syncStatus to pending and clears locks)
app.post('/api/orders/:id/force-resync', (req, res) => {
  try {
    const order = db.getWorkOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (typeof worker.clearAbandoned === 'function') {
      worker.clearAbandoned(req.params.id);
    }
    db.updateWorkOrder(req.params.id, {
      syncStatus: 'pending',
      syncError: null,
      syncLockTime: null,
      autoSyncRetryCount: 0,
      verifiedStatus: null,
      verifiedError: null
    });
    // Immediately spawn background sync execution for this order
    setTimeout(() => {
      if (typeof worker.syncWorkOrderWithTimeout === 'function') {
        worker.syncWorkOrderWithTimeout(req.params.id).catch(e => console.error('[ForceResync Worker] Error:', e.message));
      }
    }, 100);
    res.json({ success: true });
  } catch (err) {
    console.error('[Force Resync] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Clear a wrong/stale taxesOrderNumber so the next sync creates a brand-new O.T. in Taxes
// instead of trying to re-open a header that doesn't really correspond to this order.
app.post('/api/orders/:id/clear-ot-number', (req, res) => {
  try {
    const order = db.getWorkOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const previousOtNumber = order.taxesOrderNumber || null;
    if (typeof worker.clearAbandoned === 'function') {
      worker.clearAbandoned(req.params.id);
    }
    db.updateWorkOrder(req.params.id, {
      taxesOrderNumber: null,
      syncStatus: 'pending',
      syncError: null,
      syncLockTime: null,
      autoSyncRetryCount: 0,
      verifiedStatus: null,
      verifiedError: null
    });
    setTimeout(() => {
      if (typeof worker.syncWorkOrderWithTimeout === 'function') {
        worker.syncWorkOrderWithTimeout(req.params.id).catch(e => console.error('[ClearOtNumber Worker] Error:', e.message));
      }
    }, 100);
    console.log(`[Clear OT Number] Order ${req.params.id}: cleared taxesOrderNumber "${previousOtNumber}", will create a new O.T.`);
    res.json({ success: true, previousOtNumber });
  } catch (err) {
    console.error('[Clear OT Number] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a single task from an order
app.delete('/api/orders/:id/tasks/:taskId', (req, res) => {
  try {
    const order = db.getWorkOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const updatedTasks = (order.tasks || []).filter(t => t.id !== req.params.taskId);
    db.updateWorkOrder(req.params.id, { tasks: updatedTasks });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE task] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a work order (local only)
app.delete('/api/orders/:id', (req, res) => {

  try {
    const existing = db.getWorkOrderById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    const requester = req.headers['x-user-username'] || null;
    const userPerms = db.getUserPermissions(requester);
    if (!userPerms.canDelete) {
      return res.status(403).json({ error: "No tiene permiso configurado para eliminar órdenes." });
    }

    const success = db.deleteWorkOrder(req.params.id);
    
    // Trigger active tasks Google Sheets update
    triggerActiveTasksGoogleSheetSync();

    res.json({ success });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle automatic background sync on/off
app.post('/api/settings/toggle-sync', (req, res) => {
  try {
    const current = db.getSettings();
    const disabled = req.body && req.body.autoSyncDisabled !== undefined ? !!req.body.autoSyncDisabled : !current.autoSyncDisabled;
    db.saveSettings({ autoSyncDisabled: disabled });
    console.log(`[AutoSync] Background automatic sync is now ${disabled ? 'PAUSED' : 'ACTIVE'}.`);
    res.json({ success: true, autoSyncDisabled: disabled });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get ALL orders (active + archived) — used by sync agent to reconcile complete database
app.get('/api/orders/all', (req, res) => {
  try {
    const all = db.read().workOrders || [];
    res.json(all);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

let cachedArchivedOrders = null;
let lastArchivedFetchTime = 0;

// Get archived orders (fast cached & supports page/limit pagination for 500+ orders)
app.get('/api/orders/archived', (req, res) => {
  try {
    if (req.query.page || req.query.limit) {
      const paginated = db.getArchivedOrdersPaginated(req.query.page, req.query.limit);
      return res.json(paginated);
    }
    const now = Date.now();
    if (!cachedArchivedOrders || (now - lastArchivedFetchTime) > 5000) {
      cachedArchivedOrders = db.getArchivedOrders() || [];
      lastArchivedFetchTime = now;
    }
    res.json(cachedArchivedOrders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get audit log of deleted orders
app.get('/api/orders/deleted-log', (req, res) => {
  try {
    const logs = db.getDeletedOrdersLog() || [];
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 7-DAY ROLLING BACKUP ENDPOINTS ────────────────────────────────────────────

// Get all backup snapshots (last 7 days)
app.get('/api/backup/orders', (req, res) => {
  try {
    const requester = req.headers['x-user-username'] || null;
    const userPerms = db.getUserPermissions(requester);
    if (!userPerms.canRestoreBackup) {
      return res.status(403).json({ error: 'No tiene permisos para ver el respaldo.' });
    }
    const backups = db.getBackupOrders();
    res.json(backups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Restore a specific order from backup
app.post('/api/backup/restore/:id', (req, res) => {
  try {
    const requester = req.headers['x-user-username'] || null;
    const userPerms = db.getUserPermissions(requester);
    if (!userPerms.canRestoreBackup) {
      return res.status(403).json({ error: 'No tiene permisos para restaurar órdenes desde el respaldo.' });
    }
    const restored = db.restoreFromBackup(req.params.id);
    if (!restored) {
      return res.status(404).json({ error: 'Orden no encontrada en el respaldo.' });
    }
    console.log(`[Backup] Restored order ${req.params.id} (Interno: ${restored.interno}) by ${requester}`);
    res.json({ success: true, order: restored });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Restore a soft-deleted or backup order back to active Historial
app.post('/api/orders/:id/restore', (req, res) => {
  try {
    const orderId = String(req.params.id).trim();
    const dbData = db.read();
    let target = (dbData.workOrders || []).find(o => String(o.id) === orderId || String(o.taxesOrderNumber) === orderId);
    
    if (!target && dbData.backupOrders) {
      target = dbData.backupOrders[orderId];
      if (!target) {
        const foundKey = Object.keys(dbData.backupOrders).find(k => String(dbData.backupOrders[k].taxesOrderNumber) === orderId);
        if (foundKey) target = dbData.backupOrders[foundKey];
      }
    }
    
    if (!target) {
      return res.status(404).json({ error: 'Orden no encontrada en borradas ni respaldo' });
    }

    // Restore properties
    target.deleted = false;
    target.deletedAt = null;
    target.archived = true;
    target.archivedAt = target.archivedAt || new Date().toISOString();
    target.syncStatus = 'pending';
    target.syncError = null;
    target.syncLockTime = null;
    target.autoSyncRetryCount = 0;

    const idx = (dbData.workOrders || []).findIndex(o => String(o.id) === String(target.id));
    if (idx !== -1) {
      dbData.workOrders[idx] = target;
    } else {
      dbData.workOrders.push(target);
    }

    db.write(dbData);
    cachedArchivedOrders = null;
    console.log(`[Restore] Restored order ${target.id} (OT: ${target.taxesOrderNumber || 'N/A'}) to Historial.`);
    res.json({ success: true, order: target });
  } catch (err) {
    console.error('[Restore Order] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger pruning of orders older than 7 days
app.post('/api/backup/prune', (req, res) => {
  try {
    const requester = req.headers['x-user-username'] || null;
    const userPerms = db.getUserPermissions(requester);
    if (!userPerms.canRestoreBackup) {
      return res.status(403).json({ error: 'No tiene permisos para ejecutar limpieza del respaldo.' });
    }
    const pruned = db.pruneBackupOrders();
    res.json({ success: true, pruned });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Soft-archive a work order
app.patch('/api/orders/:id/archive', (req, res) => {
  try {
    const order = db.getWorkOrderById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }
    db.archiveWorkOrder(req.params.id);
    res.json({ success: true, message: "Orden archivada." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Un-archive a work order (re-sync)
app.patch('/api/orders/:id/unarchive', (req, res) => {
  try {
    const order = db.getWorkOrderById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }
    db.updateWorkOrder(req.params.id, {
      archived: false,
      archivedAt: null,
      unarchivedManually: true,
      syncStatus: "local",
      syncError: null,
      autoSyncRetryCount: 999,
      lastAutoSyncAttempt: new Date().toISOString(),
      verifiedStatus: "idle",
      verifiedError: null
    });
    res.json({ success: true, message: "Orden desarchivada y puesta en edición local." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cleanup finished synced orders from the app
app.post('/api/orders/cleanup', (req, res) => {
  try {
    const requester = req.headers['x-user-username'] || null;
    const { sector: reqSector, type = 'finished' } = req.body || {};

    console.log(`[Cleanup Request] requester: ${requester}, reqSector: ${reqSector}, type: ${type}`);

    let sector = reqSector || getSectorByUsername(requester);
    if (sector === 'Admin') {
      sector = 'Taller'; // Safe default
    }

    const orders = db.getWorkOrders() || [];
    const idsToDelete = [];

    orders.forEach(order => {
      // Check sector permission (clasificacion OR sector - see GET /api/orders for why)
      const cls = order.clasificacion;
      const isOrderHerreria = isHerreria(cls) || isHerreria(order.sector);
      const isOrderEdilicio = isEdilicio(cls) || isEdilicio(order.sector);
      if (sector === 'Herrería' && !isOrderHerreria) return;
      if (sector === 'Edilicio' && !isOrderEdilicio) return;
      if (sector === 'Taller' && (isOrderHerreria || isOrderEdilicio)) return;

      const tasks = (order.tasks || []).filter(t => t !== null && t !== undefined);
      const allFinished = tasks.length === 0 || tasks.every(t => t.status === "Finalizada");
      
      // Force out of service if active/paused timers exist
      const hasActiveOrPausedTimer = tasks.some(t => t.status !== 'Finalizada' && (t.timerStarted || t.timerStart || t.status === 'En Proceso'));
      const isOutOfService = order.estadoUnidad === 'fuera_de_servicio';

      const isSynced = order.syncStatus === 'success';
      const isVerified = order.verifiedStatus === 'success';

      // SAFEGUARD: Never delete any order that has active running timers or unfinished tasks
      if (!allFinished || hasActiveOrPausedTimer) return;

      if (type === 'controlled') {
        // Controlled cleanup: synced+verified orders can always be deleted regardless of OOS state
        if (allFinished && isSynced && isVerified) {
          idsToDelete.push(order.id);
        }
      } else if (type === 'all-synced') {
        if (isSynced && allFinished) {
          idsToDelete.push(order.id);
        }
      } else {
        // Default: finished and operative (not blocked by OOS)
        if (allFinished && !isOutOfService) {
          idsToDelete.push(order.id);
        }
      }
    });

    if (idsToDelete.length > 0) {
      db.deleteWorkOrders(idsToDelete);
      triggerActiveTasksGoogleSheetSync();
    }

    res.json({ success: true, count: idsToDelete.length });
  } catch (error) {
    console.error("[Cleanup Error] Failed to cleanup:", error);
    res.status(500).json({ error: error.message });
  }
});

// Force retry sync of a work order
app.post('/api/orders/retry/:id', async (req, res) => {
  try {
    const order = db.getWorkOrderById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    const requester = req.headers['x-user-username'] || null;
    const userPerms = db.getUserPermissions(requester);
    if (!userPerms.canSync) {
      return res.status(403).json({ error: "No tiene permiso configurado para sincronizar órdenes." });
    }

    if (order.estadoUnidad === 'fuera_de_servicio' && order.taxesOrderNumber) {
      return res.status(400).json({ error: "No se puede volver a subir a Taxes: la unidad está Fuera de Servicio. El N° de O.T. ya está creado; el resto se sube cuando pase a Operativo." });
    }

    // Solo bloquear reintento si la orden ya fue creada en Taxes (tiene taxesOrderNumber)
    // y se intenta resincronizar con tareas incompletas. Si nunca se subió a Taxes,
    // debemos permitir subirla para que se cree la O.T.
    if (order.taxesOrderNumber) {
      const allCompleted = (order.tasks || []).length > 0 && (order.tasks || []).every(t => t.status === "Finalizada");
      if (!allCompleted) {
        return res.status(400).json({ error: "No se puede subir a Taxes: la orden tiene tareas en proceso o incompletas." });
      }
    }

    // Reset status to pending so worker picks it up immediately
    db.updateWorkOrder(order.id, { syncStatus: "pending", syncError: null, syncTriggeredBy: requester || null });
    
    res.json({ success: true, message: "Sincronización encolada para reintento." });

    // Trigger worker immediately in background on local server
    setImmediate(() => {
      try {
        const worker = require('./syncWorker');
        worker.syncWorkOrderWithTimeout(order.id).catch(err => console.error('[RetrySync] Worker error:', err.message));
      } catch (err) {
        console.error('[RetrySync] Trigger error:', err.message);
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint for local PC agent to upload sync results directly
app.post('/api/orders/local-sync-result/:id', (req, res) => {
  try {
    const { syncStatus, syncError, syncDate, tasks, verifiedStatus, verifiedError, verifiedCount, taxesOrderNumber } = req.body;
    let existing = db.getWorkOrderById(req.params.id);
    if (!existing) {
      // If the Debian is pushing a soft-delete for an order that doesn't exist on Railway yet,
      // create it already marked as deleted so it doesn't get processed.
      db.createWorkOrder({
        id: req.params.id,
        rodado: req.body.rodado || '',
        responsable: req.body.responsable || 'AUTO',
        fechaEntrega: req.body.fechaEntrega || '',
        horario: req.body.horario || '',
        interno: req.body.interno || '',
        clasificacion: req.body.clasificacion || '',
        incidente: req.body.incidente || '',
        tasks: req.body.tasks || [],
        estadoUnidad: req.body.estadoUnidad || 'operativo',
        combustibleReset: req.body.combustibleReset,
        taxesOrderNumber: req.body.taxesOrderNumber,
        syncStatus: req.body.syncStatus || 'success',
        verifiedStatus: req.body.verifiedStatus || 'success',
        archived: req.body.archived === true,
        deleted: req.body.deleted === true,
        deletedAt: req.body.deletedAt || (req.body.deleted === true ? new Date().toISOString() : null)
      });
      existing = db.getWorkOrderById(req.params.id);
    }

    // If this is purely a soft-delete propagation (Debian deleted the order), update only deleted state
    if (req.body.deleted === true) {
      db.updateWorkOrder(req.params.id, {
        deleted: true,
        deletedAt: req.body.deletedAt || existing.deletedAt || new Date().toISOString()
      });
      return res.json({ success: true });
    }

    // Normalize status strings coming from external agents
    const normalizeSyncStatus = (val) => {
      if (!val) return val;
      const v = String(val).toLowerCase();
      if (['success', 'synced', 'ok', 'done', 'completed', 'completado', 'sincronizado'].includes(v)) return 'success';
      if (['error', 'failed', 'fail', 'fallo', 'falló'].includes(v)) return 'error';
      if (['pending', 'pendiente'].includes(v)) return 'pending';
      if (['syncing', 'sincronizando'].includes(v)) return 'syncing';
      return val;
    };

    const normalizeVerifiedStatus = (val) => {
      if (!val) return val;
      const v = String(val).toLowerCase();
      if (['success', 'ok', 'done', 'correcto'].includes(v)) return 'success';
      if (['error', 'failed', 'fail', 'fallo', 'falló'].includes(v)) return 'error';
      if (['checking', 'verificando'].includes(v)) return 'checking';
      return val;
    };

    const updates = {
      syncStatus: normalizeSyncStatus(syncStatus),
      syncError,
      syncDate,
      verifiedStatus: normalizeVerifiedStatus(verifiedStatus),
      verifiedError,
      verifiedCount
    };

    if (req.body.rodado) updates.rodado = req.body.rodado;
    if (req.body.interno) updates.interno = req.body.interno;
    if (req.body.responsable) updates.responsable = req.body.responsable;
    if (req.body.clasificacion) updates.clasificacion = req.body.clasificacion;
    if (req.body.incidente !== undefined) updates.incidente = req.body.incidente;
    if (req.body.estadoUnidad) updates.estadoUnidad = req.body.estadoUnidad;
    if (req.body.hasOwnProperty('archived')) updates.archived = req.body.archived === true;

    // CRITICAL: Only update 'tasks' if it was explicitly sent in the body.
    if (req.body.hasOwnProperty('tasks') && Array.isArray(tasks) && tasks.length > 0) {
      updates.tasks = tasks;
    }

    if (taxesOrderNumber !== undefined && taxesOrderNumber !== null) {
      updates.taxesOrderNumber = taxesOrderNumber;
    }

    const targetEstadoUnidad = req.body.estadoUnidad !== undefined ? req.body.estadoUnidad : existing.estadoUnidad;
    const isOutOfService = targetEstadoUnidad === 'fuera_de_servicio';

    // Both were referenced below but never defined - this made the endpoint throw a
    // ReferenceError on every call, so the sync result never actually got saved and the
    // order stayed stuck showing "sincronizando" forever no matter how many times the local
    // agent reported a real result for it.
    const currentTasks = updates.tasks || existing.tasks || [];
    const allTasksFinished = currentTasks.length > 0 && currentTasks.every(t => t && (t.status === 'Finalizada' || t.status === 'Completada'));
    const allTasksSynced = currentTasks.length > 0 && currentTasks.every(t => t && t.synced === true);
    
    // STRICT ARCHIVING RULE: Only archive if explicitly requested OR (OPERATIVO + 100% tasks finished + 100% tasks synced in Taxes)
    if (req.body.archived === true || (req.body.archived !== false && !isOutOfService && allTasksFinished && allTasksSynced)) {
      updates.archived = true;
      updates.archivedAt = existing.archivedAt || new Date().toISOString();
      console.log(`[LocalSyncResult] Order ${req.params.id} archived to history.`);
    } else {
      updates.archived = false;
      updates.archivedAt = null;
    }

    // Propagate soft-delete state if explicitly sent
    if (req.body.hasOwnProperty('deleted')) {
      updates.deleted = req.body.deleted === true;
      updates.deletedAt = req.body.deleted === true
        ? (req.body.deletedAt || existing.deletedAt || new Date().toISOString())
        : null;
    }

    db.updateWorkOrder(req.params.id, updates);
    const updatedOrder = db.getWorkOrderById(req.params.id);
    if (updatedOrder && (updatedOrder.syncStatus === 'success' || updatedOrder.taxesOrderNumber)) {
      sendHistoricalOrderToGoogleSheet(updatedOrder, 'confirmar');
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



// Force verification of a work order on Taxes
app.post('/api/orders/verify/:id', async (req, res) => {
  try {
    const orderId = req.params.id;
    const order = db.getWorkOrderById(orderId);
    if (!order) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }
    if (!order.taxesOrderNumber) {
      return res.status(400).json({ error: "La orden no tiene número de OT asignado (no sincronizada)." });
    }

    const requester = req.headers['x-user-username'] || null;
    const sector = getSectorByUsername(requester);

    // Check sector permission (clasificacion OR sector - see GET /api/orders for why)
    const existingCls = order.clasificacion;
    const existingIsHerreria = isHerreria(existingCls) || isHerreria(order.sector);
    const existingIsEdilicio = isEdilicio(existingCls) || isEdilicio(order.sector);
    const isPaniol = sector === 'Admin' || (requester && (requester.toLowerCase().includes('paniol') || requester.toLowerCase().includes('panol') || requester.toLowerCase().includes('pañol')));
    if (!isPaniol) {
      if ((sector === 'Herrería' || isHerreria(sector)) && !existingIsHerreria) {
        return res.status(403).json({ error: "No tiene permisos para controlar esta orden." });
      }
      if ((sector === 'Edilicio' || isEdilicio(sector)) && !existingIsEdilicio) {
        return res.status(403).json({ error: "No tiene permisos para controlar esta orden." });
      }
      if (sector === 'Taller' && (existingIsHerreria || existingIsEdilicio)) {
        return res.status(403).json({ error: "No tiene permisos para controlar esta orden." });
      }
    }

    // Set checking status
    db.updateWorkOrder(orderId, { verifiedStatus: "checking" });

    // Call verifyWorkOrder in background
    worker.verifyWorkOrderWithTimeout(orderId).then(result => {
      console.log(`Background verification completed for order ${orderId}:`, result);
    }).catch(err => {
      console.error(`Background verification failed for order ${orderId}:`, err);
    });

    res.json({ success: true, message: "Control encolado." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify ALL given order IDs at once using parallel browser sessions
app.post('/api/orders/verify-all', async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: "orderIds must be a non-empty array" });
    }

    // Only accept orders that are synced and currently not already checking
    const eligible = orderIds.filter(id => {
      const order = db.getWorkOrderById(id);
      return order && order.verifiedStatus !== 'checking';
    });

    if (eligible.length === 0) {
      return res.json({ success: true, queued: 0, message: "No hay órdenes elegibles para controlar." });
    }

    // Mark all as checking immediately
    for (const id of eligible) {
      db.updateWorkOrder(id, { verifiedStatus: 'checking' });
    }

    // Run verifyMultipleOrders in background (no await — respond immediately)
    worker.verifyMultipleOrders(eligible).then(() => {
      console.log(`[VerifyAll] Background verification of ${eligible.length} order(s) complete.`);
    }).catch(err => {
      console.error(`[VerifyAll] Background error:`, err);
    });

    res.json({ success: true, queued: eligible.length, message: `${eligible.length} orden(es) encoladas para control.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clears every order stuck in syncStatus 'error' back to 'pending' in one shot (for
// starting the day without a backlog of failed syncs). Deliberately does NOT trigger
// Puppeteer immediately per order like /force-resync does - it just re-queues them, and
// the existing background worker loop (10s poll, one order at a time) picks them up at
// its own controlled pace instead of firing many browsers at once.
app.post('/api/orders/retry-all-errors', (req, res) => {
  try {
    const orders = db.getWorkOrders() || [];
    const failed = orders.filter(o => !o.archived && !o.deleted && o.syncStatus === 'error');

    if (failed.length === 0) {
      return res.json({ success: true, queued: 0, message: "No hay órdenes con error para reintentar." });
    }

    failed.forEach(o => {
      db.updateWorkOrder(o.id, { syncStatus: 'pending', syncError: null, autoSyncRetryCount: 0 });
    });

    res.json({ success: true, queued: failed.length, message: `${failed.length} orden(es) encoladas para resincronizar.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify specific order IDs or all orders containing unverified history tasks
app.post('/api/tasks/verify-history', async (req, res) => {
  try {
    let { orderIds } = req.body || {};
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      // Default to all order IDs of unverified tasks in history
      const allOrders = db.read().workOrders || [];
      const eligibleSet = new Set();
      allOrders.forEach(order => {
        const hasUnverifiedFinishedTask = (order.tasks || []).some(t => t && t.status === 'Finalizada' && t.verifiedLocked !== true);
        if (hasUnverifiedFinishedTask) {
          eligibleSet.add(order.id);
        }
      });
      orderIds = Array.from(eligibleSet);
    }

    const eligible = orderIds.filter(id => {
      const order = db.getWorkOrderById(id);
      return order && order.verifiedStatus !== 'checking';
    });

    if (eligible.length === 0) {
      return res.json({ success: true, queued: 0, message: "No hay tareas pendientes de controlar en Taxes." });
    }

    for (const id of eligible) {
      db.updateWorkOrder(id, { verifiedStatus: 'checking' });
    }

    worker.verifyMultipleOrders(eligible).then(() => {
      console.log(`[TaskVerify] Background task verification of ${eligible.length} order(s) complete.`);
    }).catch(err => {
      console.error(`[TaskVerify] Background error:`, err);
    });

    res.json({ success: true, queued: eligible.length, message: `${eligible.length} orden(es) encoladas para control de tareas en Taxes.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get current Taxes connection settings
app.get('/api/settings', (req, res) => {
  try {
    const settings = db.getSettings();
    const requestingUser = req.query.username || null;

    // If a specific user is requesting, show THEIR credentials (not the global ones)
    let displayUsername = settings.username;
    let displayPassword = settings.password ? "••••••••••••" : "";

    if (requestingUser) {
      const userRecord = db.getUser(requestingUser);
      if (userRecord && userRecord.username) {
        displayUsername = userRecord.username;
        displayPassword = userRecord.password ? "••••••••••••" : "";
      } else {
        // If user record doesn't exist for the requesting user, do NOT bleed the global settings
        displayUsername = requestingUser;
        displayPassword = "";
      }
    }

    const isMainSupervisor = requestingUser ? (
      requestingUser.toLowerCase().includes("paniol") || 
      requestingUser.toLowerCase().includes("belocures") || 
      requestingUser.toLowerCase().includes("cesar") ||
      requestingUser.toLowerCase().includes("taller") ||
      requestingUser.toLowerCase().includes("sergio") ||
      requestingUser.toLowerCase().includes("brahim") ||
      requestingUser.toLowerCase().includes("toledo") ||
      requestingUser.toLowerCase().includes("carmona")
    ) : (
      settings.username && (
        settings.username.toLowerCase().includes("paniol") ||
        settings.username.toLowerCase().includes("belocures") ||
        settings.username.toLowerCase().includes("cesar") ||
        settings.username.toLowerCase().includes("taller") ||
        settings.username.toLowerCase().includes("sergio") ||
        settings.username.toLowerCase().includes("brahim") ||
        settings.username.toLowerCase().includes("toledo") ||
        settings.username.toLowerCase().includes("carmona")
      )
    );

    let catalogStatus = settings.catalogSyncStatus || "idle";
    if (catalogStatus === "syncing" && !worker.getIsScraping()) {
      console.log("[Settings] Auto-correcting stuck catalogSyncStatus from 'syncing' to 'idle' because worker is not scraping.");
      catalogStatus = "idle";
      db.saveSettings({ catalogSyncStatus: "idle", catalogSyncError: null });
    }

    const responseSettings = {
      username: displayUsername,
      password: displayPassword,
      portalUrl: settings.portalUrl || "https://taxes.com.ar",
      googleScriptUrl: settings.googleScriptUrl || "",
      googleActiveTasksUrl: settings.googleActiveTasksUrl || "",
      preventivoScriptUrl: settings.preventivoScriptUrl || "",
      parteTallerScriptUrl: settings.parteTallerScriptUrl || "",
      geminiApiKey: settings.geminiApiKey || "",
      claudeApiKey: settings.claudeApiKey || "",
      catalogSyncStatus: catalogStatus,
      catalogSyncError: settings.catalogSyncError || null,
      isSupervisor: !!isMainSupervisor,
      employeeMappings: settings.employeeMappings || null
    };
    res.json(responseSettings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Save connection settings
app.post('/api/settings', (req, res) => {
  try {
    const { username, password, portalUrl, googleScriptUrl, googleActiveTasksUrl, preventivoScriptUrl, parteTallerScriptUrl, geminiApiKey, claudeApiKey, employeeMappings } = req.body;
    const requestingUser = req.headers['x-user-username'] || null;
    const current = db.getSettings();
    
    // If we have the requesting user, update their personal credentials in db.users
    if (requestingUser && username && password && password !== "••••••••••••") {
      db.saveUser(username, password);
      console.log(`[Settings] Updated credentials for user ${requestingUser} -> ${username}`);
    }

    const updates = {
      portalUrl: portalUrl !== undefined ? portalUrl : current.portalUrl,
      googleScriptUrl: googleScriptUrl !== undefined ? googleScriptUrl : current.googleScriptUrl,
      googleActiveTasksUrl: googleActiveTasksUrl !== undefined ? googleActiveTasksUrl : current.googleActiveTasksUrl,
      preventivoScriptUrl: preventivoScriptUrl !== undefined ? preventivoScriptUrl : current.preventivoScriptUrl,
      parteTallerScriptUrl: parteTallerScriptUrl !== undefined ? parteTallerScriptUrl : current.parteTallerScriptUrl
    };

    if (geminiApiKey !== undefined) {
      updates.geminiApiKey = geminiApiKey.trim();
    }

    if (claudeApiKey !== undefined) {
      updates.claudeApiKey = claudeApiKey.trim();
    }

    // Save employee mappings (per-sector mapping table for Pañol)
    if (employeeMappings !== undefined) {
      updates.employeeMappings = employeeMappings;
      console.log(`[Settings] Employee mappings updated by ${requestingUser || 'unknown'}`);
    }

    // Only update global username/password if this is the global/primary user
    const isPrimaryUser = !current.username || 
                          (requestingUser && current.username.toLowerCase().trim() === (username || '').toLowerCase().trim());
    if (isPrimaryUser) {
      updates.username = username !== undefined ? username : current.username;
      if (password && password !== "••••••••••••") {
        updates.password = password;
        // Also keep this exact username's personal credential record (db.users) in sync,
        // regardless of which app account is doing the saving — otherwise features that
        // look up credentials per-username (like the catalog sync button) can end up using
        // a stale password even after it was just corrected here in Ajustes.
        db.saveUser(updates.username, password);
      }
    }

    const saved = db.saveSettings(updates);
    res.json({ success: true, settings: { username: saved.username, portalUrl: saved.portalUrl, googleScriptUrl: saved.googleScriptUrl, googleActiveTasksUrl: saved.googleActiveTasksUrl, preventivoScriptUrl: saved.preventivoScriptUrl, parteTallerScriptUrl: saved.parteTallerScriptUrl, employeeMappings: saved.employeeMappings || null } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test Google Sheets Apps Script URL connection
app.post('/api/settings/test-google-sheet', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "Falta la URL del script." });
    }

    const testParams = new URLSearchParams({
      interno: "test",
      rubro: "test",
      subrubro: "test",
      observacion: "test",
      mecanico: "test",
      supervisor: "test"
    });

    const testUrl = `${url}${url.includes('?') ? '&' : '?'}${testParams.toString()}`;
    console.log(`[Google Sheets Test] Testing connection to URL: ${testUrl}`);

    const response = await fetch(testUrl);
    if (!response.ok) {
      return res.status(response.status).json({ error: `El script devolvió estado HTTP ${response.status}` });
    }

    const text = await response.text();
    try {
      const data = JSON.parse(text);
      res.json(data);
    } catch (parseError) {
      console.error("[Google Sheets Test] Failed to parse JSON response:", text.substring(0, 200));
      if (text.trim().startsWith('<')) {
        return res.status(400).json({ 
          error: "El script devolvió HTML en lugar de JSON. Esto suele ocurrir si pegaste la URL de la hoja de Google Sheet en lugar de la 'URL de la aplicación web' del script de Google Apps Script, o si el script no está configurado para acceso 'Cualquiera' (Anyone)." 
        });
      }
      return res.status(400).json({ error: `Respuesta no válida del script: ${text.substring(0, 100)}` });
    }
  } catch (error) {
    console.error("[Google Sheets Test] Connection test failed:", error.message);
    res.status(500).json({ error: `Falló la conexión: ${error.message}` });
  }
});

// Test Google Active Tasks script URL connection
app.post('/api/settings/test-google-active-tasks', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "Falta la URL del script." });
    }

    console.log(`[Google Sheets Active Tasks Test] Testing connection to URL: ${url}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'updateActiveTasks',
        tasks: []
      })
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `El script devolvió estado HTTP ${response.status}` });
    }

    const text = await response.text();
    try {
      const data = JSON.parse(text);
      res.json(data);
    } catch (parseError) {
      console.error("[Google Sheets Active Tasks Test] Failed to parse JSON response:", text.substring(0, 200));
      if (text.trim().startsWith('<')) {
        return res.status(400).json({ 
          error: "El script devolvió HTML en lugar de JSON. Esto suele ocurrir si pegaste la URL de la hoja de Google Sheet en lugar de la 'URL de la aplicación web' del script de Google Apps Script, o si el script no está configurado para acceso 'Cualquiera' (Anyone)." 
        });
      }
      return res.status(400).json({ error: `Respuesta no válida del script: ${text.substring(0, 100)}` });
    }
  } catch (error) {
    console.error("[Google Sheets Active Tasks Test] Connection test failed:", error.message);
    res.status(500).json({ error: `Falló la conexión: ${error.message}` });
  }
});

// Parse physical sheets (OCR) using Google Gemini Vision API
app.post('/api/bulk/parse-planilla', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: "No se proporcionó ninguna imagen." });
    }

    const settings = db.getSettings();
    const apiKey = settings.geminiApiKey;
    if (!apiKey) {
      return res.status(400).json({ error: "La Clave de API de Google Gemini no está configurada. Por favor, ve a Configuración e ingrésala." });
    }

    // Split the data URI prefix if present (e.g. data:image/jpeg;base64,...)
    let mimeType = "image/jpeg";
    let base64Data = image;
    if (image.startsWith("data:")) {
      const match = image.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        mimeType = match[1];
        base64Data = match[2];
      }
    }

    console.log(`[Gemini OCR] Sending image (${(base64Data.length/1024/1024).toFixed(2)} MB) to Google Gemini API...`);

    const geminiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const promptText = `Analiza esta imagen que es una foto de una planilla física de taller donde se registran mantenimientos y consumo de insumos de vehículos (camiones).
La planilla tiene columnas para el número de "Interno" (identificador del vehículo) y columnas para los insumos o notas (por ejemplo: "Refrigerante", "Aceite Motor", "Caja", "Diferencial", "Novedades", "Observaciones", "Notas", etc.).
El mecánico escribe a mano números (litros de insumo usado), "OK" o "0" (si la unidad fue revisada pero no se usó insumo), o texto con novedades/notas en la columna de Notas.

Tu tarea es extraer de forma precisa toda la información manuscrita para cada fila de la planilla.
Devuelve estrictamente un array JSON de objetos con el siguiente formato, sin bloques de código markdown (\`\`\`json) y sin explicaciones adicionales. El resultado debe ser únicamente el string JSON válido para poder ser parseado directamente con JSON.parse:
[
  {
    "interno": "número de interno (ej: 50)",
    "revisado": true (si tiene cualquier anotación manuscrita en esa fila, número, OK, cero o nota, de lo contrario false),
    "refrigerante": número de litros o null,
    "aceite_motor": número de litros o null,
    "grasa_caja": número de litros o null,
    "grasa_diferencial": número de litros o null,
    "hco_direccion": número de litros o null,
    "otros": "texto escrito en la columna de Notas/Observaciones o null"
  }
]`;

    const payload = {
      contents: [
        {
          parts: [
            { text: promptText },
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Data
              }
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    };

    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[Gemini OCR] Google API Error:", errText);
      throw new Error(`Google API returned status ${response.status}: ${errText}`);
    }

    const result = await response.json();
    const responseText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!responseText) {
      throw new Error("No se recibió respuesta del modelo de IA.");
    }

    // Clean up the text response in case the model ignored responseMimeType and added markdown
    let cleanJsonText = responseText.trim();
    if (cleanJsonText.startsWith("```")) {
      cleanJsonText = cleanJsonText.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    }

    const data = JSON.parse(cleanJsonText);
    res.json(data);

  } catch (error) {
    console.error("[Gemini OCR] Error parsing planilla:", error);
    res.status(500).json({ error: error.message });
  }
});

// AI assistant chat endpoint
app.post('/api/assistant/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) {
      return res.status(400).json({ error: "No se proporcionó ningún mensaje." });
    }

    const settings = db.getSettings();
    const apiKey = settings.geminiApiKey || process.env.GEMINI_API_KEY;
    const claudeApiKey = settings.claudeApiKey || process.env.CLAUDE_API_KEY;
    if (!apiKey && !claudeApiKey) {
      return res.status(400).json({ error: "La Clave de API de Google Gemini o Anthropic Claude no está configurada. Por favor, ve a Ajustes e ingrésala." });
    }

    const scriptUrl = settings.preventivoScriptUrl;

    // ── 0. Action Detection: Check if user explicitly wants to ACTION / RECORD a status change ──
    const lowerMsg = message.toLowerCase();
    const hasActionVerb = lowerMsg.includes('marcar') || 
                          lowerMsg.includes('poner') || 
                          lowerMsg.includes('cambiar') || 
                          lowerMsg.includes('registrar') || 
                          lowerMsg.includes('pasar a') || 
                          lowerMsg.includes('setear');

    const isNovedadOrStatus = hasActionVerb && (
      lowerMsg.includes('fuera de servicio') || 
      lowerMsg.includes('novedad') || 
      lowerMsg.includes('parado') || 
      lowerMsg.includes('reparacion') || 
      lowerMsg.includes('reparación') || 
      lowerMsg.includes('servicio pendiente') || 
      lowerMsg.includes('servicios pendientes') || 
      lowerMsg.includes('operativo') ||
      lowerMsg.includes('rotura')
    );

    const matchUnit = message.match(/(?:interno|unidad|camion|camión|nro|nº)?\s*#?(\d{1,4})\b/i);

    if (isNovedadOrStatus && matchUnit) {
      const internoDetected = matchUnit[1];
      let nuevoEstado = 'fuera_de_servicio';
      if (lowerMsg.includes('operativo') || lowerMsg.includes('alta') || lowerMsg.includes('listo')) {
        nuevoEstado = 'operativo';
      } else if (lowerMsg.includes('servicio pendiente') || lowerMsg.includes('servicios pendientes') || lowerMsg.includes('pendiente')) {
        nuevoEstado = 'servicios_pendientes';
      } else if (lowerMsg.includes('reparacion') || lowerMsg.includes('reparación') || lowerMsg.includes('taller')) {
        nuevoEstado = 'reparacion';
      } else if (lowerMsg.includes('fuera de servicio') || lowerMsg.includes('parado') || lowerMsg.includes('rotura')) {
        nuevoEstado = 'fuera_de_servicio';
      }

      let noveltyText = message
        .replace(/(?:marcar|unidad|interno|camion|camión|nro|nº)?\s*#?\d{1,4}/gi, '')
        .replace(/fuera de servicio|servicios pendientes|servicio pendiente|reparaciones|reparación|reparacion|novedad|parado|en taller|marcar como|esta en|está en|pendiente|poner|cambiar|registrar/gi, '')
        .trim();
      if (!noveltyText || noveltyText.length < 2) {
        noveltyText = message.trim();
      }

      try {
        actualizarEstadoFlotaLocal(internoDetected, nuevoEstado, noveltyText, req.headers['x-user-username'] || 'Chatbot');
        const estadoLabel = nuevoEstado === 'fuera_de_servicio' ? '❌ Fuera de Servicio' :
                           (nuevoEstado === 'reparacion' ? '🔧 En Reparación' :
                           (nuevoEstado === 'servicios_pendientes' ? '📋 Servicios Pendientes' : '✅ Operativo'));
        return res.json({
          response: `✅ **Novedad registrada en Parte de Taller**:\n- **Unidad:** #${internoDetected}\n- **Estado:** ${estadoLabel}\n- **Novedad:** "${noveltyText}"\n\nEl Parte de Taller fue actualizado inmediatamente.`
        });
      } catch (actErr) {
        console.error('[Chatbot Action] Error updating parte taller:', actErr);
      }
    }

    // ── 1a. Fetch active in-app work orders ──
    let activeOrdersContext = "";
    try {
      const activeOrders = db.getWorkOrders();
      // Also include recently archived orders (last 30 days)
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const recentArchived = db.getArchivedOrders().filter(o => {
        const archivedTs = new Date(o.archivedAt || o.createdAt || 0).getTime();
        return archivedTs > thirtyDaysAgo;
      });
      const allOrdersForAI = [...activeOrders, ...recentArchived];

      if (allOrdersForAI.length > 0) {
        const ordersText = allOrdersForAI.map(o => {
          const estadoLabel = o.estadoUnidad === 'fuera_de_servicio' ? 'FUERA DE SERVICIO' :
                             (o.estadoUnidad === 'servicios_pendientes' ? 'SERVICIOS PENDIENTES' :
                             (o.estadoUnidad === 'reparacion' ? 'EN REPARACIÓN' : 'OPERATIVO'));

          // Calculate real hours from timerHistory if available
          const tareasText = (o.tasks || []).map(t => {
            let horasReales = parseFloat(t.horasEstimadas) || 0;
            if (Array.isArray(t.timerHistory) && t.timerHistory.length > 0) {
              horasReales = t.timerHistory.reduce((sum, h) => {
                const end = h.end || Date.now();
                return sum + (end - h.start) / 3600000;
              }, 0);
              horasReales = Math.round(horasReales * 10) / 10;
            }
            return `    - "${t.descripcion || 'Sin descripción'}" | Mecánico: ${t.empleado || 'N/A'} | Horas: ${horasReales}h | Estado: ${t.status || 'Pendiente'}${t.insumos ? ' | Insumos: ' + t.insumos : ''}`;
          }).join('\n');

          const pendientes = (o.tasks || []).filter(t => t.status !== 'Finalizada').length;
          const finalizadas = (o.tasks || []).filter(t => t.status === 'Finalizada').length;
          const totalHoras = (o.tasks || []).reduce((sum, t) => sum + (parseFloat(t.horasEstimadas) || 0), 0);

          return `Interno: ${o.interno} | Unidad: ${o.rodado || 'N/A'} | Tipo: ${o.clasificacion || 'N/A'} | Estado unidad: ${estadoLabel} | Taxes OT: ${o.taxesOrderNumber ? '#' + o.taxesOrderNumber : 'N/A'} | ${o.archived ? '[EN HISTORIAL]' : '[ACTIVA]'}\n  Problema/Incidente: ${o.incidente || 'No especificado'}\n  Tareas (${finalizadas} finalizadas, ${pendientes} pendientes, ${totalHoras.toFixed(1)}h estimadas):\n${tareasText || '    (Sin tareas asignadas)'}`;
        }).join('\n\n');
        activeOrdersContext = `\n==== ÓRDENES DE TRABAJO EN LA APP ====\n${ordersText}\n====================================`;
      }
    } catch (ordersErr) {
      console.warn('[AI Chat] Error fetching active orders:', ordersErr);
    }

    // ── 1b. Fetch Parte de Taller fleet status ──
    let parteTallerContext = "";
    try {
      const ptState = db.getParteTallerState();
      const fueraLists = [
        ...(ptState.reparacion || []).map(u => ({ ...u, estadoLabel: 'En Reparación' })),
        ...(ptState.fuera_de_servicio || []).map(u => ({ ...u, estadoLabel: 'Fuera de Servicio' }))
      ];
      if (fueraLists.length > 0) {
        const ptText = fueraLists.map(u =>
          `Interno ${u.interno}: ${u.estadoLabel}${u.novedad ? ' - ' + u.novedad.replace(/\n/g, '; ') : ''}${u.dia_parado ? ' (parado desde: ' + u.dia_parado + ')' : ''}`
        ).join('\n');
        parteTallerContext = `\n==== PARTE MECÁNICO / PARTE DE TALLER (unidades fuera de servicio) ====\n${ptText}\n======================================================================`;
      } else {
        parteTallerContext = `\n==== PARTE MECÁNICO / PARTE DE TALLER ====\nTodas las unidades del parte están operativas.\n==========================================`;
      }
    } catch (ptErr) {
      console.warn('[AI Chat] Error fetching parte taller:', ptErr);
    }

    // ── 1c. Fetch the history from Google Sheets (Try GViz CSV first for the 2026 DB, fallback to Apps Script) ──
    let sheetHistoryData = [];
    try {
      const csvUrl = 'https://docs.google.com/spreadsheets/d/1QK698StrEr9v7HgJUrtN1GFtb3ixk_2ql78dkx1_3Vk/export?format=csv&gid=659919704';
      const response = await fetch(csvUrl, { signal: AbortSignal.timeout(6000) });
      if (response.ok) {
        const text = await response.text();
        const lines = text.trim().split('\n');
        if (lines.length > 1) {
          const parsed = [];
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            const parts = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (parts.length >= 6) {
              const clean = (val) => (val || '').replace(/^"|"$/g, '').trim();
              parsed.push({
                rowIndex: i + 1,
                fecha: clean(parts[0]),       // Column A (Equipo)
                interno: clean(parts[1]),     // Column B (INTERNO)
                tipo: clean(parts[2]),        // Column C (Movimiento)
                datos: clean(parts[3]),       // Column D (Detalle)
                conductor: clean(parts[4]),   // Column E (Proveedor)
                patente: clean(parts[5]),     // Column F (Fecha)
                litros: clean(parts[6]),      // Column G (MES)
                day: clean(parts[7]),         // Column H (Trabajo)
                month: clean(parts[8])        // Column I (Cantidad)
              });
            }
          }
          sheetHistoryData = parsed.reverse();
        }
      }
    } catch (csvErr) {
      console.warn("Could not fetch history from direct CSV, falling back to Apps Script:", csvErr);
    }

    if (sheetHistoryData.length === 0) {
      try {
        const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}accion=getHistoryData`;
        const response = await fetch(url);
        if (response.ok) {
          sheetHistoryData = await response.json();
        }
      } catch (err) {
        console.error("Error fetching preventivos history for assistant:", err);
      }
    }

    // Filter and optimize history to avoid hitting Gemini 429 rate limits or overloading context
    let optimizedHistory = [];
    const match = message.match(/(?:interno|unidad|camion|nro|nº)?\s*(\d{1,3})\b/i);
    let targetInterno = null;
    if (match) {
      targetInterno = match[1];
    }

    // Extract keywords for filtering
    const keywords = [];
    const lowerMessage = message.toLowerCase();
    
    // Core workshop categories
    if (lowerMessage.includes("auxilio")) keywords.push("auxilio");
    if (lowerMessage.includes("elastico") || lowerMessage.includes("elástico")) keywords.push("elastico");
    if (lowerMessage.includes("preventivo")) keywords.push("preventivo");
    if (lowerMessage.includes("correctivo")) keywords.push("correctivo");
    if (lowerMessage.includes("aceite") || lowerMessage.includes("filtro") || lowerMessage.includes("service")) keywords.push("service", "aceite", "filtro");
    if (lowerMessage.includes("embrague")) keywords.push("embrague");
    if (lowerMessage.includes("motor")) keywords.push("motor");
    if (lowerMessage.includes("caja")) keywords.push("caja");
    if (lowerMessage.includes("freno")) keywords.push("freno");
    if (lowerMessage.includes("alternador") || lowerMessage.includes("arranque") || lowerMessage.includes("bateria") || lowerMessage.includes("batería")) keywords.push("electr", "arranque", "bater", "alterna");
    if (lowerMessage.includes("bomba") || lowerMessage.includes("hidraul")) keywords.push("bomba", "hidraul");
    if (lowerMessage.includes("cubierta") || lowerMessage.includes("goma") || lowerMessage.includes("pinchadura")) keywords.push("goma", "cubiert", "pinch");

    // Check if query is workshop/repair related (e.g. not a general fuel inquiry)
    const isWorkshopQuery = keywords.length > 0 || 
                            lowerMessage.includes("reparac") || 
                            lowerMessage.includes("arregl") || 
                            lowerMessage.includes("taller") || 
                            lowerMessage.includes("repuesto") || 
                            lowerMessage.includes("mecanic") ||
                            lowerMessage.includes("hizo") ||
                            lowerMessage.includes("realiz") ||
                            lowerMessage.includes("quien") ||
                            lowerMessage.includes("quién") ||
                            lowerMessage.includes("ranking") ||
                            lowerMessage.includes("cambio");

    let filteredHistory = sheetHistoryData;

    // Apply Interno filter
    if (targetInterno) {
      filteredHistory = filteredHistory.filter(h => String(h.interno).trim() === String(targetInterno).trim());
    }

    // If it's a workshop/repair query, filter out fuel loads entirely to keep context clean
    if (isWorkshopQuery) {
      filteredHistory = filteredHistory.filter(h => {
        const tipo = String(h.tipo || '').toUpperCase();
        const datos = String(h.datos || '').toUpperCase();
        return !tipo.includes("COMBUSTIBLE") && !datos.includes("LTS");
      });
    }

    // Sort filteredHistory by rowIndex descending so that the most recent rows are prioritized
    filteredHistory.sort((a, b) => (b.rowIndex || 0) - (a.rowIndex || 0));

    // Normalize keywords to singular (e.g. "auxilios" -> "auxilio") to improve matching
    const normalizedKeywords = keywords.map(kw => {
      if (kw.length > 3 && kw.endsWith('s')) {
        return kw.slice(0, -1);
      }
      return kw;
    });

    // Apply keyword matcher to prioritize relevant rows
    if (normalizedKeywords.length > 0) {
      // Find rows that match the keywords
      const matchedRows = filteredHistory.filter(h => {
        const textToSearch = `${h.tipo} ${h.datos} ${h.conductor} ${h.patente} ${h.day || ''}`.toLowerCase();
        return normalizedKeywords.some(kw => textToSearch.includes(kw));
      });
      
      // Find rows that don't match the keywords
      const unmatchedRows = filteredHistory.filter(h => {
        const textToSearch = `${h.tipo} ${h.datos} ${h.conductor} ${h.patente} ${h.day || ''}`.toLowerCase();
        return !normalizedKeywords.some(kw => textToSearch.includes(kw));
      });

      // Combine: prioritize matched rows, then fill up with recent unmatched records for context
      optimizedHistory = [...matchedRows, ...unmatchedRows.slice(0, 100)];
    } else {
      // Default slice
      optimizedHistory = filteredHistory.slice(0, 250);
    }

    // Remove duplicates
    const seenKeys = new Set();
    optimizedHistory = optimizedHistory.filter(h => {
      const key = `${h.interno}-${h.tipo}-${h.datos}-${h.day || ''}-${h.patente || h.fecha || ''}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    // Sort by rowIndex (descending, i.e., most recent first)
    optimizedHistory.sort((a, b) => (b.rowIndex || 0) - (a.rowIndex || 0));

    // Limit final list to 300 records to keep token size low
    optimizedHistory = optimizedHistory.slice(0, 300);

    // Format a concise version of the history to keep context small and readable
    const formattedHistory = optimizedHistory.map(h => {
      // Date resolution logic (column A for fuel/KM, column F/patente for mechanical)
      const isDate = (str) => {
        if (!str || str === '-') return false;
        return /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(str);
      };
      
      let recordDate = '-';
      if (isDate(h.fecha)) {
        recordDate = h.fecha;
      } else if (isDate(h.patente)) {
        recordDate = h.patente;
      } else if (isDate(h.date)) {
        recordDate = h.date;
      }
      
      // Detalle/Trabajo resolution:
      // Column D (index 3, h.datos) is "Detalle" (like "Auxilio").
      // Column H (index 7, h.day) is "Trabajo" (like "sacar cardan 128...").
      let detailText = h.datos || '-';
      if (h.day && h.day !== '-' && h.day !== h.datos) {
        detailText = `${h.datos} (${h.day})`;
      }
      
      return `Fecha: ${recordDate}, Interno: ${h.interno || '-'}, Tipo/Movimiento: ${h.tipo || '-'}, Detalle/Trabajo: ${detailText}, Conductor/Proveedor: ${h.conductor || '-'}`;
    }).join('\n');

    let finalResponseText = "";

    const systemPrompt = `Sos "Hugo AI", el asistente inteligente de mantenimiento de taller de Contenedores Hugo.
Tu objetivo es ayudar al personal respondiendo preguntas sobre el estado de las órdenes de trabajo, tareas realizadas, horas trabajadas, mecánicos asignados, pendientes y servicios históricos.

Tenés acceso a TRES fuentes de información:
1. Las ÓRDENES DE TRABAJO ACTIVAS en la app (tareas, horas, mecánicos, estado operativo/fuera de servicio, pendientes)
2. El PARTE MECÁNICO / PARTE DE TALLER (estado actual de la flota)
3. El HISTORIAL DE SERVICIOS en Google Sheets (preventivos y correctivos históricos)
${activeOrdersContext}
${parteTallerContext}

==== HISTORIAL DE SERVICIOS (Google Sheets) ====
${formattedHistory || "No hay registros en el historial actualmente."}
================================================

Instrucciones:
1. Respondé en español de forma concisa y amigable.
2. Para preguntas sobre una orden específica (qué trabajo se hizo, horas, mecánico, qué queda pendiente), priorizá las ÓRDENES DE TRABAJO EN LA APP.
3. Si pregunta si una unidad está OPERATIVA o FUERA DE SERVICIO, buscá en las órdenes activas y en el Parte Mecánico.
4. Si pregunta qué QUEDA PENDIENTE, listá las tareas con estado "Pendiente" de esa orden.
5. Si pregunta cuántas HORAS tiene la orden, sumá las horas estimadas de todas las tareas.
6. Para preguntas de historial de servicios pasados (última vez que se cambió X, etc.), usá el historial de Google Sheets.
7. Si no encontrás información sobre la consulta, indicalo amablemente sin inventar datos.`;

    if (claudeApiKey) {
      // Use Anthropic Claude API (claude-3-5-haiku-20241022 is extremely fast and capable)
      const claudeUrl = "https://api.anthropic.com/v1/messages";
      const messages = [];
      if (history && Array.isArray(history)) {
        history.forEach(h => {
          messages.push({
            role: h.role === "user" ? "user" : "assistant",
            content: h.text
          });
        });
      }
      messages.push({
        role: "user",
        content: message
      });

      const payload = {
        model: "claude-sonnet-5",
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages
      };

      const claudeResponse = await fetch(claudeUrl, {
        method: "POST",
        headers: {
          "x-api-key": claudeApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!claudeResponse.ok) {
        const errText = await claudeResponse.text();
        console.error("[Claude Chat] API Error:", errText);
        throw new Error(`Claude API returned status ${claudeResponse.status}: ${errText}`);
      }

      const result = await claudeResponse.json();
      const textBlock = (result?.content || []).find(c => c.type === "text");
      finalResponseText = textBlock?.text || "";
    } else {
      // Use Google Gemini API
      const geminiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
      const contents = [];
      if (history && Array.isArray(history)) {
        history.forEach(h => {
          contents.push({
            role: h.role === "user" ? "user" : "model",
            parts: [{ text: h.text }]
          });
        });
      }

      const userPrompt = `${systemPrompt}\n\nPregunta del usuario: ${message}`;
      contents.push({
        role: "user",
        parts: [{ text: userPrompt }]
      });

      const payload = {
        contents: contents
      };

      const geminiResponse = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!geminiResponse.ok) {
        const errText = await geminiResponse.text();
        console.error("[Gemini Chat] API Error:", errText);
        throw new Error(`Google API returned status ${geminiResponse.status}: ${errText}`);
      }

      const result = await geminiResponse.json();
      finalResponseText = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }

    if (!finalResponseText) {
      throw new Error("No se recibió respuesta del asistente de IA.");
    }

    res.json({ response: finalResponseText.trim() });

  } catch (error) {
    console.error("[Gemini Chat] Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get catalogs dropdown options
app.get('/api/catalogs', (req, res) => {
  try {
    const catalogs = db.getCatalogs();
    res.json(catalogs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Supervisor-maintained areas/sectors within a building (Baño, Oficina, Depósito...) for
// Edilicio orders - lets one interno (building) split into a separate O.T. per area instead
// of merging all its work into a single order.
app.get('/api/areas-edilicio', (req, res) => {
  try {
    res.json({ areas: db.getAreasEdilicio() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/areas-edilicio', (req, res) => {
  try {
    const areas = db.addAreaEdilicio(req.body && req.body.nombre);
    res.json({ areas });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update catalogs from sync agent or local backup
app.post('/api/catalogs/update', (req, res) => {
  try {
    if (req.body && req.body.rodados && Array.isArray(req.body.rodados) && req.body.rodados.length > 0) {
      db.saveCatalogs(req.body);
      console.log(`[CatalogsUpdate] Successfully updated catalogs. Rodados: ${req.body.rodados.length}`);
      return res.json({ success: true });
    }
    res.status(400).json({ error: "Invalid catalogs payload" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Trigger manual catalog extraction from website
app.post('/api/catalogs/sync', async (req, res) => {
  try {
    const username = req.headers['x-user-username'] || null;
    // Run catalog scraping asynchronously so response is fast
    worker.scrapeCatalogsWithTimeout(username).then(result => {
      console.log("Async Catalog sync complete:", result);
    }).catch(e => {
      console.error("Async Catalog sync error:", e);
    });

    res.json({ success: true, message: "Extracción de catálogos iniciada en segundo plano." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get worker status
app.get('/api/worker/status', (req, res) => {
  res.json({
    isScraping: worker.getIsScraping()
  });
});

// Get active mechanics list
app.get('/api/active-mechanics', (req, res) => {
  try {
    const list = db.getActiveMechanics();
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update active mechanics list
app.post('/api/active-mechanics', (req, res) => {
  try {
    const { list } = req.body;
    if (!Array.isArray(list)) {
      return res.status(400).json({ error: "El cuerpo debe contener una lista en formato array." });
    }
    const saved = db.saveActiveMechanics(list);
    res.json({ success: true, list: saved });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- PREVENTIVOS PROXY ENDPOINTS ---
function applyOdometerOverrides(data) {
  if (!Array.isArray(data)) return data;
  const overrides = db.getOdometerOverrides();

  return data.map(item => {
    const key = String(item.interno || '').trim();
    const cleanNumKey = key.replace(/\D/g, '');
    const ovKey = Object.keys(overrides).find(k => {
      const cleanK = k.replace(/\D/g, '');
      return k === key || (cleanNumKey && cleanK && cleanK === cleanNumKey);
    });

    const ov = ovKey ? overrides[ovKey] : null;
    const patched = { ...item };

    // Determinar medida (Hs vs KM)
    const isHs = patched.unidadMedida === 'hs' || 
                 String(patched.serviFreq || '').toLowerCase().includes('hs') || 
                 String(patched.modelo || '').toLowerCase().includes('iveco');

    if (ov) {
      if (isHs) {
        if (ov.hs !== undefined && !isNaN(ov.hs)) patched.hsReales = ov.hs;
      } else {
        if (ov.km !== undefined && !isNaN(ov.km)) patched.kmReales = ov.km;
      }
      if (ov.ultServiceKm !== undefined) patched.ultServiceKm = ov.ultServiceKm;
      if (ov.ultServiceHs !== undefined) patched.ultServiceHs = ov.ultServiceHs;
    }

    const freqRaw = String(patched.serviFreq || '');
    const freqNum = parseFloat(freqRaw.replace(/[^0-9\.]/g, '')) || 0;

    const currentHs = parseFloat(String(patched.hsReales || 0).replace(/[^0-9\.]/g, '')) || 0;
    const currentKm = parseFloat(String(patched.kmReales || 0).replace(/[^0-9\.]/g, '')) || 0;

    // Valores de Ultimo servicio (Col K/L/M de Google Sheets u override)
    const ultHs = parseFloat(String(patched.ultServiceHs || patched.ultimoServicioHs || patched.ultServiceRealizadoHs || 0).replace(/[^0-9\.]/g, '')) || 0;
    const ultKm = parseFloat(String(patched.ultServiceKm || patched.ultimoServicioKm || patched.ultServiceRealizadoKm || 0).replace(/[^0-9\.]/g, '')) || 0;

    let pasaron = 0;
    if (isHs) {
      pasaron = (ultHs > 0 && currentHs >= ultHs) ? (currentHs - ultHs) : 0;
    } else {
      pasaron = (ultKm > 0 && currentKm >= ultKm) ? (currentKm - ultKm) : 0;
    }

    if (freqNum > 0) {
      const rem = freqNum - pasaron;
      const remaining = Math.max(0, rem);

      patched.restante = Math.round(remaining);
      patched.faltante = Math.round(remaining).toLocaleString('es-AR') + (isHs ? ' Hs' : ' km');

      if (remaining <= 0 || (pasaron >= freqNum && freqNum > 0)) {
        patched.alerta = 'Realizar Service';
      } else {
        patched.alerta = 'OK';
      }
    }

    return patched;
  });
}

let preventivosFlotaCache = null;
let preventivosFlotaCacheTime = 0;

app.get('/api/preventivos/flota', async (req, res) => {
  const now = Date.now();
  if (preventivosFlotaCache && (now - preventivosFlotaCacheTime < 15 * 1000) && !req.query.force) {
    return res.json(applyOdometerOverrides(preventivosFlotaCache));
  }

  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  if (!scriptUrl) {
    return res.status(400).json({ error: "URL del script de preventivos no configurada." });
  }
  try {
    const sep = scriptUrl.includes('?') ? '&' : '?';
    const url = `${scriptUrl}${sep}accion=getFleetData&_t=${now}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    let data = await response.json();
    preventivosFlotaCache = data;
    preventivosFlotaCacheTime = now;

    res.json(applyOdometerOverrides(data));
  } catch (error) {
    console.error("Error fetching preventivos fleet:", error);
    if (preventivosFlotaCache) {
      return res.json(applyOdometerOverrides(preventivosFlotaCache));
    }
    res.status(500).json({ error: error.message });
  }
});

// Set a manual km/hs override for a specific interno (bypasses Apps Script cache)
app.post('/api/preventivos/odometer-override', (req, res) => {
  try {
    const { interno, km, hs } = req.body;
    if (!interno) return res.status(400).json({ error: "interno requerido" });
    const result = db.setOdometerOverride(interno, km, hs);
    res.json({ success: true, override: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear a manual override (once Google Sheets data is fresh again)
app.delete('/api/preventivos/odometer-override/:interno', (req, res) => {
  try {
    db.clearOdometerOverride(req.params.interno);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/preventivos/combustible', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  if (!scriptUrl) {
    return res.status(400).json({ error: "URL del script de preventivos no configurada." });
  }
  try {
    const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}accion=getFuelData`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error fetching preventivos fuel:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/preventivos/livianas', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  
  const defaultLivianas = [
    { originalRowIndex: 4, interno: 'A01', modelo: 'TOYOTA HILUX', sector: 'TALLER', serviFreq: '10.000 km', kmReales: 168414, hsReales: 0, faltante: '300 km', unidadMedida: 'km', alerta: 'Realizar Service' },
    { originalRowIndex: 5, interno: 'A02', modelo: 'VOLKSWAGEN SAVEIRO 1,6L', sector: 'TALLER', serviFreq: '10.000 km', kmReales: 74901, hsReales: 0, faltante: '3.732 km', unidadMedida: 'km', alerta: 'OK' },
    { originalRowIndex: 6, interno: 'A04', modelo: 'VOLKSWAGEN AMAROK', sector: 'TALLER', serviFreq: '10.000 km', kmReales: 56916, hsReales: 0, faltante: '6.048 km', unidadMedida: 'km', alerta: 'OK' },
    { originalRowIndex: 7, interno: 'A05', modelo: 'VOLKSWAGEN AMAROK', sector: 'TALLER', serviFreq: '10.000 km', kmReales: 68896, hsReales: 0, faltante: '5.891 km', unidadMedida: 'km', alerta: 'OK' },
    { originalRowIndex: 8, interno: 'A07', modelo: 'VOLKSWAGEN AMAROK', sector: 'TALLER', serviFreq: '10.000 km', kmReales: 100443, hsReales: 0, faltante: '10.000 km', unidadMedida: 'km', alerta: 'OK' },
    { originalRowIndex: 9, interno: 'A10', modelo: 'FIAT CRONOS', sector: 'BURGOS', serviFreq: '10.000 km', kmReales: 18232, hsReales: 0, faltante: '3.004 km', unidadMedida: 'km', alerta: 'OK' },
    { originalRowIndex: 10, interno: 'A11', modelo: 'FIAT STRADA', sector: 'TOLEDO', serviFreq: '10.000 km', kmReales: 19416, hsReales: 0, faltante: '1.502 km', unidadMedida: 'km', alerta: 'OK' },
    { originalRowIndex: 11, interno: 'AU09', modelo: 'HANGCHA S-30 CPCD25T8', sector: 'HERRERIA', serviFreq: '300 Hs', kmReales: 17191, hsReales: 0, faltante: '50 Hs', unidadMedida: 'hs', alerta: 'Realizar Service' },
    { originalRowIndex: 12, interno: 'AU10', modelo: 'HANGCHA S-30 CPCD35N', sector: 'LAVADERO', serviFreq: '300 Hs', kmReales: 9161, hsReales: 0, faltante: '250 Hs', unidadMedida: 'hs', alerta: 'OK' },
    { originalRowIndex: 13, interno: 'AU11', modelo: 'HANGCHA S-30 CPCD25T8', sector: 'TALLER', serviFreq: '300 Hs', kmReales: 13229, hsReales: 0, faltante: '300 Hs', unidadMedida: 'hs', alerta: 'OK' },
    { originalRowIndex: 14, interno: 'AU12', modelo: 'HANGCHA S-30 CPCD25N', sector: 'RECICLAJE', serviFreq: '300 Hs', kmReales: 13933, hsReales: 0, faltante: '89 Hs', unidadMedida: 'hs', alerta: 'OK' },
    { originalRowIndex: 15, interno: 'MP28', modelo: 'BOBCAT S570', sector: 'DESCARGA', serviFreq: '300 Hs', kmReales: 250000, hsReales: 0, faltante: '10 Hs', unidadMedida: 'hs', alerta: 'Realizar Service' },
    { originalRowIndex: 16, interno: 'MP29', modelo: 'BOBCAT S570', sector: 'DESCARGA', serviFreq: '300 Hs', kmReales: 13647, hsReales: 0, faltante: '300 Hs', unidadMedida: 'hs', alerta: 'OK' },
    { originalRowIndex: 17, interno: 'RT01', modelo: 'BY LION TRACTOR', sector: 'MDQ', serviFreq: '300 Hs', kmReales: 111111, hsReales: 0, faltante: '300 Hs', unidadMedida: 'hs', alerta: 'OK' }
  ];

  try {
    let data = null;
    if (scriptUrl) {
      const sep = scriptUrl.includes('?') ? '&' : '?';
      const url = `${scriptUrl}${sep}accion=getLivianasData&_t=${Date.now()}`;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const raw = await response.json();
            if (Array.isArray(raw) && raw.length > 0) data = raw;
          }
        }
      } catch (err) {
        // Fall back to defaultLivianas
      }
    }

    if (!data) data = defaultLivianas;

    res.json(applyOdometerOverrides(data));
  } catch (error) {
    console.error("Error fetching preventivos livianas:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/preventivos/historial', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  if (!scriptUrl) {
    return res.status(400).json({ error: "URL del script de preventivos no configurada." });
  }
  try {
    const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}accion=getHistoryData`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error fetching preventivos history:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/preventivos/alertas', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  if (!scriptUrl) {
    return res.status(400).json({ error: "URL del script de preventivos no configurada." });
  }
  try {
    const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}accion=getAlertsData`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error fetching preventivos alerts:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/preventivos/service', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  const { rowIndex, km, hs, interno, vehicleType } = req.body;

  if (interno) {
    db.setServiceOverride(interno, km, hs);
  }

  if (!scriptUrl) {
    return res.json({ ok: true, message: "Service actualizado localmente." });
  }

  try {
    const params = new URLSearchParams({
      accion: 'updateService',
      rowIndex,
      km: km || 0,
      hs: hs || 0,
      interno: interno || '',
      vehicleType: vehicleType || ''
    });
    const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error updating preventivos service:", error);
    res.json({ ok: true, message: "Service actualizado localmente." });
  }
});

app.get('/api/preventivos/historial', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  if (!scriptUrl) {
    return res.status(400).json({ error: "URL del script de preventivos no configurada." });
  }
  try {
    const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}accion=getHistoryData`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error fetching preventivos history:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/preventivos/alertas', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  if (!scriptUrl) {
    return res.status(400).json({ error: "URL del script de preventivos no configurada." });
  }
  try {
    const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}accion=getAlertsData`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error fetching preventivos alerts:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/preventivos/service', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  if (!scriptUrl) {
    return res.status(400).json({ error: "URL del script de preventivos no configurada." });
  }
  const { rowIndex, km, hs, interno, vehicleType } = req.body;
  try {
    const params = new URLSearchParams({
      accion: 'updateService',
      rowIndex,
      km: km || 0,
      hs: hs || 0,
      interno: interno || '',
      vehicleType: vehicleType || ''
    });
    const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error updating preventivos service:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/preventivos/odometer', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  if (!scriptUrl) {
    return res.status(400).json({ error: "URL del script de preventivos no configurada." });
  }
  const { rowIndex, km, hs, interno, vehicleType } = req.body;
  try {
    const params = new URLSearchParams({
      accion: 'updateOdometer',
      rowIndex,
      km: km || 0,
      hs: hs || 0,
      interno: interno || '',
      vehicleType: vehicleType || ''
    });
    const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    const data = await response.json();

    // Always update the local override with the new value so it shows immediately
    // (bypasses Apps Script cache which can take up to 6 hours to reflect changes)
    if (interno) {
      db.setOdometerOverride(interno, km || undefined, hs || undefined);
      console.log(`[OdometerOverride] Updated override for interno ${interno}: km=${km}, hs=${hs}`);
    }

    res.json(data);
  } catch (error) {
    console.error("Error updating preventivos odometer:", error);
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/preventivos/fuel-service', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  if (!scriptUrl) {
    return res.status(400).json({ error: "URL del script de preventivos no configurada." });
  }
  const { rowIndex, litros5k, litros10k, interno } = req.body;
  try {
    const params = new URLSearchParams({
      accion: 'updateFuelService',
      rowIndex,
      litros5k: litros5k !== undefined && litros5k !== null ? litros5k : '',
      litros10k: litros10k !== undefined && litros10k !== null ? litros10k : '',
      interno: interno || ''
    });
    const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error updating preventivos fuel service:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/preventivos/process-fuel', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  if (!scriptUrl) {
    return res.status(400).json({ error: "URL del script de preventivos no configurada." });
  }
  try {
    const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}accion=processSpreadsheetFuelLoads`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    const text = await response.text();
    try {
      res.json(JSON.parse(text));
    } catch(e) {
      res.json({ ok: true, result: text });
    }
  } catch (error) {
    console.error("Error processing fuel loads:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- Insumos retirados (warehouse withdrawals) pending supervisor approval ---
// Minimal quoted-CSV parser (handles commas inside quoted fields like "Rocha, Ariel").
function parseCsvRows(csvText) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i++) {
    const c = csvText[i];
    if (inQuotes) {
      if (c === '"') {
        if (csvText[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // skip
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchInsumosRowsFromSheet() {
  const settings = db.getSettings();
  const csvUrl = settings.insumosSheetCsvUrl;
  if (!csvUrl) return [];

  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} leyendo la hoja de insumos`);
  const text = await res.text();
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];

  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = {
    idEgreso: header.indexOf('id egreso'),
    otTaxes: header.indexOf('o.t. taxes'),
    interno: header.indexOf('interno'),
    material: header.indexOf('material'),
    cantidad: header.indexOf('cantidad'),
    operario: header.indexOf('operario')
  };

  return rows.slice(1)
    .filter(r => idx.idEgreso >= 0 && r[idx.idEgreso] && r[idx.idEgreso].trim())
    .map(r => ({
      idEgreso: (r[idx.idEgreso] || '').trim(),
      otTaxes: (r[idx.otTaxes] || '').trim(),
      interno: (r[idx.interno] || '').trim(),
      material: (r[idx.material] || '').trim(),
      cantidad: (r[idx.cantidad] || '').trim(),
      operario: (r[idx.operario] || '').trim()
    }));
}

// Pulls fresh rows from the warehouse sheet, tracks any new ones locally, and returns
// only the pending items for the CURRENT turno (a supervisor only approves what
// happened during their own shift).
app.get('/api/insumos/pendientes', async (req, res) => {
  try {
    const rows = await fetchInsumosRowsFromSheet();
    db.upsertInsumosFromRows(rows);
    const turnoActual = db.getTurnoForDate(new Date());
    const pendientes = db.getInsumosPendientes().filter(i => i.estado === 'pendiente' && i.turno === turnoActual);
    res.json({ turno: turnoActual, items: pendientes });
  } catch (error) {
    console.error("[GET /api/insumos/pendientes] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/insumos/:idEgreso/resolve', (req, res) => {
  try {
    const { estado } = req.body;
    if (estado !== 'aprobado' && estado !== 'rechazado') {
      return res.status(400).json({ error: "El campo 'estado' debe ser 'aprobado' o 'rechazado'." });
    }
    const aprobadoPor = req.headers['x-user-username'] || null;
    const updated = db.resolveInsumoPendiente(req.params.idEgreso, estado, aprobadoPor);
    if (!updated) {
      return res.status(404).json({ error: "Insumo no encontrado." });
    }
    // NOTE: pushing the approve/reject result to Taxes is intentionally not implemented
    // yet - to be added later, depending on which button was pressed.
    res.json({ success: true, item: updated });
  } catch (error) {
    console.error("[POST /api/insumos/:idEgreso/resolve] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Parte Taller: business logic, ported from the old Google Apps Script ──
// (kept local now — see database.js's getParteTallerState/saveParteTallerState
// for why: the Sheets-backed PropertiesService store had no real transaction
// safety and repeatedly lost data under concurrent writes).

// Manual correction for internos whose "equipo" is just wrong in the Taxes catalog itself
// (e.g. interno 153 is a real Compactador but Taxes has it catalogued as "CAMION"). The real
// fix is correcting it in Taxes directly - add here only as a stopgap for a specific interno
// someone's already flagged, not as a permanent home for every miscategorized unit.
const INTERNO_TIPO_OVERRIDES = {
  '153': 'COMPACTADOR',
  '50': 'ROLL - OFF'
};

function resolveTipoFlotaFromEquipo(equipoRaw) {
  const equipo = String(equipoRaw || '').trim().toUpperCase();
  if (equipo.startsWith('COMPACTADOR')) return 'COMPACTADOR';
  if (equipo.startsWith('VOLQUETE')) return 'VOLQUETE';
  if (equipo.startsWith('ROLL OFF') || equipo.startsWith('ROLL - OFF') || equipo.includes('ROLL')) return 'ROLL - OFF';
  // Real planchas are catalogued as "CHASIS CON PLANCHA", not "PLANCHA ..." - startsWith missed
  // every single one of them (they all fell through to the generic COMPACTADOR default instead).
  if (equipo.includes('PLANCHA')) return 'PLANCHA';
  return null;
}

// These are internal work buckets / external-company placeholders, not real
// units of this fleet — a "novedad" can legitimately be logged against them,
// but they must never be counted as a COMPACTADOR/VOLQUETE/etc for fleet
// totals (that inflated Compactador's Fuera de Servicio count by 2 and made
// the total look like 64 instead of the real 62).
const INTERNOS_NO_FLOTA = new Set(['IRINEO GRAL.', 'VOLQUETE NICO', 'REPARACIONES INTERNAS']);

function esInternoDeFlotaReal(interno) {
  return !INTERNOS_NO_FLOTA.has(String(interno || '').trim().toUpperCase());
}

function resolveTipoFromInterno(interno) {
  if (!esInternoDeFlotaReal(interno)) return null;
  const cleanInterno = String(interno).trim();
  if (INTERNO_TIPO_OVERRIDES[cleanInterno]) return INTERNO_TIPO_OVERRIDES[cleanInterno];
  const rodados = (db.getCatalogs() || {}).rodados || [];
  const found = rodados.find(r => String(r.interno || '').trim() === cleanInterno);
  return resolveTipoFlotaFromEquipo(found ? found.equipo : null) || 'COMPACTADOR';
}

// The Taxes catalog scrape that feeds db.getCatalogs().rodados is unreliable
// as a source for fleet TOTALS (unrelated to Parte Taller): it fails/times
// out periodically, and even when it succeeds it still lists trucks that
// were sold and never removed. So a fresh count from it can be wrong in
// either direction — never trust it over a value a human already confirmed.
// Once a type has a cached total (from an earlier successful read, or from
// a manual seed via /api/parte-taller/recalcular-totales), it's sticky:
// only ever fills in types that have NEVER been set, never overwrites an
// existing value automatically.
function calcularTotalesFlota() {
  const rodados = (db.getCatalogs() || {}).rodados || [];
  const totalesFrescos = { COMPACTADOR: 0, VOLQUETE: 0, 'ROLL - OFF': 0, PLANCHA: 0 };
  rodados.forEach(r => {
    const equipoUpper = String(r.equipo || '').trim().toUpperCase();
    if (equipoUpper === 'HERRERIA' || equipoUpper === 'EDILICIO') return;
    const cleanInterno = String(r.interno || '').trim();
    const tipo = INTERNO_TIPO_OVERRIDES[cleanInterno] || resolveTipoFlotaFromEquipo(r.equipo);
    if (tipo) totalesFrescos[tipo] = (totalesFrescos[tipo] || 0) + 1;
  });

  const dbData = db.read();
  const cache = { ...(dbData.fleetTotalsCache || {}) };
  let cambio = false;
  Object.keys(totalesFrescos).forEach(tipo => {
    if (cache[tipo] === undefined && totalesFrescos[tipo] > 0) {
      cache[tipo] = totalesFrescos[tipo];
      cambio = true;
    }
  });
  if (cambio) {
    dbData.fleetTotalsCache = cache;
    db.write(dbData);
  }

  return { COMPACTADOR: 0, VOLQUETE: 0, 'ROLL - OFF': 0, PLANCHA: 0, ...cache };
}

function marcarItemComoCompletado(novedad, motivoBuscado) {
  if (!novedad) return '';
  let ticketId = null;
  const matchTicket = motivoBuscado.match(/ticket\s*#?\s*(\d+)/i) || motivoBuscado.match(/#\s*(\d+)/i);
  if (matchTicket) ticketId = matchTicket[1];

  const lines = novedad.split('\n');
  let matched = false;
  const newLines = lines.map(line => {
    const lineUpper = line.toUpperCase();
    if (ticketId && (lineUpper.includes('TICKET') && lineUpper.includes('#' + ticketId) || lineUpper.includes('#' + ticketId))) {
      if (line.startsWith('[ ]')) { matched = true; return '[X]' + line.substring(3); }
      if (!line.startsWith('[X]') && !line.startsWith('[x]')) { matched = true; return '[X] ' + line; }
    }
    if (!ticketId) {
      const cleanMotivo = motivoBuscado.replace(/\[.*?\]/g, '').replace(/(operativo|listo|ok|cerrado|reparado)/gi, '').trim().toUpperCase();
      if (cleanMotivo && cleanMotivo.length > 3 && lineUpper.includes(cleanMotivo)) {
        if (line.startsWith('[ ]')) { matched = true; return '[X]' + line.substring(3); }
        if (!line.startsWith('[X]') && !line.startsWith('[x]')) { matched = true; return '[X] ' + line; }
      }
    }
    return line;
  });
  if (!matched) {
    for (let i = newLines.length - 1; i >= 0; i--) {
      if (newLines[i].startsWith('[ ]')) { newLines[i] = '[X]' + newLines[i].substring(3); matched = true; break; }
    }
  }
  return newLines.join('\n');
}

function recalcularTotalesResumenLocal(state) {
  const totalesDB = calcularTotalesFlota();
  const totales = {};
  ['COMPACTADOR', 'VOLQUETE', 'ROLL - OFF', 'PLANCHA'].forEach(tipo => {
    totales[tipo] = { operativos: totalesDB[tipo] || 0, fuera: 0, total: totalesDB[tipo] || 0 };
  });
  ['reparacion', 'fuera_de_servicio', 'inversiones'].forEach(listName => {
    (state[listName] || []).forEach(u => {
      if (!esInternoDeFlotaReal(u.interno)) return;
      const t = String(u.tipo || '').trim().toUpperCase();
      let tipoNorm = null;
      if (t.includes('COMPAC')) tipoNorm = 'COMPACTADOR';
      else if (t.includes('VOLQ')) tipoNorm = 'VOLQUETE';
      else if (t.includes('ROLL') || t.includes('OFF')) tipoNorm = 'ROLL - OFF';
      else if (t.includes('PLANCHA')) tipoNorm = 'PLANCHA';
      if (tipoNorm && totales[tipoNorm]) {
        totales[tipoNorm].fuera++;
        if (totales[tipoNorm].operativos > 0) totales[tipoNorm].operativos--;
      }
    });
  });
  state.resumen = state.resumen || {};
  state.resumen.totales = totales;
  const now = new Date();
  state.resumen.fecha = now.toLocaleDateString('es-AR');
  state.resumen.hora = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

// Adds/moves one unit's novedad across the Parte Taller lists. Mirrors the old
// Apps Script actualizarEstadoFlotaParte() 1:1, just backed by db.json instead
// of PropertiesService.
function actualizarEstadoFlotaLocal(internoRaw, estadoRaw, motivoRaw, responsableRaw, sectorRaw, destinoIngresoRaw) {
  const interno = String(internoRaw).trim();
  const estado = String(estadoRaw).trim().toLowerCase();
  const motivo = String(motivoRaw || '').trim();
  const responsable = String(responsableRaw || '').trim();
  // Was never actually persisted on the unit before — every unit ended up with no sector
  // tag at all, so matchesPtSector's "legacy data, show to everyone" fallback made every
  // Herrería-only item leak into the Taller board (and vice versa).
  const sector = String(sectorRaw || 'taller').trim().toLowerCase() === 'herreria' ? 'herreria' : 'taller';

  const state = db.getParteTallerState();
  state.resumen = state.resumen || {};
  if (responsable) state.resumen.responsable = responsable;

  const lists = ['servicios_pendientes', 'reparacion', 'fuera_de_servicio', 'inversiones', 'transito'];
  let existingNovedad = '';
  let existingSector = null;
  let currentList = '';
  lists.forEach(listName => {
    const found = (state[listName] || []).find(u => String(u.interno).trim() === interno);
    if (found) { currentList = listName; if (found.novedad) existingNovedad = found.novedad; if (found.sector) existingSector = found.sector; }
  });
  lists.forEach(listName => {
    state[listName] = (state[listName] || []).filter(u => String(u.interno).trim() !== interno);
  });

  const tipo = resolveTipoFromInterno(interno);
  const fechaStr = new Date().toLocaleDateString('es-AR');
  // Sticks to whichever sector originally logged this unit, so a Taller user closing out a
  // Herrería-created item doesn't accidentally re-tag it as Taller's own.
  const finalSector = existingSector || sector;

  function appendMotivo(existing, nuevoMotivo) {
    let cleanMotivo = nuevoMotivo.trim();
    if (!cleanMotivo.startsWith('[ ]') && !cleanMotivo.startsWith('[X]') && !cleanMotivo.startsWith('[x]')) {
      cleanMotivo = '[ ] ' + cleanMotivo;
    }
    return existing ? (existing.trim() + '\n' + cleanMotivo) : cleanMotivo;
  }

  if (estado === 'reparacion' || estado === 'fuera_de_servicio' || estado === 'fuera de servicio') {
    const targetList = estado === 'reparacion' ? 'reparacion' : 'fuera_de_servicio';
    const newNovedad = appendMotivo(existingNovedad, motivo);
    state[targetList].push({ interno, tipo, novedad: newNovedad, dia_parado: fechaStr, dias_en_reparacion: 0, sector: finalSector });
  } else if (estado === 'operativo') {
    let newNovedad;
    if (existingNovedad) {
      newNovedad = marcarItemComoCompletado(existingNovedad, motivo);
    } else {
      newNovedad = motivo;
      if (!newNovedad.startsWith('[ ]') && !newNovedad.startsWith('[X]') && !newNovedad.startsWith('[x]')) newNovedad = '[X] ' + newNovedad;
      else if (newNovedad.startsWith('[ ]')) newNovedad = '[X]' + newNovedad.substring(3);
    }
    state.servicios_pendientes.push({ interno, tipo, novedad: newNovedad, servicio: '', sector: finalSector });
  } else if (estado === 'servicios_pendientes' || estado === 'servicios pendientes') {
    const targetList = (currentList === 'reparacion' || currentList === 'fuera_de_servicio') ? currentList : 'servicios_pendientes';
    const newNovedad = appendMotivo(existingNovedad, motivo);
    if (targetList === 'reparacion' || targetList === 'fuera_de_servicio') {
      state[targetList].push({ interno, tipo, novedad: newNovedad, dia_parado: fechaStr, dias_en_reparacion: 0, sector: finalSector });
    } else {
      state.servicios_pendientes.push({ interno, tipo, novedad: newNovedad, servicio: '', sector: finalSector });
    }
  } else if (estado === 'inversiones' || estado === 'en_preparacion') {
    const newNovedad = appendMotivo(existingNovedad, motivo);
    state.inversiones.push({ interno, tipo, novedad: newNovedad, dia_parado: fechaStr, dias_en_reparacion: 0, sector: finalSector });
  } else if (estado === 'transito') {
    // Was missing entirely: the unit got cleared from every list above (the same step every
    // other estado goes through) but nothing ever put it back anywhere, since no branch here
    // matched 'transito' - it just vanished on save instead of showing up in En Tránsito.
    const newNovedad = appendMotivo(existingNovedad, motivo);
    const destinoIngreso = String(destinoIngresoRaw || 'fuera_de_servicio').trim().toLowerCase();
    if (!state.transito) state.transito = [];
    state.transito.push({
      interno, tipo, novedad: newNovedad,
      novedad_items: newNovedad.split('\n').map(line => {
        const hecho = line.startsWith('[X]') || line.startsWith('[x]');
        const texto = line.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim();
        return { texto, hecho };
      }).filter(x => x.texto),
      destinoIngreso,
      fecha_en_ruta: fechaStr,
      dia_parado: fechaStr,
      sector: finalSector
    });
  }

  recalcularTotalesResumenLocal(state);
  db.saveParteTallerState(state);
  return `Unidad #${interno} actualizada a ${estado.toUpperCase()} en Parte del Taller`;
}

// Maintenance: force-recompute resumen.totales using the cache-protected
// calcularTotalesFlota() (never zeroes out a type on a bad catalog read), or
// manually seed the cache when the Taxes catalog itself is known-bad for a
// stretch (pass {seed: {COMPACTADOR: N, ...}} to set trusted starting values).
app.post('/api/parte-taller/recalcular-totales', (req, res) => {
  try {
    if (req.body && req.body.seed) {
      const dbData = db.read();
      dbData.fleetTotalsCache = { ...(dbData.fleetTotalsCache || {}), ...req.body.seed };
      db.write(dbData);
    }
    const state = db.getParteTallerState();
    recalcularTotalesResumenLocal(state);
    db.saveParteTallerState(state);
    res.json({ ok: true, totales: state.resumen.totales });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/parte-taller/estado', (req, res) => {
  res.json({ ok: true, state: db.getParteTallerState() });
});

app.post('/api/parte-taller/novedad', (req, res) => {
  try {
    const payload = { ...req.body };
    const accion = payload.accion || 'actualizar_estado_flota';

    if (accion === 'save_state') {
      const saved = db.saveParteTallerState(payload.state || {});
      return res.json({ ok: true, state: saved });
    }

    if (accion === 'actualizar_responsable') {
      const state = db.getParteTallerState();
      state.resumen = state.resumen || {};
      state.resumen.responsable = payload.responsable || state.resumen.responsable;
      state.resumen.fecha = new Date().toLocaleDateString('es-AR');
      state.resumen.hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      db.saveParteTallerState(state);
      return res.json({ ok: true, msg: `Responsable actualizado a ${payload.responsable}` });
    }

    // Default / accion === 'actualizar_estado_flota'
    if (!payload.motivo && (payload.novedad || payload.observacion || payload.text)) {
      payload.motivo = payload.novedad || payload.observacion || payload.text;
    }
    if (!payload.estado && (payload.status || payload.state)) {
      payload.estado = payload.status || payload.state;
    }
    if (!payload.estado) payload.estado = 'fuera_de_servicio';

    const msg = actualizarEstadoFlotaLocal(payload.interno, payload.estado, payload.motivo, payload.responsable, payload.sector, payload.destinoIngreso);
    res.json({ ok: true, msg });
  } catch (error) {
    console.error('[Parte Taller] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Renders a self-contained HTML report (built client-side from the currently-displayed Parte
// Taller state) into a PDF via a short-lived headless Chromium instance - kept separate from
// syncWorker's browser, which stays busy doing real Taxes logins and shouldn't be touched here.
app.post('/api/parte-taller/generar-pdf', async (req, res) => {
  const { html } = req.body || {};
  if (!html) {
    return res.status(400).json({ error: "Falta el HTML del reporte." });
  }

  let browser = null;
  try {
    let execPath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
    if (!execPath) {
      if (process.platform === 'win32') {
        const stdPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        const x86Path = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
        if (fs.existsSync(stdPath)) execPath = stdPath;
        else if (fs.existsSync(x86Path)) execPath = x86Path;
      } else {
        const linuxPaths = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
        execPath = linuxPaths.find(p => fs.existsSync(p)) || null;
      }
    }

    browser = await puppeteer.launch({
      executablePath: execPath || undefined,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true,
      margin: { top: '15px', bottom: '15px', left: '15px', right: '15px' }
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="Parte_Taller_${new Date().toISOString().split('T')[0]}.pdf"`
    });
    res.send(pdfBuffer);
  } catch (error) {
    console.error("[POST /api/parte-taller/generar-pdf] Error:", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// --- WHATSAPP BOT WEBHOOK ENDPOINT ---
app.get(['/api/webhook/whatsapp', '/api/whatsapp'], (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token) {
    return res.status(200).send(challenge);
  }
  res.send("WhatsApp Webhook OK");
});

app.post(['/api/webhook/whatsapp', '/api/whatsapp'], async (req, res) => {
  try {
    const settings = db.getSettings();
    const scriptUrl = settings.parteTallerScriptUrl;
    
    // Extract message text from any WhatsApp provider format (Meta, Twilio, Evolution, Baileys, Custom)
    let messageText = '';
    const body = req.body || {};
    
    if (typeof body === 'string') {
      messageText = body;
    } else if (body.message) {
      messageText = typeof body.message === 'string' ? body.message : (body.message.conversation || body.message.text || '');
    } else if (body.text) {
      messageText = typeof body.text === 'string' ? body.text : (body.text.body || '');
    } else if (body.body) {
      messageText = body.body;
    } else if (body.entry && body.entry[0]?.changes[0]?.value?.messages[0]?.text?.body) {
      messageText = body.entry[0].changes[0].value.messages[0].text.body;
    } else if (body.novedad || body.observacion || body.motivo) {
      messageText = body.novedad || body.observacion || body.motivo;
    }

    const lower = (messageText || '').toLowerCase();
    const matchUnit = messageText.match(/(?:interno|unidad|camion|camión|nro|nº)?\s*#?(\d{1,4})\b/i);
    const targetInterno = matchUnit ? matchUnit[1] : (body.interno || body.unit || '');

    if (!targetInterno) {
      return res.status(400).json({ error: "No se pudo identificar el número de interno en el mensaje de WhatsApp." });
    }

    let nuevoEstado = 'fuera_de_servicio';
    if (lower.includes('operativo') || lower.includes('alta') || lower.includes('listo')) {
      nuevoEstado = 'operativo';
    } else if (lower.includes('servicio pendiente') || lower.includes('servicios pendientes') || lower.includes('pendiente')) {
      nuevoEstado = 'servicios_pendientes';
    } else if (lower.includes('reparacion') || lower.includes('reparación') || lower.includes('taller')) {
      nuevoEstado = 'reparacion';
    } else if (lower.includes('fuera de servicio') || lower.includes('parado') || lower.includes('rotura')) {
      nuevoEstado = 'fuera_de_servicio';
    }

    let noveltyText = messageText
      .replace(/(?:marcar|unidad|interno|camion|camión|nro|nº)?\s*#?\d{1,4}/gi, '')
      .replace(/fuera de servicio|servicios pendientes|servicio pendiente|reparaciones|reparación|reparacion|novedad|parado|en taller|marcar como|esta en|está en|pendiente/gi, '')
      .trim();
    if (!noveltyText || noveltyText.length < 2) {
      noveltyText = messageText.trim();
    }

    const senderPhone = body.from || body.phone || body.sender || 'WhatsApp Bot';

    if (scriptUrl) {
      const ptResp = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accion: 'actualizar_estado_flota',
          interno: targetInterno,
          estado: nuevoEstado,
          motivo: noveltyText,
          responsable: `WhatsApp (${senderPhone})`,
          sector: 'taller'
        })
      });
      if (!ptResp.ok) {
        console.warn('[WhatsApp Webhook] Script response not OK:', ptResp.status);
      }
    }

    res.json({
      success: true,
      msg: `Novedad procesada para interno #${targetInterno}`,
      interno: targetInterno,
      estado: nuevoEstado,
      novedad: noveltyText
    });
  } catch (error) {
    console.error("Error processing WhatsApp webhook:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- GOOGLE SHEETS NOVELTIES INTEGRATION ---
let noveltiesCache = null;
let noveltiesCacheTime = 0;

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  const result = [];
  
  if (lines.length === 0) return result;
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const row = [];
    let inQuotes = false;
    let currentToken = '';
    
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        row.push(currentToken.trim());
        currentToken = '';
      } else {
        currentToken += char;
      }
    }
    row.push(currentToken.trim());
    
    if (row.length > 0) {
      result.push({
        interno: row[0] || "",
        rubro: row[1] || "",
        subrubro: row[2] || "",
        observacion: row[3] || "",
        mecanico: row[4] || "",
        supervisor: row[5] || ""
      });
    }
  }
  return result;
}

function fetchNoveltiesFromSheet(url) {
  if (!url) {
    url = 'https://docs.google.com/spreadsheets/d/1UdieUhcgaCDNUTk7toUGObKSySbXn1ZGS6IOio1A2lM/export?format=csv';
  }
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchNoveltiesFromSheet(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch sheet: Status code ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = parseCSV(data);
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

app.get('/api/novelties', async (req, res) => {
  const now = Date.now();
  // Cache for 5 minutes
  if (noveltiesCache && (now - noveltiesCacheTime < 5 * 60 * 1000)) {
    return res.json(noveltiesCache);
  }

  try {
    const novelties = await fetchNoveltiesFromSheet();
    noveltiesCache = novelties;
    noveltiesCacheTime = now;
    res.json(novelties);
  } catch (error) {
    console.error("Error fetching novelties from sheet:", error);
    if (noveltiesCache) {
      return res.json(noveltiesCache);
    }
    res.status(500).json({ error: "No se pudieron obtener las novedades del camión: " + error.message });
  }
});

const HISTORICAL_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxbCEe6CPyN02seTWd0VO6mYljxX5N27oT2I5QJS-ZtRn7_PTm-oxI54p5rN6RCU8anVA/exec";

async function sendHistoricalOrderToGoogleSheet(order, step) {
  if (!order) return;
  try {
    const catalogs = db.getCatalogs();
    const task = (order.tasks && order.tasks[0]) ? order.tasks[0] : {};
    
    // Resolve employee name from catalog ID or label
    const mechanicObj = (catalogs.empleados || []).find(e => String(e.value) === String(task.empleado) || e.label === task.empleado);
    const mechanicName = mechanicObj ? mechanicObj.label : (task.empleado || "");

    // Resolve Centro de Costo name from catalog ID or label
    const ccVal = String(order.centroCosto || task.centroCosto || "15");
    const ccObj = (catalogs.centrosCosto || []).find(c => String(c.value) === ccVal || c.label === ccVal);
    const ccName = ccObj ? ccObj.label : (order.clasificacion || "MECANICA");

    const nowStr = new Date().toLocaleTimeString("es-AR", { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });

    let payload = {};
    if (step === 'crear') {
      payload = {
        accion: 'crear',
        fecha: order.fechaEntrega || new Date().toLocaleDateString("es-AR"),
        interno: String(order.interno || "—"),
        ot: order.taxesOrderNumber || order.taxesOtId || "Procesando...",
        centro_costo: ccName,
        categoria: order.clasificacion || order.tipoUnidad || "MECANICA",
        empleado: mechanicName || "—",
        horas: String(task.horasEstimadas || "0.01"),
        descripcion: task.descripcion || order.incidente || "—",
        status: order.syncStatus === 'success' ? 'Finalizada' : 'Pendiente',
        hora_inicio: nowStr,
        estado_sincro: (order.taxesOrderNumber || order.taxesOtId) ? 'OK Sincronizada' : 'Procesando...'
      };
    } else { // 'confirmar' / 'actualizar'
      payload = {
        accion: 'confirmar_ot',
        interno: String(order.interno || "—"),
        ot_numero: String(order.taxesOrderNumber || order.taxesOtId || "—"),
        status: 'Finalizada',
        hora_fin: nowStr,
        estado_sincro: 'OK Sincronizada'
      };
    }

    console.log(`[HistoricalSheet] Sending step "${step}" for OT/Interno "${order.interno}"...`);
    fetch(HISTORICAL_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(res => res.text()).then(txt => {
      console.log(`[HistoricalSheet] Step "${step}" Response:`, txt);
    }).catch(err => {
      console.error(`[HistoricalSheet] Step "${step}" Error:`, err.message);
    });
  } catch (err) {
    console.error("Error in sendHistoricalOrderToGoogleSheet:", err);
  }
}

async function checkAndTriggerGoogleSheetUpdates(existingOrder, updatedTasks, supervisor, orderInterno) {
  const settings = db.getSettings();
  const scriptUrl = settings.googleScriptUrl || settings.googleActiveTasksUrl || "https://script.google.com/macros/s/AKfycbxBIPF6-uoK2aFNfRCxDUS5AAFxLeToB7iMz3rdf_J4JjJBvsNbOv7aIdXBBnoxRZiC/exec";
  if (!scriptUrl) {
    console.log("checkAndTriggerGoogleSheetUpdates: googleScriptUrl is not configured.");
    return;
  }

  // Find newly finalized tasks
  const newlyFinalized = (updatedTasks || []).filter(t => {
    if (t.status !== "Finalizada") return false;
    if (!existingOrder) return true; // It's a new order
    const oldTask = (existingOrder.tasks || []).find(ot => ot.id === t.id);
    return !oldTask || oldTask.status !== "Finalizada";
  });

  if (newlyFinalized.length === 0) return;

  try {
    const novelties = await fetchNoveltiesFromSheet().catch(e => {
      console.error("checkAndTriggerGoogleSheetUpdates: failed to fetch sheet:", e.message);
      return [];
    });
    if (novelties.length === 0) return;

    const catalogs = db.getCatalogs();

    for (const task of newlyFinalized) {
      const taskDesc = (task.descripcion || '').toLowerCase().trim();
      const taskInterno = String(orderInterno || (existingOrder ? existingOrder.interno : '')).toLowerCase().trim();

      const matchedNovelty = novelties.find(n => {
        if (String(n.interno || '').toLowerCase().trim() !== taskInterno) return false;
        const nDesc = [n.rubro, n.subrubro, n.observacion].filter(Boolean).join(' - ').toLowerCase().trim();
        return nDesc === taskDesc;
      });

      if (matchedNovelty) {
        console.log(`[Google Sheets] Matched task "${task.descripcion}" to novelty on sheet. Triggering update...`);
        
        // Resolve mechanic name from catalog ID
        const mechanicObj = (catalogs.empleados || []).find(e => String(e.value) === String(task.empleado));
        const mechanicName = mechanicObj ? mechanicObj.label : (task.empleado || "");

        // Resolve supervisor name from catalog ID or AUTO
        let supervisorName = "";
        const selectedSupervisor = supervisor || (existingOrder ? existingOrder.responsable : '');
        if (selectedSupervisor && selectedSupervisor !== "AUTO") {
          const supervisorObj = (catalogs.responsables || []).find(r => String(r.value) === String(selectedSupervisor));
          if (supervisorObj) supervisorName = supervisorObj.label;
        }
        
        // If still AUTO or empty, resolve from settings.username (email)
        if (!supervisorName || supervisorName === "AUTO") {
          const email = (settings.username || '').toLowerCase().trim();
          if (email) {
            // Map known emails to names
            if (email.includes("paniol") || email.includes("belocures") || email.includes("cesar")) {
              const matched = (catalogs.responsables || []).find(r => r.label.toLowerCase().includes("belocures") || r.label.toLowerCase().includes("cesar"));
              if (matched) supervisorName = matched.label;
            } else {
              // Try prefix match with part-based matching
              const prefix = email.split('@')[0];
              const parts = prefix.split(/[\._\-]/).filter(p => p.length >= 3);
              let matched = null;
              if (parts.length > 0) {
                matched = (catalogs.responsables || []).find(r => {
                  const lbl = r.label.toLowerCase();
                  return parts.some(part => lbl.includes(part));
                });
              }
              if (!matched && prefix.length > 2) {
                matched = (catalogs.responsables || []).find(r => r.label.toLowerCase().includes(prefix));
              }
              if (matched) supervisorName = matched.label;
            }
          }
          if (!supervisorName) {
            supervisorName = settings.username || "AUTO";
          }
        }

        const queryParams = new URLSearchParams({
          interno: matchedNovelty.interno,
          rubro: matchedNovelty.rubro,
          subrubro: matchedNovelty.subrubro,
          observacion: matchedNovelty.observacion,
          mecanico: mechanicName || "",
          supervisor: supervisorName || "AUTO"
        });

        const updateUrl = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}${queryParams.toString()}`;
        console.log(`[Google Sheets] Sending request to Apps Script URL: ${updateUrl}`);
        
        try {
          const res = await fetch(updateUrl);
          const text = await res.text();
          console.log(`[Google Sheets] Apps Script Response (Status ${res.status}):`, text);
        } catch (err) {
          console.error("[Google Sheets] Error calling Apps Script:", err.message);
        }
      }
    }
  } catch (error) {
    console.error("Error in checkAndTriggerGoogleSheetUpdates:", error);
  }
}

async function checkAndSendInsumosToSheet(existingOrder, updatedTasks, supervisor, orderInterno) {
  const settings = db.getSettings();
  const scriptUrl = settings.googleScriptUrl || settings.googleActiveTasksUrl || "https://script.google.com/macros/s/AKfycbxBIPF6-uoK2aFNfRCxDUS5AAFxLeToB7iMz3rdf_J4JjJBvsNbOv7aIdXBBnoxRZiC/exec";
  if (!scriptUrl) {
    console.log("checkAndSendInsumosToSheet: googleScriptUrl is not configured.");
    return;
  }

  try {
    const catalogs = db.getCatalogs();
    const tasks = updatedTasks || [];

    for (const task of tasks) {
      if (!task.insumos || !task.insumos.trim()) continue;

      if (!Array.isArray(task.sentInsumos)) {
        task.sentInsumos = [];
      }

      const parsedInsumos = parseInsumosString(task.insumos);
      const unsentInsumos = parsedInsumos.filter(item => !task.sentInsumos.includes(`${item.insumo}:${item.cantidad}`));

      if (unsentInsumos.length === 0) continue;

      // Resolve mechanic name
      const mechanicObj = (catalogs.empleados || []).find(e => String(e.value) === String(task.empleado));
      const mechanicName = mechanicObj ? mechanicObj.label : (task.empleado || "");

      // Resolve supervisor name
      let supervisorName = "";
      const selectedSupervisor = supervisor || (existingOrder ? existingOrder.responsable : '');
      if (selectedSupervisor && selectedSupervisor !== "AUTO") {
        const supervisorObj = (catalogs.responsables || []).find(r => String(r.value) === String(selectedSupervisor));
        if (supervisorObj) supervisorName = supervisorObj.label;
      }
      if (!supervisorName || supervisorName === "AUTO") {
        const email = (settings.username || '').toLowerCase().trim();
        if (email) {
          if (email.includes("paniol") || email.includes("belocures") || email.includes("cesar")) {
            const matched = (catalogs.responsables || []).find(r => r.label.toLowerCase().includes("belocures") || r.label.toLowerCase().includes("cesar"));
            if (matched) supervisorName = matched.label;
          } else {
            const prefix = email.split('@')[0];
            const parts = prefix.split(/[\._\-]/).filter(p => p.length >= 3);
            let matched = null;
            if (parts.length > 0) {
              matched = (catalogs.responsables || []).find(r => {
                const lbl = r.label.toLowerCase();
                return parts.some(part => lbl.includes(part));
              });
            }
            if (!matched && prefix.length > 2) {
              matched = (catalogs.responsables || []).find(r => r.label.toLowerCase().includes(prefix));
            }
            if (matched) supervisorName = matched.label;
          }
        }
        if (!supervisorName) {
          supervisorName = settings.username || "AUTO";
        }
      }

      const otNumber = (existingOrder && existingOrder.taxesOrderNumber) ? existingOrder.taxesOrderNumber : (existingOrder && existingOrder.id ? existingOrder.id : "Sin Sincronizar");
      const interno = orderInterno || (existingOrder ? existingOrder.interno : '');

      for (const item of unsentInsumos) {
        const queryParams = new URLSearchParams({
          action: 'addInsumo',
          interno: interno,
          numeroOrden: otNumber,
          insumo: item.insumo,
          cantidad: item.cantidad,
          empleado: mechanicName,
          supervisor: supervisorName
        });

        const updateUrl = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}${queryParams.toString()}`;
        console.log(`[Google Sheets Insumos] Sending request to Apps Script URL: ${updateUrl}`);

        try {
          const res = await fetch(updateUrl);
          const text = await res.text();
          console.log(`[Google Sheets Insumos] Apps Script Response (Status ${res.status}):`, text);
          task.sentInsumos.push(`${item.insumo}:${item.cantidad}`);
        } catch (err) {
          console.error("[Google Sheets Insumos] Error calling Apps Script:", err.message);
        }
      }
    }

    if (existingOrder && existingOrder.id) {
      // This function awaits a Google Sheets webhook per insumo (can take several seconds), so
      // `tasks` here can be stale by the time we get here. Merge only sentInsumos (by task id)
      // onto the CURRENT order instead of overwriting the whole tasks array wholesale — otherwise
      // any edit the user made to this order while these webhook calls were in flight (e.g. adding
      // diagnóstico/insumos) gets silently reverted.
      const freshOrder = db.getWorkOrderById(existingOrder.id);
      if (freshOrder && Array.isArray(freshOrder.tasks)) {
        const sentInsumosById = new Map(tasks.map(t => [t.id, t.sentInsumos]));
        const mergedTasks = freshOrder.tasks.map(freshTask => {
          const sentInsumos = sentInsumosById.get(freshTask.id);
          return sentInsumos ? { ...freshTask, sentInsumos } : freshTask;
        });
        db.updateWorkOrder(existingOrder.id, { tasks: mergedTasks });
      } else {
        db.updateWorkOrder(existingOrder.id, { tasks: tasks });
      }
    }
  } catch (error) {
    console.error("Error in checkAndSendInsumosToSheet:", error);
  }
}

function parseInsumosString(insumosStr) {
  if (!insumosStr || !insumosStr.trim()) return [];
  const parts = insumosStr.split('|');
  const results = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      const insumo = trimmed.substring(0, colonIdx).trim();
      const cantidad = trimmed.substring(colonIdx + 1).trim();
      results.push({ insumo, cantidad });
    } else {
      results.push({ insumo: trimmed, cantidad: "1" });
    }
  }
  return results;
}

async function triggerFuelServiceReset(order) {
  if (!order || !order.combustibleReset) return;
  const { tipo, rowIndex, litrosTotales } = order.combustibleReset;
  if (!tipo || !rowIndex || !litrosTotales) return;
  
  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  if (!scriptUrl) {
    console.error("triggerFuelServiceReset: URL de preventivo no configurada.");
    return;
  }
  
  try {
    const litros5k = tipo === '5k' ? litrosTotales : '';
    const litros10k = tipo === '10k' ? litrosTotales : '';
    
    const params = new URLSearchParams({
      accion: 'updateFuelService',
      rowIndex: String(rowIndex),
      interno: String(order.interno),
      litros5k: String(litros5k),
      litros10k: String(litros10k)
    });
    
    const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}${params.toString()}`;
    console.log(`[Combustible Reset] Resetting fuel service: ${url}`);
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Apps Script responded with status ${response.status}`);
    }
    const data = await response.json();
    console.log(`[Combustible Reset] Result:`, data);
  } catch (error) {
    console.error(`[Combustible Reset] Error resetting fuel service:`, error.message);
  }
}

async function triggerActiveTasksGoogleSheetSync() {
  const settings = db.getSettings();
  const scriptUrl = settings.googleActiveTasksUrl;
  if (!scriptUrl) {
    console.log("triggerActiveTasksGoogleSheetSync: googleActiveTasksUrl is not configured.");
    return;
  }

  try {
    const orders = db.getWorkOrders() || [];
    const catalogs = db.getCatalogs() || {};
    const activeTasks = [];

    orders.forEach(order => {
      const tasks = order.tasks || [];
      
      const hasActiveOrPausedTimer = tasks.some(t => t.timerStarted || t.timerStart || t.status === 'En Proceso');
      const isOutOfService = order.estadoUnidad === 'fuera_de_servicio';
      const estadoUnidadLabel = isOutOfService ? "Fuera de Servicio" : "Operativo";

      tasks.forEach(task => {
        if (task.status !== "Finalizada") {
          const mechanicObj = (catalogs.empleados || []).find(e => String(e.value) === String(task.empleado));
          const mechanicName = mechanicObj ? mechanicObj.label : (task.empleado || "");

          let taskStatus = task.status;
          if (task.timerStart !== null && task.timerStart > 0) {
            taskStatus = "En proceso";
          } else if (task.timerStarted === true || task.timerStarted === 'true' || (Array.isArray(task.timerHistory) && task.timerHistory.length > 0)) {
            taskStatus = "En pausa";
          } else {
            taskStatus = "Pendiente";
          }

          activeTasks.push({
            orderId: order.id,
            taxesOrderNumber: order.taxesOrderNumber || "Sin Sincronizar",
            interno: order.interno,
            rodado: order.rodado,
            clasificacion: order.clasificacion,
            mecanico: mechanicName,
            descripcion: task.descripcion || "(Sin descripción)",
            status: taskStatus,
            estadoUnidad: estadoUnidadLabel
          });
        }
      });
    });

    console.log(`[Google Sheets Active Tasks] Sending ${activeTasks.length} active tasks to Apps Script...`);

    const response = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'updateActiveTasks',
        tasks: activeTasks
      })
    });

    const text = await response.text();
    console.log(`[Google Sheets Active Tasks] Response (Status ${response.status}):`, text);
  } catch (error) {
    console.error("[Google Sheets Active Tasks] Sync failed:", error.message);
  }
}

// Fallback: serve frontend index.html for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Express Server and Background Worker (HTTP + HTTPS)
function getLocalIP() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

// Generate self-signed certificate with SANs required by Chrome/modern browsers
let httpsServer = null;
try {
  const localIP = getLocalIP();

  const attrs = [
    { name: 'commonName', value: localIP },
    { name: 'organizationName', value: 'Taller Taxes Local' }
  ];

  const pems = selfsigned.generate(attrs, {
    days: 365,
    algorithm: 'sha256',
    keySize: 2048,
    extensions: [
      {
        name: 'basicConstraints',
        cA: true
      },
      {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        dataEncipherment: true
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true
      },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 7, ip: localIP },       // IP de la red local
          { type: 7, ip: '127.0.0.1' },   // localhost IP
          { type: 2, value: 'localhost' }  // localhost hostname
        ]
      }
    ]
  });

  const tlsOptions = {
    key: pems.private,
    cert: pems.cert,
    minVersion: 'TLSv1.2'
  };

  httpsServer = https.createServer(tlsOptions, app);

  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`  Taller App - HTTP  : http://localhost:${PORT}`);
    console.log(`  Taller App - HTTPS : https://localhost:${HTTPS_PORT}`);
    console.log(`  Celular / Red local: https://${localIP}:${HTTPS_PORT}`);
    console.log(`======================================================`);
    console.log(`  En el celular (Chrome Android):`);
    console.log(`  1) Abri: https://${localIP}:${HTTPS_PORT}`);
    console.log(`  2) Toca "Avanzado" > "Continuar" (cert. autofirmado)`);
    console.log(`  3) El microfono del boton de voz funcionara`);
    console.log(`======================================================\n`);
  });
} catch (e) {
  console.error('[HTTPS] No se pudo iniciar HTTPS:', e.message);
  console.error(e.stack);
}

// HTTP server
http.createServer(app).listen(PORT, '0.0.0.0', async () => {
  const localIP = getLocalIP();
  console.log(`[HTTP] Escuchando en http://localhost:${PORT}`);
  console.log(`[HTTP] Red local:      http://${localIP}:${PORT}`);

  try {
    db.clearAllOdometerOverrides();
    console.log('[Preventivos] Sobrescrituras antiguas limpiadas para sincronizar directo con Google Sheets.');
  } catch (e) {}

  const isRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);

  // Start the Puppeteer sync worker regardless of where this process runs. Railway is fully
  // capable of running Puppeteer/Chromium itself (confirmed working via manual retry) — relying
  // solely on a separate Debian instance to run this loop left every order stuck in "Pendiente"
  // whenever that Debian instance wasn't also bridging data back to Railway via the sync agent.
  if (process.env.DISABLE_BACKGROUND_WORKER !== 'true') {
    try {
      worker.startWorker();
    } catch (wErr) {
      console.error('[Worker] Could not start Puppeteer worker:', wErr.message);
    }
  }

  // The Debian<->Railway bidirectional sync agent only makes sense on the Debian instance
  // (it exists purely to mirror Debian's local DB with Railway's) — never start it on Railway.
  if (!isRailway) {
    if (process.env.DISABLE_RAILWAY_SYNC_AGENT !== 'true') {
      try {
        const agent = require('./railway_sync_agent');
        agent.startAgent();
        console.log('[RailwayAgent] Agent started for bidirectional sync between Debian & Railway.');
      } catch (agentErr) {
        console.error('[RailwayAgent] Could not start Railway sync agent:', agentErr.message);
      }
    } else {
      console.log('[RailwayAgent] Disabled via DISABLE_RAILWAY_SYNC_AGENT=true.');
    }
  } else {
    console.log('[RailwayAgent] Not applicable on Railway cloud instance (agent only bridges Debian -> Railway).');
  }


  // Auto-clean duplicate tasks in active orders on startup
  try {
    db.cleanDuplicateTasksInActiveOrders();
  } catch (cleanErr) {
    console.warn('[Startup] Task auto-clean error:', cleanErr.message);
  }

  // Start localtunnel for HTTPS access from mobile (no cert issues)
  if (localtunnel) {
    try {
      console.log('[Tunnel] Iniciando tunel HTTPS publico...');
      const tunnel = await localtunnel({ port: PORT });
      console.log(`\n${'='.repeat(56)}`);
      console.log(`  *** URL PARA EL CELULAR (HTTPS real) ***`);
      console.log(`  ${tunnel.url}`);
      console.log(`  Abrila en Chrome del celular - sin errores SSL`);
      console.log(`${'='.repeat(56)}\n`);

      tunnel.on('close', () => {
        console.log('[Tunnel] Tunel cerrado.');
      });
      tunnel.on('error', (err) => {
        console.error('[Tunnel] Error en tunel:', err.message);
      });
    } catch (tunnelErr) {
      console.error('[Tunnel] No se pudo crear el tunel:', tunnelErr.message);
      console.log(`  => Usa la IP local: http://${localIP}:${PORT}`);
    }
  }
});

// Endpoint to trigger manual cleaning of duplicate tasks
app.post('/api/orders/clean-duplicate-tasks', (req, res) => {
  try {
    db.cleanDuplicateTasksInActiveOrders();
    res.json({ success: true, message: 'Tareas duplicadas limpiadas exitosamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
