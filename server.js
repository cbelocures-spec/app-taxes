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

// Capturar errores inesperados en el servidor y activar agentes de auto-curación
process.on('uncaughtException', (err) => {
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
app.use(express.json());

// Disable caching for API, JS, CSS, and HTML files (including /) so browsers always load the latest version/data
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
  // Allow login, settings, and static assets
  if (req.path === '/api/login' || req.path === '/api/settings' || !req.path.startsWith('/api')) {
    return next();
  }

  const username = req.headers['x-user-username'];
  if (username) {
    const user = db.getUser(username);
    if (!user || !user.password) {
      console.log(`[Auth Check] User "${username}" not found or has no password in DB. Returning 401.`);
      return res.status(401).json({ error: "Session expired or invalid user." });
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// API Routes

// Utility to determine sector by username
function getSectorByUsername(username) {
  if (!username) return 'Taller';
  const email = username.toLowerCase().trim();
  
  if (email === 'taller@contenedoreshugo.com.ar' || email === 'paniol@contenedoreshugo.com.ar') {
    return 'Admin';
  }
  if (email === 'j.carmona@contenedoreshugo.com.ar') {
    return 'Herrería';
  }
  if (email === 'ftoledo@contenedoreshugo.com.ar') {
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

    // Only update global settings (used for catalog sync fallback) if not already set,
    // or if this is the same user updating their own credentials.
    // This prevents user B's login from replacing user A's global settings.
    const currentSettings = db.getSettings();
    const isSameUser = currentSettings.username && 
                       currentSettings.username.toLowerCase().trim() === username.toLowerCase().trim();
    const noGlobalUser = !currentSettings.username || !currentSettings.password;
    
    if (noGlobalUser || isSameUser) {
      db.saveSettings({ username, password, catalogSyncStatus: 'idle', catalogSyncError: null });
      console.log(`[Login] Global settings updated for ${username}.`);
      // Trigger catalog sync in background for this user
      worker.scrapeCatalogs(username).then(result => {
        console.log(`[Login] Catalog sync for ${username}:`, result.message);
      }).catch(e => {
        console.error(`[Login] Catalog sync error for ${username}:`, e.message);
      });
    } else {
      // Secondary user logging in — clear stale errors but don't overwrite global settings
      if (currentSettings.catalogSyncError) {
        db.saveSettings({ catalogSyncStatus: 'idle', catalogSyncError: null });
      }
      console.log(`[Login] Secondary user ${username} logged in (global settings kept for ${currentSettings.username}).`);
    }

    res.json({ success: true, username: user.username, sector: getSectorByUsername(username) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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

// Create a new work order
app.post('/api/orders', (req, res) => {
  try {
    const { rodado, responsable, fechaEntrega, horario, interno, clasificacion, incidente, tasks } = req.body;
    
    if (!rodado || !responsable || !interno || !clasificacion) {
      return res.status(400).json({ error: "Faltan campos obligatorios: rodado, responsable, interno, clasificacion son requeridos." });
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
      createdBy
    });

    // Trigger Google Sheets update asynchronously for any finalized tasks
    checkAndTriggerGoogleSheetUpdates(null, newOrder.tasks, responsable, interno);

    res.status(201).json(newOrder);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update a work order
app.put('/api/orders/:id', (req, res) => {
  try {
    const { rodado, responsable, fechaEntrega, horario, interno, clasificacion, incidente, tasks } = req.body;
    
    const existing = db.getWorkOrderById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    const requester = req.headers['x-user-username'] || null;
    const sector = getSectorByUsername(requester);

    // Check sector permission
    const existingCls = existing.clasificacion;
    if (sector === 'Herrería' && existingCls !== 'Herrería') {
      return res.status(403).json({ error: "No tiene permisos para modificar esta orden." });
    }
    if (sector === 'Edilicio' && existingCls !== 'Edilicio') {
      return res.status(403).json({ error: "No tiene permisos para modificar esta orden." });
    }
    if (sector === 'Taller' && (existingCls === 'Herrería' || existingCls === 'Edilicio')) {
      return res.status(403).json({ error: "No tiene permisos para modificar esta orden." });
    }

    // Force sector classification
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

    const createdBy = existing.createdBy || requester;
    const allTasksCompleted = (tasks || []).length > 0 && (tasks || []).every(t => t.status === "Finalizada");

    const updated = db.updateWorkOrder(req.params.id, {
      rodado,
      responsable,
      fechaEntrega,
      horario,
      interno,
      clasificacion: finalClasificacion,
      incidente,
      createdBy,
      syncStatus: (existing.syncStatus === "pending" || existing.syncStatus === "syncing") ? existing.syncStatus : "local",
      syncError: null,
      syncDate: null,
      tasks: (tasks || []).map((t, idx) => ({
        id: t.id || `${Date.now()}-${idx}`,
        centroCosto: t.centroCosto || "",
        empleado: t.empleado || "",
        horasEstimadas: parseFloat(String(t.horasEstimadas).replace(',', '.')) || 0,
        descripcion: t.descripcion || "",
        status: t.status || "Pendiente",
        timerStart: t.timerStart || null,
        timerStarted: t.timerStarted === true || t.timerStarted === 'true',
        timerHistory: Array.isArray(t.timerHistory) ? t.timerHistory : []
      }))
    });

    // Trigger Google Sheets update asynchronously for any newly finalized tasks
    checkAndTriggerGoogleSheetUpdates(existing, updated.tasks, responsable, interno);

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    if (sector === 'Herrería' && existingCls !== 'Herrería') {
      return res.status(403).json({ error: "No tiene permisos para eliminar esta orden." });
    }
    if (sector === 'Edilicio' && existingCls !== 'Edilicio') {
      return res.status(403).json({ error: "No tiene permisos para eliminar esta orden." });
    }
    if (sector === 'Taller' && (existingCls === 'Herrería' || existingCls === 'Edilicio')) {
      return res.status(403).json({ error: "No tiene permisos para eliminar esta orden." });
    }

    const success = db.deleteWorkOrder(req.params.id);
    res.json({ success });
  } catch (error) {
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

    // Check sector permission
    const existingCls = order.clasificacion;
    if (sector === 'Herrería' && existingCls !== 'Herrería') {
      return res.status(403).json({ error: "No tiene permisos para sincronizar esta orden." });
    }
    if (sector === 'Edilicio' && existingCls !== 'Edilicio') {
      return res.status(403).json({ error: "No tiene permisos para sincronizar esta orden." });
    }
    if (sector === 'Taller' && (existingCls === 'Herrería' || existingCls === 'Edilicio')) {
      return res.status(403).json({ error: "No tiene permisos para sincronizar esta orden." });
    }

    const allCompleted = (order.tasks || []).length > 0 && (order.tasks || []).every(t => t.status === "Finalizada");
    if (!allCompleted) {
      return res.status(400).json({ error: "No se puede subir a Taxes: la orden tiene tareas en proceso o incompletas." });
    }

    // Reset status to pending so worker picks it up immediately
    db.updateWorkOrder(order.id, { syncStatus: "pending", syncError: null });
    
    res.json({ success: true, message: "Sincronización encolada para reintento." });
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
      requestingUser.toLowerCase().includes("cesar")
    ) : (
      settings.username && (
        settings.username.toLowerCase().includes("paniol") ||
        settings.username.toLowerCase().includes("belocures") ||
        settings.username.toLowerCase().includes("cesar")
      )
    );

    let catalogStatus = settings.catalogSyncStatus || "idle";
    if (catalogStatus === "syncing" && !worker.isScraping) {
      console.log("[Settings] Auto-correcting stuck catalogSyncStatus from 'syncing' to 'idle' because worker is not scraping.");
      catalogStatus = "idle";
      db.saveSettings({ catalogSyncStatus: "idle", catalogSyncError: null });
    }

    const responseSettings = {
      username: displayUsername,
      password: displayPassword,
      portalUrl: settings.portalUrl || "https://taxes.com.ar",
      googleScriptUrl: settings.googleScriptUrl || "",
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
    const { username, password, portalUrl, googleScriptUrl } = req.body;
    const requestingUser = req.headers['x-user-username'] || null;
    const current = db.getSettings();
    
    // If we have the requesting user, update their personal credentials in db.users
    if (requestingUser && username && password && password !== "••••••••••••") {
      db.saveUser(username, password);
      console.log(`[Settings] Updated credentials for user ${requestingUser} -> ${username}`);
    }

    const updates = {
      portalUrl: portalUrl !== undefined ? portalUrl : current.portalUrl,
      googleScriptUrl: googleScriptUrl !== undefined ? googleScriptUrl : current.googleScriptUrl
    };

    // Only update global username/password if this is the global/primary user
    const isPrimaryUser = !current.username || 
                          (requestingUser && current.username.toLowerCase().trim() === (username || '').toLowerCase().trim());
    if (isPrimaryUser) {
      updates.username = username !== undefined ? username : current.username;
      if (password && password !== "••••••••••••") {
        updates.password = password;
      }
    }

    const saved = db.saveSettings(updates);
    res.json({ success: true, settings: { username: saved.username, portalUrl: saved.portalUrl, googleScriptUrl: saved.googleScriptUrl } });
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

// Get catalogs dropdown options
app.get('/api/catalogs', (req, res) => {
  try {
    const catalogs = db.getCatalogs();
    res.json(catalogs);
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
    isScraping: worker.isScraping
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
  const scriptUrl = settings.googleScriptUrl;
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
        
        fetch(updateUrl)
          .then(async (res) => {
            const text = await res.text();
            console.log(`[Google Sheets] Apps Script Response (Status ${res.status}):`, text);
          })
          .catch(err => {
            console.error("[Google Sheets] Error calling Apps Script:", err.message);
          });
      }
    }
  } catch (error) {
    console.error("Error in checkAndTriggerGoogleSheetUpdates:", error);
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

  // Start the Puppeteer background sync worker
  worker.startWorker();

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
