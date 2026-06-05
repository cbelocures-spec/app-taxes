const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const db = require('./database');
const worker = require('./syncWorker');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Disable caching for API endpoints, JS and CSS files so browsers always load the latest version/data
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// API Routes

// Get all work orders
app.get('/api/orders', (req, res) => {
  try {
    const orders = db.getWorkOrders();
    // Sort by createdAt descending
    const sorted = [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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

    const newOrder = db.createWorkOrder({
      rodado,
      responsable,
      fechaEntrega,
      horario,
      interno,
      clasificacion,
      incidente,
      tasks
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

    const allTasksCompleted = (tasks || []).length > 0 && (tasks || []).every(t => t.status === "Finalizada");

    const updated = db.updateWorkOrder(req.params.id, {
      rodado,
      responsable,
      fechaEntrega,
      horario,
      interno,
      clasificacion,
      incidente,
      syncStatus: (existing.syncStatus === "pending" || existing.syncStatus === "syncing") ? existing.syncStatus : "local",
      syncError: null,
      syncDate: null,
      tasks: (tasks || []).map((t, idx) => ({
        id: t.id || `${Date.now()}-${idx}`,
        centroCosto: t.centroCosto || "",
        empleado: t.empleado || "",
        horasEstimadas: parseFloat(t.horasEstimadas) || 0,
        descripcion: t.descripcion || "",
        status: t.status || "Pendiente",
        timerStart: t.timerStart || null
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
    // Mask password for security
    const responseSettings = {
      username: settings.username,
      password: settings.password ? "••••••••••••" : "",
      portalUrl: settings.portalUrl || "https://taxes.com.ar",
      googleScriptUrl: settings.googleScriptUrl || "",
      catalogSyncStatus: settings.catalogSyncStatus || "idle",
      catalogSyncError: settings.catalogSyncError || null
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
    const current = db.getSettings();
    
    const updates = {
      username: username !== undefined ? username : current.username,
      portalUrl: portalUrl !== undefined ? portalUrl : current.portalUrl,
      googleScriptUrl: googleScriptUrl !== undefined ? googleScriptUrl : current.googleScriptUrl
    };

    // Only update password if a new one is provided (not masked)
    if (password && password !== "••••••••••••") {
      updates.password = password;
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

    const data = await response.json();
    res.json(data);
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
    // Run catalog scraping asynchronously so response is fast
    worker.scrapeCatalogs().then(result => {
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
        const queryParams = new URLSearchParams({
          interno: matchedNovelty.interno,
          rubro: matchedNovelty.rubro,
          subrubro: matchedNovelty.subrubro,
          observacion: matchedNovelty.observacion,
          mecanico: task.empleado || "",
          supervisor: supervisor || (existingOrder ? existingOrder.responsable : '') || "AUTO"
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

// Start Express Server and Background Worker
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`Taller App Server running at: http://localhost:${PORT}`);
  console.log(`======================================================`);
  
  // Start the Puppeteer background sync worker
  worker.startWorker();
});
