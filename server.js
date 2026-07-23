const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const selfsigned = require('selfsigned');
const db = require('./database');
const worker = require('./syncWorker');
let localtunnel = null;
try { localtunnel = require('localtunnel'); } catch(e) {}
const { exec } = require('child_process');
const fs = require('fs');

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
  // Ignore harmless EBUSY/ENOTEMPTY puppeteer temp profile cleanup errors on Windows
  if (err.code === 'EBUSY' || err.code === 'ENOTEMPTY' || (err.message && err.message.includes('puppeteer_dev_chrome_profile'))) {
    console.warn(`[Warning] Ignored Puppeteer cleanup error: ${err.message}`);
    return;
  }

  const errorLogPath = path.join(__dirname, 'last_error.log');
  const errorDetails = `Fecha: ${new Date().toISOString()}\nError: ${err.message}\nStack:\n${err.stack}\n`;
  try {
    fs.writeFileSync(errorLogPath, errorDetails);
  } catch (fsErr) {
    console.error("Failed to write error log:", fsErr);
  }
  console.error("❌ Servidor caído. Guardando log y activando Agentes IA...");

  const pyCmd = process.platform === 'win32' ? 'python auto_healer.py' : 'python3 auto_healer.py';
  exec(pyCmd, (pyErr, stdout, stderr) => {
    if (pyErr) {
      console.error("⚠️ Falló la ejecución de los agentes de autoreparación:", pyErr);
      process.exit(1);
    }
    console.log("✅ Agentes de Autoreparación ejecutados:", stdout);
    process.exit(0);
  });
});

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// Middleware
app.use(cors());
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
  const cleanUsername = String(username).split(',')[0].trim();
  const email = cleanUsername.toLowerCase().trim();
  
  if (
    email.includes('taller') || 
    email.includes('paniol') || 
    email.includes('panol') || 
    email.includes('pañol')
  ) {
    return 'Admin';
  }
  if (
    email.includes('jcarmona') || 
    email.includes('carmona')
  ) {
    return 'Herrería';
  }
  if (
    email.includes('ftoledo') || 
    email.includes('toledo')
  ) {
    return 'Edilicio';
  }
  return 'Taller';
}

// User Login (saves credentials locally for worker lookup)
app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Usuario y contraseña son requeridos." });
    }

    // Save this user's credentials in per-user store (used by syncWorkOrder per order)
    const user = db.saveUser(username, password);

    // Always trigger catalog sync for ANY supervisor who logs in, using THEIR OWN credentials.
    // Each supervisor (taller, paniol, sergio, brahim, jcarmona, ftoledo) has valid Taxes accounts.
    // We only update global settings if there is no primary user yet, or if this IS the primary user.
    const currentSettings = db.getSettings();
    const isSameUser = currentSettings.username && 
                       currentSettings.username.toLowerCase().trim() === username.toLowerCase().trim();
    const noGlobalUser = !currentSettings.username || !currentSettings.password;
    
    if (noGlobalUser || isSameUser) {
      db.saveSettings({ username, password, catalogSyncStatus: 'idle', catalogSyncError: null });
      console.log(`[Login] Global settings updated for ${username}.`);
    } else {
      // Secondary user logging in — clear stale errors but don't overwrite global settings
      if (currentSettings.catalogSyncError) {
        db.saveSettings({ catalogSyncStatus: 'idle', catalogSyncError: null });
      }
      console.log(`[Login] Secondary user ${username} logged in (global settings kept for ${currentSettings.username}).`);
    }

    // Trigger catalog sync in background using THIS user's own credentials regardless of role.
    // This ensures each supervisor can sync catalogs independently without depending on paniol.
    worker.scrapeCatalogs(username).then(result => {
      console.log(`[Login] Catalog sync for ${username}:`, result.message);
    }).catch(e => {
      console.error(`[Login] Catalog sync error for ${username}:`, e.message);
    });

    res.json({ success: true, username, sector: getSectorByUsername(username) });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    if (Array.isArray(dbData.workOrders)) {
      data.workOrders = dbData.workOrders;
    }
    if (dbData.users) {
      data.users = { ...data.users, ...dbData.users };
    }
    if (dbData.activeMechanics) {
      data.activeMechanics = dbData.activeMechanics;
    }
    db.write(data);
    
    console.log(`[DB Migration] Database uploaded successfully. Orders: ${dbData.workOrders ? dbData.workOrders.length : 0}, Rodados: ${dbData.catalogs && dbData.catalogs.rodados ? dbData.catalogs.rodados.length : 0}`);
    
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

