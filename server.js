const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');
const worker = require('./syncWorker');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Disable caching for JS and CSS files so browsers always load the latest version
app.use((req, res, next) => {
  if (req.path.endsWith('.js') || req.path.endsWith('.css')) {
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
      syncStatus: allTasksCompleted ? "pending" : "local",
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
    const { username, password, portalUrl } = req.body;
    const current = db.getSettings();
    
    const updates = {
      username: username !== undefined ? username : current.username,
      portalUrl: portalUrl !== undefined ? portalUrl : current.portalUrl
    };

    // Only update password if a new one is provided (not masked)
    if (password && password !== "••••••••••••") {
      updates.password = password;
    }

    const saved = db.saveSettings(updates);
    res.json({ success: true, settings: { username: saved.username, portalUrl: saved.portalUrl } });
  } catch (error) {
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