// Get all work orders (filtered by user sector)
app.get('/api/orders', (req, res) => {
  try {
    const username = req.headers['x-user-username'] || null;
    const sector = getSectorByUsername(username);

    const orders = db.getWorkOrders();
    
    // Filter orders
    const filtered = orders.filter(o => {
      const cls = o.clasificacion;
      if (sector === 'Admin') return true;
      if (sector === 'Herrería') return cls === 'Herrería';
      if (sector === 'Edilicio') return cls === 'Edilicio';
      // Taller sees only Taller orders (neither Herrería nor Edilicio)
      return cls !== 'Herrería' && cls !== 'Edilicio';
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
    const { rodado, responsable, fechaEntrega, horario, interno, clasificacion, incidente, tasks, estadoUnidad, combustibleReset } = req.body;
    
    if (!rodado || !responsable || !clasificacion) {
      return res.status(400).json({ error: "Faltan campos obligatorios: rodado, responsable y clasificacion son requeridos." });
    }

    const createdBy = req.headers['x-user-username'] || null;
    const sector = getSectorByUsername(createdBy);

    // Validate/force classification by sector
    let finalClasificacion = clasificacion;
    if (sector === 'Herrería') {
      finalClasificacion = 'Herrería';
    } else if (sector === 'Edilicio') {
      finalClasificacion = 'Edilicio';
    } else if (sector === 'Taller') {
      if (clasificacion === 'Herrería' || clasificacion === 'Edilicio') {
        return res.status(400).json({ error: "Clasificación no permitida para el sector Taller." });
      }
    }

    const newOrder = db.createWorkOrder({
      rodado,
      responsable,
      fechaEntrega,
      horario,
      interno,
      clasificacion: finalClasificacion,
      incidente,
      tasks,
      createdBy,
      estadoUnidad: estadoUnidad || 'fuera_de_servicio',
      combustibleReset
    });

    // Trigger Google Sheets update asynchronously for any finalized tasks
    checkAndTriggerGoogleSheetUpdates(null, newOrder.tasks, responsable, interno);
    checkAndSendInsumosToSheet(null, newOrder.tasks, responsable, interno);

    // Trigger active tasks Google Sheets update
    triggerActiveTasksGoogleSheetSync();

    // Trigger fuel service reset if all tasks are completed
    const allTasksCompleted = (newOrder.tasks || []).length > 0 && (newOrder.tasks || []).every(t => t.status === "Finalizada");
    if (allTasksCompleted && newOrder.combustibleReset && !newOrder.combustibleReset.triggered) {
      newOrder.combustibleReset.triggered = true;
      db.updateWorkOrder(newOrder.id, { combustibleReset: newOrder.combustibleReset });
      triggerFuelServiceReset(newOrder);
    }

    res.status(201).json(newOrder);
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

    for (const orderData of orders) {
      const { rodado, responsable, fechaEntrega, horario, interno, clasificacion, incidente, tasks, estadoUnidad } = orderData;
      
      if (!rodado || !responsable || !clasificacion) {
        return res.status(400).json({ error: `Campos obligatorios faltantes en orden. Rodado, responsable y clasificacion son requeridos.` });
      }

      let finalClasificacion = clasificacion;
      if (sector === 'Herrería') {
        finalClasificacion = 'Herrería';
      } else if (sector === 'Edilicio') {
        finalClasificacion = 'Edilicio';
      } else if (sector === 'Taller') {
        if (clasificacion === 'Herrería' || clasificacion === 'Edilicio') {
          return res.status(400).json({ error: "Clasificación no permitida para el sector Taller." });
        }
      }

      const newOrder = db.createWorkOrder({
        rodado,
        responsable,
        fechaEntrega,
        horario,
        interno,
        clasificacion: finalClasificacion,
        incidente: incidente || '',
        tasks: tasks || [],
        createdBy,
        estadoUnidad: estadoUnidad || 'fuera_de_servicio'
      });

      checkAndTriggerGoogleSheetUpdates(null, newOrder.tasks, responsable, interno);
      createdOrders.push(newOrder);
    }

    // Trigger active tasks Google Sheets update once
    triggerActiveTasksGoogleSheetSync();

    res.status(201).json({ success: true, count: createdOrders.length, orders: createdOrders });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update a work order
app.put('/api/orders/:id', (req, res) => {
  try {
    const { rodado, responsable, fechaEntrega, horario, interno, clasificacion, incidente, tasks, estadoUnidad, combustibleReset } = req.body;
    
    const existing = db.getWorkOrderById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    const requester = req.headers['x-user-username'] || null;
    const sector = getSectorByUsername(requester);

    // Check sector permission
    const existingCls = existing.clasificacion;
    const isPaniol = sector === 'Admin' || (requester && (requester.toLowerCase().includes('paniol') || requester.toLowerCase().includes('panol') || requester.toLowerCase().includes('pañol')));
    if (!isPaniol) {
      if (sector === 'Herrería' && existingCls !== 'Herrería') {
        return res.status(403).json({ error: "No tiene permisos para modificar esta orden." });
      }
      if (sector === 'Edilicio' && existingCls !== 'Edilicio') {
        return res.status(403).json({ error: "No tiene permisos para modificar esta orden." });
      }
      if (sector === 'Taller' && (existingCls === 'Herrería' || existingCls === 'Edilicio')) {
        return res.status(403).json({ error: "No tiene permisos para modificar esta orden." });
      }
    }

    // Force sector classification
    let finalClasificacion = clasificacion;
    if (sector === 'Herrería') {
      finalClasificacion = 'Herrería';
    } else if (sector === 'Edilicio') {
      finalClasificacion = 'Edilicio';
    } else if (sector === 'Taller' && !isPaniol) {
      if (clasificacion === 'Herrería' || clasificacion === 'Edilicio') {
        return res.status(400).json({ error: "Clasificación no permitida para el sector Taller." });
      }
    }

    const createdBy = existing.createdBy || requester;
    const allTasksCompleted = (tasks || []).length > 0 && (tasks || []).every(t => t.status === "Finalizada");

    // SAFETY: if the incoming tasks array is empty but the order already has tasks,
    // preserve the existing tasks. This prevents accidental deletion of tasks
    // when a timer-only update sends a partial payload.
    const tasksToSave = (tasks && tasks.length > 0)
      ? tasks
      : (existing.tasks && existing.tasks.length > 0 ? existing.tasks : []);

    const updated = db.updateWorkOrder(req.params.id, {
      rodado,
      responsable,
      fechaEntrega,
      horario,
      interno,
      clasificacion: finalClasificacion,
      incidente,
      createdBy,
      syncStatus: "pending", // Force queue for sync on any update
      syncError: null,
      syncDate: null,
      estadoUnidad: estadoUnidad !== undefined ? estadoUnidad : existing.estadoUnidad,
      combustibleReset: combustibleReset !== undefined ? combustibleReset : existing.combustibleReset,
      tasks: tasksToSave.map((t, idx) => {
        const existingTask = existing.tasks ? existing.tasks.find(et => et.id === t.id) : null;
        let synced = existingTask ? (existingTask.synced === true) : false;
        let taxesRealizadaSynced = existingTask ? (existingTask.taxesRealizadaSynced === true) : false;
        
        // If status changed to Finalizada, reset the updated flag so we sync the update to Taxes
        if (t.status === "Finalizada" && (!existingTask || existingTask.status !== "Finalizada")) {
          taxesRealizadaSynced = false;
        }

        return {
          id: t.id || `${Date.now()}-${idx}`,
          centroCosto: t.centroCosto || "",
          empleado: t.empleado || "",
          horasEstimadas: parseFloat(String(t.horasEstimadas).replace(',', '.')) || 0,
          descripcion: t.descripcion || "",
          status: t.status || "Pendiente",
          insumos: t.insumos !== undefined ? t.insumos : (existingTask ? existingTask.insumos || "" : ""),
          timerStart: t.timerStart || null,
          timerStarted: t.timerStarted === true || t.timerStarted === 'true',
          timerHistory: Array.isArray(t.timerHistory) ? t.timerHistory : (existingTask ? existingTask.timerHistory || [] : []),
          synced: synced,
          taxesRealizadaSynced: taxesRealizadaSynced
        };
      })
    });

    // Trigger Google Sheets update asynchronously for any newly finalized tasks
    checkAndTriggerGoogleSheetUpdates(existing, updated.tasks, responsable, interno);
    checkAndSendInsumosToSheet(existing, updated.tasks, responsable, interno);

    // Trigger active tasks Google Sheets update
    triggerActiveTasksGoogleSheetSync();

    // Trigger fuel service reset if all tasks are completed
    if (allTasksCompleted && updated.combustibleReset && !updated.combustibleReset.triggered) {
      updated.combustibleReset.triggered = true;
      db.updateWorkOrder(updated.id, { combustibleReset: updated.combustibleReset });
      triggerFuelServiceReset(updated);
    }

    res.json(updated);
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
    updatedTasks[taskIdx] = { ...updatedTasks[taskIdx], ...updates };
    db.updateWorkOrder(req.params.id, { tasks: updatedTasks });
    checkAndSendInsumosToSheet(order, updatedTasks, order.responsable, order.interno);

    console.log(`[PATCH task] Order ${req.params.id} / Task ${req.params.taskId} updated:`, updates);
    res.json({ success: true, task: updatedTasks[taskIdx] });
  } catch (err) {
    console.error('[PATCH task] Error:', err);
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
    const sector = getSectorByUsername(requester);

    // Check sector permission
    const existingCls = existing.clasificacion;
    const isPaniol = sector === 'Admin' || (requester && (requester.toLowerCase().includes('paniol') || requester.toLowerCase().includes('panol') || requester.toLowerCase().includes('pañol')));
    if (!isPaniol) {
      if (sector === 'Herrería' && existingCls !== 'Herrería') {
        return res.status(403).json({ error: "No tiene permisos para eliminar esta orden." });
      }
      if (sector === 'Edilicio' && existingCls !== 'Edilicio') {
        return res.status(403).json({ error: "No tiene permisos para eliminar esta orden." });
      }
      if (sector === 'Taller' && (existingCls === 'Herrería' || existingCls === 'Edilicio')) {
        return res.status(403).json({ error: "No tiene permisos para eliminar esta orden." });
      }
    }

    const success = db.deleteWorkOrder(req.params.id);
    
    // Trigger active tasks Google Sheets update
    triggerActiveTasksGoogleSheetSync();

    res.json({ success });
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

// Get archived orders
app.get('/api/orders/archived', (req, res) => {
  try {
    const archived = db.getArchivedOrders() || [];
    res.json(archived);
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
      // Check sector permission
      const cls = order.clasificacion;
      if (sector === 'Herrería' && cls !== 'Herrería') return;
      if (sector === 'Edilicio' && cls !== 'Edilicio') return;
      if (sector === 'Taller' && (cls === 'Herrería' || cls === 'Edilicio')) return;

      const tasks = (order.tasks || []).filter(t => t !== null && t !== undefined);
      const allFinished = tasks.length === 0 || tasks.every(t => t.status === "Finalizada");
      
      // Force out of service if active/paused timers exist
      const hasActiveOrPausedTimer = tasks.some(t => t.status !== 'Finalizada' && (t.timerStarted || t.timerStart || t.status === 'En Proceso'));
      const isOutOfService = order.estadoUnidad === 'fuera_de_servicio';

      const isSynced = order.syncStatus === 'success';
      const isVerified = order.verifiedStatus === 'success';

      if (type === 'controlled') {
        // Controlled cleanup: synced+verified orders can always be deleted regardless of timer/OOS state
        if (allFinished && isSynced && isVerified) {
          idsToDelete.push(order.id);
        }
      } else if (type === 'all-synced') {
        if (isSynced) {
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
    const sector = getSectorByUsername(requester);
    const existingCls = order.clasificacion;

    console.log(`[Permission Audit - Sync Retry] Requester: "${requester}", Resolved Sector: "${sector}", Order Cls: "${existingCls}"`);
    const isPaniol = sector === 'Admin' || (requester && (requester.toLowerCase().includes('paniol') || requester.toLowerCase().includes('panol') || requester.toLowerCase().includes('pañol')));
    if (!isPaniol) {
      if (sector === 'Herrería' && existingCls !== 'Herrería') {
        return res.status(403).json({ error: "No tiene permisos para sincronizar esta orden." });
      }
      if (sector === 'Edilicio' && existingCls !== 'Edilicio') {
        return res.status(403).json({ error: "No tiene permisos para sincronizar esta orden." });
      }
      if (sector === 'Taller' && (existingCls === 'Herrería' || existingCls === 'Edilicio')) {
        return res.status(403).json({ error: "No tiene permisos para sincronizar esta orden." });
      }
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
    // Also record who triggered the retry so the worker uses their credentials
    db.updateWorkOrder(order.id, { syncStatus: "pending", syncError: null, syncTriggeredBy: requester || null });
    
    res.json({ success: true, message: "Sincronización encolada para reintento." });
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

    // Normalize status strings coming from external agents, which may use
    // different wording (e.g. "synced"/"ok") than the canonical values the
    // app's UI recognizes ("success"/"error"/etc.), so the badges always render.
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

    // CRITICAL: Only update 'tasks' if it was explicitly sent in the body.
    // An intermediate call (e.g. setting status to 'syncing') must NOT overwrite
    // the tasks array with undefined — that was the root cause of tasks disappearing.
    if (req.body.hasOwnProperty('tasks') && Array.isArray(tasks) && tasks.length > 0) {
      updates.tasks = tasks;
    }

    if (taxesOrderNumber !== undefined && taxesOrderNumber !== null) {
      updates.taxesOrderNumber = taxesOrderNumber;
    }

    // Auto-archive when verification is successful (blue checkmark = data confirmed in Taxes)
    // verifiedStatus:success is the true confirmation that data is in the system.
    // We do NOT require syncStatus:success here — if verified passed, the order is done.
    // Exception: fuera_de_servicio units stay active so the team knows the vehicle is still in the shop.
    const isVerified = updates.verifiedStatus === 'success' || (updates.verifiedStatus === undefined && existing.verifiedStatus === 'success');
    const targetEstadoUnidad = req.body.estadoUnidad !== undefined ? req.body.estadoUnidad : existing.estadoUnidad;
    const isOutOfService = targetEstadoUnidad === 'fuera_de_servicio';

    if (isOutOfService) {
      updates.archived = false;
      updates.archivedAt = null;
    } else if (req.body.archived === true || isVerified) {
      updates.archived = true;
      updates.archivedAt = existing.archivedAt || new Date().toISOString();
      if (isVerified) console.log(`[LocalSyncResult] Order ${req.params.id} verified. Auto-archived to history.`);
    }

    // Propagate soft-delete state if explicitly sent
    if (req.body.hasOwnProperty('deleted')) {
      updates.deleted = req.body.deleted === true;
      updates.deletedAt = req.body.deleted === true
        ? (req.body.deletedAt || existing.deletedAt || new Date().toISOString())
        : null;
    }

    db.updateWorkOrder(req.params.id, updates);
    
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

    // Check sector permission
    const existingCls = order.clasificacion;
    const isPaniol = sector === 'Admin' || (requester && (requester.toLowerCase().includes('paniol') || requester.toLowerCase().includes('panol') || requester.toLowerCase().includes('pañol')));
    if (!isPaniol) {
      if (sector === 'Herrería' && existingCls !== 'Herrería') {
        return res.status(403).json({ error: "No tiene permisos para controlar esta orden." });
      }
      if (sector === 'Edilicio' && existingCls !== 'Edilicio') {
        return res.status(403).json({ error: "No tiene permisos para controlar esta orden." });
      }
      if (sector === 'Taller' && (existingCls === 'Herrería' || existingCls === 'Edilicio')) {
        return res.status(403).json({ error: "No tiene permisos para controlar esta orden." });
      }
    }

    // Set checking status
    db.updateWorkOrder(orderId, { verifiedStatus: "checking" });

    // Call verifyWorkOrder in background
    worker.verifyWorkOrder(orderId).then(result => {
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
      geminiApiKey: settings.geminiApiKey ? "••••••••••••" : "",
      claudeApiKey: settings.claudeApiKey ? "••••••••••••" : "",
      catalogSyncStatus: catalogStatus,
      catalogSyncError: settings.catalogSyncError || null,
      isSupervisor: !!isMainSupervisor
    };
    res.json(responseSettings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Save connection settings
app.post('/api/settings', (req, res) => {
  try {
    const { username, password, portalUrl, googleScriptUrl, googleActiveTasksUrl, preventivoScriptUrl, parteTallerScriptUrl, geminiApiKey, claudeApiKey } = req.body;
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
      if (geminiApiKey === "••••••••••••") {
        updates.geminiApiKey = current.geminiApiKey;
      } else {
        updates.geminiApiKey = geminiApiKey;
      }
    }

    if (claudeApiKey !== undefined) {
      if (claudeApiKey === "••••••••••••") {
        updates.claudeApiKey = current.claudeApiKey;
      } else {
        updates.claudeApiKey = claudeApiKey;
      }
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
    res.json({ success: true, settings: { username: saved.username, portalUrl: saved.portalUrl, googleScriptUrl: saved.googleScriptUrl, googleActiveTasksUrl: saved.googleActiveTasksUrl, preventivoScriptUrl: saved.preventivoScriptUrl, parteTallerScriptUrl: saved.parteTallerScriptUrl } });
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
    const apiKey = settings.geminiApiKey;
    const claudeApiKey = settings.claudeApiKey;
    if (!apiKey && !claudeApiKey) {
      return res.status(400).json({ error: "La Clave de API de Google Gemini o Anthropic Claude no está configurada. Por favor, ve a Ajustes e ingrésala." });
    }

    const scriptUrl = settings.preventivoScriptUrl;
    if (!scriptUrl) {
      return res.status(400).json({ error: "URL del script de preventivos no configurada." });
    }

    // Fetch the history from Google Sheets
    let sheetHistoryData = [];
    try {
      const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}accion=getHistoryData`;
      const response = await fetch(url);
      if (response.ok) {
        sheetHistoryData = await response.json();
      }
    } catch (err) {
      console.error("Error fetching preventivos history for assistant:", err);
    }

    // Filter and optimize history to avoid hitting Gemini 429 rate limits (8466 rows is too large)
    let optimizedHistory = [];
    const match = message.match(/(?:interno|unidad|camion|nro|nº)?\s*(\d{1,3})\b/i);
    if (match) {
      const targetInterno = match[1];
      // Get all records for this specific vehicle
      const vehicleHistory = sheetHistoryData.filter(h => String(h.interno).trim() === String(targetInterno).trim());
      // Also get the most recent 100 general records
      const generalHistory = sheetHistoryData.slice(0, 100);
      // Combine and deduplicate
      const combined = [...vehicleHistory, ...generalHistory];
      const seenKeys = new Set();
      optimizedHistory = combined.filter(h => {
        const key = `${h.fecha || h.date}-${h.interno}-${h.tipo}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });
    } else {
      // Default to most recent 250 records
      optimizedHistory = sheetHistoryData.slice(0, 250);
    }

    // Format a concise version of the history to keep context small and readable
    const formattedHistory = optimizedHistory.map(h => {
      return `Fecha: ${h.fecha || h.date || '-'}, Interno: ${h.interno || '-'}, Tipo: ${h.tipo || '-'}, Datos: ${h.datos || '-'}`;
    }).join('\n');

    let finalResponseText = "";

    const systemPrompt = `Sos "Hugo AI", el asistente inteligente de mantenimiento de taller de Contenedores Hugo.
Tu objetivo es ayudar al personal respondiendo preguntas sobre auxilios, reparaciones y cambios de repuestos de los vehículos basándote únicamente en el historial oficial de la empresa.

Aquí está el historial completo de services extraído de Google Sheets:
${formattedHistory || "No hay registros en el historial actualmente."}

Instrucciones:
1. Responde en español de forma concisa y amigable.
2. Si el usuario te pregunta por la "última vez" de un repuesto o servicio para un vehículo específico, busca la fecha más reciente de ese evento en el historial.
3. Si el usuario pregunta por "auxilios" o "reparaciones", busca en la columna de Datos o Tipo las palabras relacionadas.
4. Si no encuentras información sobre la consulta, indícalo amablemente sin inventar datos.`;

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
        max_tokens: 1024,
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
      finalResponseText = result?.content?.[0]?.text || "";
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
    worker.scrapeCatalogs(username).then(result => {
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
app.get('/api/preventivos/flota', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.preventivoScriptUrl;
  if (!scriptUrl) {
    return res.status(400).json({ error: "URL del script de preventivos no configurada." });
  }
  try {
    const sep = scriptUrl.includes('?') ? '&' : '?';
    const url = `${scriptUrl}${sep}accion=getFleetData&_t=${Date.now()}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    let data = await response.json();

    // Apply local overrides (bypass Google Apps Script cache for manual corrections)
    const overrides = db.getOdometerOverrides();
    if (Array.isArray(data) && Object.keys(overrides).length > 0) {
      data = data.map(item => {
        const key = String(item.interno || '').trim();
        const ov = overrides[key];
        if (!ov) return item;
        const patched = { ...item };
        if (ov.km !== undefined && !isNaN(ov.km)) patched.kmReales = ov.km;
        if (ov.hs !== undefined && !isNaN(ov.hs)) patched.hsReales = ov.hs;
        return patched;
      });
    }

    res.json(data);
  } catch (error) {
    console.error("Error fetching preventivos fleet:", error);
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

    // Apply local odometer overrides
    const overrides = db.getOdometerOverrides();
    if (Array.isArray(data) && Object.keys(overrides).length > 0) {
      data = data.map(item => {
        const key = String(item.interno || '').trim();
        const ov = overrides[key];
        if (!ov) return item;
        const patched = { ...item };
        if (ov.km !== undefined && !isNaN(ov.km)) patched.kmReales = ov.km;
        if (ov.hs !== undefined && !isNaN(ov.hs)) patched.hsReales = ov.hs;
        return patched;
      });
    }

    res.json(data);
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

// --- PARTE TALLER PROXY ENDPOINTS ---
app.get('/api/parte-taller/estado', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.parteTallerScriptUrl;
  if (!scriptUrl) {
    return res.status(400).json({ error: "URL del script de parte taller no configurada." });
  }
  try {
    const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}accion=get_state`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error fetching parte taller state:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/parte-taller/novedad', async (req, res) => {
  const settings = db.getSettings();
  const scriptUrl = settings.parteTallerScriptUrl;
  if (!scriptUrl) {
    return res.status(400).json({ error: "URL del script de parte taller no configurada." });
  }
  try {
    const response = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    if (!response.ok) throw new Error(`Google Apps Script error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error forwarding post to parte taller:", error);
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
      db.updateWorkOrder(existingOrder.id, { tasks: tasks });
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

  // Start the Puppeteer background sync worker if enabled (only locally, never in Railway)
  const isRailway = process.env.RAILWAY_ENVIRONMENT !== undefined;
  const enableWorker = (process.env.NODE_ENV !== 'production' || process.env.ENABLE_BACKGROUND_WORKER === 'true') && !isRailway;
  if (enableWorker && process.env.DISABLE_BACKGROUND_WORKER !== 'true') {
    worker.startWorker();
  } else {
    console.log('[Worker] Puppeteer background worker is disabled.');
  }


  // Start Railway sync agent if running locally to bridge the Railway cloud database
  // (Only runs locally, never in the cloud/production)
  if (process.env.NODE_ENV !== 'production') {
    try {
      const agent = require('./railway_sync_agent');
      agent.startAgent();
    } catch (agentErr) {
      console.error('[RailwayAgent] Could not start Railway sync agent:', agentErr.message);
    }
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
