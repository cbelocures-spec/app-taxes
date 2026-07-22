const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.json');

function normalizeEmail(email) {
  if (!email) return email;
  let normalized = String(email).trim().toLowerCase();
  const parts = normalized.split('@');
  if (parts.length !== 2) {
    return normalized;
  }
  const localPart = parts[0];
  let domain = parts[1];
  // Correct any variations of contenedoreshugo or contrnedoreshugo
  if (domain.includes('contenedoreshugo') || domain.includes('contrnedoreshugo')) {
    domain = 'contenedoreshugo.com.ar';
  }
  return `${localPart}@${domain}`;
}

function cleanEncoding(text) {
  if (typeof text !== 'string') return text;
  
  let cleaned = text;
  
  // 1. Common encoding repair dictionary
  const repairs = [
    { regex: /Diagn[\uFFFD\s?]+stico/gi, replace: 'Diagnóstico' },
    { regex: /cambi[\uFFFD\s?]+/gi, replace: 'cambió' },
    { regex: /hidr[\uFFFD\s?]+lica/gi, replace: 'hidráulica' },
    { regex: /ret[\uFFFD\s?]+n/gi, replace: 'retén' },
    { regex: /direcci[\uFFFD\s?]+n/gi, replace: 'dirección' },
    { regex: /reparaci[\uFFFD\s?]+n/gi, replace: 'reparación' },
    { regex: /v[\uFFFD\s?]+lvula/gi, replace: 'válvula' },
    { regex: /compresi[\uFFFD\s?]+n/gi, replace: 'compresión' },
    { regex: /bater[\uFFFD\s?]+a/gi, replace: 'batería' },
    { regex: /camion[\uFFFD\s?]+/gi, replace: 'camión' },
    { regex: /el[\uFFFD\s?]+ctrico/gi, replace: 'eléctrico' },
    { regex: /neum[\uFFFD\s?]+tico/gi, replace: 'neumático' }
  ];
  
  for (const r of repairs) {
    cleaned = cleaned.replace(r.regex, r.replace);
  }
  
  // 2. Remove any remaining stray replacement characters/black diamonds/multiple question marks
  cleaned = cleaned
    .replace(/[\uFFFD]+/g, '')
    // Also clean double-encoded or corrupted accent sequences
    .replace(/Ã³/g, 'ó')
    .replace(/Ã¡/g, 'á')
    .replace(/Ã©/g, 'é')
    .replace(/Ã\*/g, 'í')
    .replace(/Ãº/g, 'ú')
    .replace(/Ã±/g, 'ñ')
    .replace(/Ã‘/g, 'Ñ');

  return cleaned
    // Replace common decoding artifacts from ISO-8859-1 vs UTF-8 mismatches
    .replace(/Jes\u01e7s/g, 'Jesús')
    .replace(/Jes\u00e7s/g, 'Jesús')
    .replace(/Jes\uFFFDs/g, 'Jesús')
    .replace(/Jesgs/gi, 'Jesús')
    .replace(/Jess/g, 'Jesús')
    .replace(/Jes\u00ad\u00ads/g, 'Jesús')
    .replace(/Jes\u017ds/g, 'Jesús')
    .replace(/Jesǧs/g, 'Jesús')
    .replace(/Kev\uFFFDn/g, 'Kevín')
    .replace(/Kevn/g, 'Kevín')
    .replace(/Kev\u00ad\u00adn/g, 'Kevín')
    .replace(/Mat\uFFFDas/g, 'Matías')
    .replace(/Matas/g, 'Matías')
    .replace(/Garc\uFFFDa/g, 'García')
    .replace(/Garca/g, 'García')
    .replace(/Yamand\u01e7/g, 'Yamandú')
    .replace(/Yamand/g, 'Yamandú')
    .replace(/Yamandǧ/g, 'Yamandú')
    .replace(/V\uFFFDctor/g, 'Víctor')
    .replace(/Vctor/g, 'Víctor')
    .replace(/F\u01e8lix/g, 'Félix')
    .replace(/Flix/g, 'Félix')
    .replace(/F\u00d1lix/g, 'Félix')
    .replace(/F\u017d\u00ad\u00adlix/g, 'Félix')
    .replace(/F\u017dlix/g, 'Félix')
    .replace(/FǸlix/g, 'Félix')
    .replace(/Dami\u01edn/g, 'Damián')
    .replace(/Dami\u00f1n/g, 'Damián')
    .replace(/Damin/g, 'Damián')
    .replace(/Damiǭn/g, 'Damián')
    .replace(/R\uFFFDoS/g, 'Ríos')
    .replace(/Ros/g, 'Ríos')
    .replace(/R\u00edos/g, 'Ríos')
    .replace(/Rios/g, 'Ríos')
    .replace(/R\u00EDos/g, 'Ríos')
    .replace(/Hern\uFFFDn/g, 'Hernán')
    .replace(/Hernn/g, 'Hernán')
    .replace(/Sebasti\uFFFDn/g, 'Sebastián')
    .replace(/Sebastin/g, 'Sebastián')
    .replace(/Agust\uFFFDn/g, 'Agustín')
    .replace(/Agustn/g, 'Agustín')
    .replace(/Rom\uFFFDn/g, 'Román')
    .replace(/Romn/g, 'Román')
    .replace(/Mart\uFFFDn/g, 'Martín')
    .replace(/Martn/g, 'Martín')
    .replace(/Nicol\uFFFDs/g, 'Nicolás')
    .replace(/Nicols/g, 'Nicolás')
    .replace(/Ra\uFFFDu/g, 'Raúl')
    .replace(/Ral/g, 'Raúl')
    .replace(/Adri\uFFFDn/g, 'Adrián')
    .replace(/Adrin/g, 'Adrián')
    .replace(/Guzm\uFFFDn/g, 'Guzmán')
    .replace(/Guzmn/g, 'Guzmán')
    .replace(/Jes\u00FAa/g, 'Jesús')
    .trim();
}

const DEFAULT_MECHANICS = [
  "CALOMINO DARIO",
  "Canaviri Fernandez, Jesús",
  "Cuba Orosco, Kevín Genaro",
  "DOMINIC DYLAN",
  "GERRY CRISTIAN MARCELO",
  "GODOY DAVID",
  "Gustavo Javier Benitez",
  "LOPEZ GUSTAVO",
  "Monzon, Carlos Agustin",
  "Morel, Luis Maximiliano",
  "MUSDALINO FRANCO",
  "OJEDA FERNANDEZ JOSE ENRIQUE",
  "Ojeda Fernández, Miguel",
  "Olivera, Diego",
  "PANETTA ALBARRACIN FEDERICO",
  "PEREZ FACUNDO",
  "Perino Martin Adrian",
  "Ríos, Cesar Damián",
  "Rocha, Ariel Maximiliano",
  "RODRIGUEZ CARLOS FERNANDO",
  "RODRIGUEZ MARCELO",
  "RODRIGUEZ NICOLAS",
  "Sosa, Alejandro Damian",
  "Vera, Domingo Sergio"
];

// Default database structure
const DEFAULT_DB = {
  settings: {
    username: "",
    password: "",
    portalUrl: "https://taxes.com.ar",
    googleScriptUrl: "https://script.google.com/macros/s/AKfycbxBIPF6-uoK2aFNfRCxDUS5AAFxLeToB7iMz3rdf_J4JjJBvsNbOv7aIdXBBnoxRZiC/exec",
    googleActiveTasksUrl: "https://script.google.com/macros/s/AKfycbxBIPF6-uoK2aFNfRCxDUS5AAFxLeToB7iMz3rdf_J4JjJBvsNbOv7aIdXBBnoxRZiC/exec",
    preventivoScriptUrl: "https://script.google.com/macros/s/AKfycbwuPIslBnq77dG5bhk19h2H2s9TlOeB6XrCpqCMDX-8dvO8uisNRdx7P43lyJtT1sZIgQ/exec",
    parteTallerScriptUrl: "https://script.google.com/macros/s/AKfycbyoHEhogBxWcSIdDtzzUIV9mhzO25TNAChgBlCCJbuHPIylXNpIpX8LKM6qc4DQjij8/exec",
    catalogSyncStatus: "idle",
    catalogSyncError: null
  },
  catalogs: {
    rodados: [],      // array of { value, label }
    responsables: [], // array of { value, label }
    empleados: [],    // array of { value, label }
    centrosCosto: []  // array of { value, label }
  },
  workOrders: [],
  activeMechanics: DEFAULT_MECHANICS,
  users: {}
};

// Thread-safe read/write helper
class LocalDB {
  constructor() {
    this.init();
  }

  // Initialize DB if it doesn't exist
  init() {
    try {
      const dir = path.dirname(DB_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (!fs.existsSync(DB_PATH)) {
        // On first startup with a new volume, seed from the bundled db.json
        // (contains migrated data: orders, users, settings, overrides)
        const bundledPath = path.join(__dirname, 'db.json');
        if (DB_PATH !== bundledPath && fs.existsSync(bundledPath)) {
          console.log(`[DB] Seeding volume DB from bundled db.json → ${DB_PATH}`);
          fs.copyFileSync(bundledPath, DB_PATH);
        } else {
          this.write(DEFAULT_DB);
        }
      } else {
        // Ensure all root keys exist
        const data = this.read();
        let changed = false;
        for (const key of Object.keys(DEFAULT_DB)) {
          if (data[key] === undefined) {
            data[key] = DEFAULT_DB[key];
            changed = true;
          }
        }
        if (changed) {
          this.write(data);
        }
      }
    } catch (e) {
      console.error("⚠️ ADVERTENCIA de inicialización de base de datos:", e.message);
      console.error(`No se pudo inicializar la base de datos en ${DB_PATH}. Si estás usando Railway con un volumen persistente, por favor añade la variable de entorno RAILWAY_RUN_UID = 0 en los ajustes de tu servicio para permitir acceso de escritura.`);
    }
  }

  // Read raw DB contents synchronously to prevent async race conditions in Node event loop
  read() {
    try {
      if (!fs.existsSync(DB_PATH)) {
        return JSON.parse(JSON.stringify(DEFAULT_DB));
      }
      const content = fs.readFileSync(DB_PATH, 'utf8');
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object') {
        return JSON.parse(JSON.stringify(DEFAULT_DB));
      }

      // Migration: Normalize email usernames and createdBy fields in memory
      let migrated = false;
      if (parsed.users) {
        const cleanUsers = {};
        for (const rawKey of Object.keys(parsed.users)) {
          const normalizedKey = normalizeEmail(rawKey);
          if (normalizedKey !== rawKey) {
            migrated = true;
          }
          const userObj = parsed.users[rawKey];
          if (userObj) {
            userObj.username = normalizedKey;
            cleanUsers[normalizedKey] = userObj;
          }
        }
        parsed.users = cleanUsers;
      }

      if (parsed.settings && parsed.settings.username) {
        const normalizedSettingUser = normalizeEmail(parsed.settings.username);
        if (normalizedSettingUser !== parsed.settings.username) {
          parsed.settings.username = normalizedSettingUser;
          migrated = true;
        }
      }

      if (Array.isArray(parsed.workOrders)) {
        parsed.workOrders.forEach(order => {
          if (order.createdBy) {
            const normalizedCreatedBy = normalizeEmail(order.createdBy);
            if (normalizedCreatedBy !== order.createdBy) {
              order.createdBy = normalizedCreatedBy;
              migrated = true;
            }
          }
        });
      }

      // If any migration took place, write it back to disk immediately
      if (migrated) {
        console.log("Database migration: Normalized typo email addresses in users/settings/workOrders.");
        try {
          fs.writeFileSync(DB_PATH, JSON.stringify(parsed, null, 2), 'utf8');
        } catch (writeErr) {
          console.error("Failed to persist database migration to disk:", writeErr.message);
        }
      }

      return parsed;
    } catch (e) {
      console.error("Error parsing db.json, returning default structure:", e.message);
      return JSON.parse(JSON.stringify(DEFAULT_DB));
    }
  }

  // Write contents atomically/synchronously to prevent data corruption
  write(data) {
    try {
      const dir = path.dirname(DB_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const content = JSON.stringify(data, null, 2);
      fs.writeFileSync(DB_PATH, content, 'utf8');
    } catch (e) {
      console.error("Error writing to db.json:", e.message);
      throw new Error(`Permisos insuficientes para escribir en ${DB_PATH} (${e.message}). Si estás usando Railway con un volumen persistente en /data, por favor añade la variable de entorno RAILWAY_RUN_UID = 0 en los ajustes de tu servicio para permitir acceso de escritura.`);
    }
  }

  // --- Settings Methods ---
  getSettings() {
    const db = this.read();
    const settings = { ...DEFAULT_DB.settings, ...(db.settings || {}) };
    if (!settings.googleScriptUrl) {
      settings.googleScriptUrl = DEFAULT_DB.settings.googleScriptUrl;
    }
    if (!settings.googleActiveTasksUrl) {
      settings.googleActiveTasksUrl = DEFAULT_DB.settings.googleActiveTasksUrl;
    }
    if (!settings.preventivoScriptUrl) {
      settings.preventivoScriptUrl = DEFAULT_DB.settings.preventivoScriptUrl;
    }
    if (!settings.parteTallerScriptUrl) {
      settings.parteTallerScriptUrl = DEFAULT_DB.settings.parteTallerScriptUrl;
    }
    if (settings.username) {
      settings.username = normalizeEmail(settings.username);
    }
    return settings;
  }

  saveSettings(settings) {
    const db = this.read();
    const cleanSettings = { ...settings };
    if (cleanSettings.username) {
      cleanSettings.username = normalizeEmail(cleanSettings.username);
    }
    if (cleanSettings.portalUrl) {
      let url = String(cleanSettings.portalUrl).trim();
      // Remove trailing slash
      if (url.endsWith('/')) {
        url = url.slice(0, -1);
      }
      // Remove subroutes like /admin, /login, /logout
      url = url.replace(/\/admin$/, '').replace(/\/login$/, '').replace(/\/logout$/, '');
      cleanSettings.portalUrl = url;
    }
    db.settings = { ...db.settings, ...cleanSettings };
    this.write(db);
    return db.settings;
  }

  // --- Users Methods ---
  getUser(username) {
    if (!username) return null;
    const db = this.read();
    const key = normalizeEmail(username);
    return db.users ? db.users[key] : null;
  }

  saveUser(username, password) {
    if (!username) return null;
    const db = this.read();
    if (!db.users) db.users = {};
    const key = normalizeEmail(username);
    db.users[key] = {
      username: key,
      password: password
    };
    this.write(db);
    return db.users[key];
  }

  normalizeEmail(email) {
    return normalizeEmail(email);
  }

  // --- Catalogs Methods ---
  getCatalogs() {
    const db = this.read();
    const catalogs = db.catalogs || DEFAULT_DB.catalogs;
    
    // Sanitize labels to fix any encoding issues
    if (Array.isArray(catalogs.empleados)) {
      catalogs.empleados = catalogs.empleados.map(e => ({ ...e, label: cleanEncoding(e.label) }));
    }
    if (Array.isArray(catalogs.responsables)) {
      catalogs.responsables = catalogs.responsables.map(r => ({ ...r, label: cleanEncoding(r.label) }));
    }
    if (Array.isArray(catalogs.rodados)) {
      catalogs.rodados = catalogs.rodados.map(ro => ({ ...ro, label: cleanEncoding(ro.label) }));
    }
    return catalogs;
  }

  saveCatalogs(catalogs) {
    const db = this.read();
    
    // Sanitize incoming labels
    const cleanRodados = (catalogs.rodados || []).map(ro => ({ ...ro, label: cleanEncoding(ro.label) }));
    const cleanResponsables = (catalogs.responsables || []).map(r => ({ ...r, label: cleanEncoding(r.label) }));
    const cleanIncomingEmps = (catalogs.empleados || []).map(e => ({ ...e, label: cleanEncoding(e.label) }));
    
    // Auto-merge custom mechanics into the synced catalog
    const customEmps = [
      "DOMINIC DYLAN",
      "PEREZ FACUNDO",
      "LOPEZ GUSTAVO",
      "CALOMINO DARIO",
      "MUSDALINO FRANCO",
      "RODRIGUEZ MARCELO",
      "GODOY DAVID"
    ].map(name => ({ value: name, label: name }));
    
    const mergedEmps = [...cleanIncomingEmps];
    for (const cEmp of customEmps) {
      if (!mergedEmps.some(e => String(e.value).toLowerCase() === cEmp.value.toLowerCase())) {
        mergedEmps.push(cEmp);
      }
    }

    db.catalogs = {
      rodados: cleanRodados,
      responsables: cleanResponsables,
      empleados: mergedEmps,
      centrosCosto: catalogs.centrosCosto || []
    };
    this.write(db);
    return db.catalogs;
  }

  // --- Work Orders Methods ---
  // Returns ACTIVE (non-archived) orders only — used by the sync worker and main UI
  getWorkOrders() {
    const db = this.read();
    return (db.workOrders || []).filter(o => !o.archived && o.deleted !== true);
  }

  // Returns ARCHIVED orders only — used by the History/Historial section
  getArchivedOrders() {
    const db = this.read();
    return (db.workOrders || []).filter(o => o.archived === true && o.deleted !== true);
  }

  getWorkOrderById(id) {
    // Search across all orders (active + archived)
    const db = this.read();
    return (db.workOrders || []).find(o => o.id === id);
  }

  // Soft-archive an order: marks it as archived so it leaves the active list
  // but stays in the DB until the user permanently deletes it from History
  archiveWorkOrder(id) {
    const db = this.read();
    const order = db.workOrders.find(o => o.id === id);
    if (!order) return false;
    order.archived = true;
    order.archivedAt = new Date().toISOString();
    this.write(db);
    return true;
  }

  createWorkOrder(orderData) {
    const db = this.read();
    
    const tasks = (orderData.tasks || []).map((t, idx) => ({
      id: t.id || `${Date.now()}-${idx}`,
      centroCosto: t.centroCosto || "",
      empleado: t.empleado || "",
      horasEstimadas: parseFloat(String(t.horasEstimadas).replace(',', '.')) || 0,
      descripcion: cleanEncoding(t.descripcion || ""),
      status: t.status || "Pendiente", // Pendiente, Finalizada
      insumos: t.insumos || "",
      timerStart: t.timerStart || null,
      timerStarted: t.timerStarted === true || t.timerStarted === 'true',
      timerHistory: Array.isArray(t.timerHistory) ? t.timerHistory : [],
      synced: false // Tracks if initially created in Taxes
    }));

    // Create new Work Order object with defaults
    const newOrder = {
      id: orderData.id ? String(orderData.id) : Date.now().toString(), // preserve Railway ID if provided
      rodado: orderData.rodado || "",
      responsable: orderData.responsable || "",
      fechaEntrega: orderData.fechaEntrega || "",
      horario: orderData.horario || "",
      interno: orderData.interno || "",
      clasificacion: orderData.clasificacion || "",
      incidente: orderData.incidente || "",
      syncStatus: "pending", // Always queue for sync immediately on creation
      syncError: null,
      syncDate: null,
      createdAt: new Date().toISOString(),
      tasks: tasks,
      createdBy: orderData.createdBy ? normalizeEmail(orderData.createdBy) : null,
      taxesOrderNumber: null, // Capture from Taxes toast notification
      estadoUnidad: orderData.estadoUnidad || 'operativo',
      combustibleReset: orderData.combustibleReset || null
    };

    db.workOrders.push(newOrder);
    this.write(db);
    return newOrder;
  }

  updateWorkOrder(id, updates) {
    const db = this.read();
    const idx = db.workOrders.findIndex(o => o.id === id);
    if (idx !== -1) {
      const cleanUpdates = { ...updates };
      if (cleanUpdates.createdBy) {
        cleanUpdates.createdBy = normalizeEmail(cleanUpdates.createdBy);
      }
      if (cleanUpdates.tasks) {
        cleanUpdates.tasks = cleanUpdates.tasks.map(t => ({
          ...t,
          descripcion: cleanEncoding(t.descripcion || "")
        }));
      }
      // SAFETY: strip undefined values so they never overwrite existing fields.
      // This prevents partial updates (e.g. local-sync-result with no 'tasks')
      // from wiping the tasks array by spreading { tasks: undefined }.
      Object.keys(cleanUpdates).forEach(key => {
        if (cleanUpdates[key] === undefined) delete cleanUpdates[key];
      });
      db.workOrders[idx] = { ...db.workOrders[idx], ...cleanUpdates };
      this.write(db);
      return db.workOrders[idx];
    }
    return null;
  }

  // --- Active Mechanics Methods ---
  getActiveMechanics() {
    const db = this.read();
    if (!db.activeMechanics || db.activeMechanics.length === 0) {
      return DEFAULT_MECHANICS;
    }
    return db.activeMechanics;
  }

  saveActiveMechanics(list) {
    const db = this.read();
    db.activeMechanics = list || [];
    this.write(db);
    return db.activeMechanics;
  }

  deleteWorkOrder(id) {
    const db = this.read();
    const order = db.workOrders.find(o => o.id === id);
    if (order) {
      order.deleted = true;
      order.deletedAt = new Date().toISOString();
      this.write(db);
    }
    return true;
  }

  deleteWorkOrders(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return true;
    const db = this.read();
    db.workOrders.forEach(o => {
      if (ids.includes(o.id)) {
        o.deleted = true;
        o.deletedAt = new Date().toISOString();
      }
    });
    this.write(db);
    return true;
  }

  purgeSyncedOrders(maxDaysOld = 5) {
    const db = this.read();
    const now = Date.now();
    const thresholdMs = maxDaysOld * 24 * 60 * 60 * 1000;
    const initialCount = db.workOrders.length;

    db.workOrders = db.workOrders.filter(o => {
      // Always keep archived orders (they belong in Historial)
      if (o.archived === true) return true;

      // Keep if not fully synchronized and verified
      if (o.syncStatus !== 'success') return true;
      if (o.verifiedStatus !== 'success') return true;

      const syncTime = o.syncDate ? new Date(o.syncDate).getTime() : new Date(o.createdAt).getTime();
      const ageMs = now - syncTime;

      // Purge if older than threshold
      if (ageMs > thresholdMs) {
        console.log(`[Purge] Removing old synchronized order: OT ${o.interno} (Taxes: ${o.taxesOrderNumber}, Age: ${Math.round(ageMs/3600000)}h)`);
        return false;
      }
      return true;
    });

    if (db.workOrders.length !== initialCount) {
      this.write(db);
      console.log(`[Purge] Database cleared. Orders reduced from ${initialCount} to ${db.workOrders.length}`);
    }
  }

  // --- Odometer Overrides ---
  // Stores manual km/hs corrections keyed by interno (string)
  // that take priority over Google Apps Script cached data.
  getOdometerOverrides() {
    const db = this.read();
    return db.odometerOverrides || {};
  }

  setOdometerOverride(interno, km, hs) {
    const db = this.read();
    if (!db.odometerOverrides) db.odometerOverrides = {};
    const key = String(interno).trim();
    db.odometerOverrides[key] = {
      interno: key,
      km: km !== undefined && km !== '' ? Number(String(km).replace(',', '.')) : undefined,
      hs: hs !== undefined && hs !== '' ? Number(String(hs).replace(',', '.')) : undefined,
      updatedAt: new Date().toISOString()
    };
    this.write(db);
    return db.odometerOverrides[key];
  }

  clearOdometerOverride(interno) {
    const db = this.read();
    if (db.odometerOverrides) {
      delete db.odometerOverrides[String(interno).trim()];
      this.write(db);
    }
  }

  // --- Audit Log for Auto-Deleted Verified Orders ---
  getDeletedOrdersLog() {
    const db = this.read();
    return db.deletedOrdersLog || [];
  }

  saveDeletedOrderLog(entry) {
    const db = this.read();
    if (!db.deletedOrdersLog) db.deletedOrdersLog = [];
    const logItem = {
      id: 'LOG-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
      numeroOrden: entry.numeroOrden || entry.taxesOrderNumber || entry.id || 'N/A',
      interno: entry.interno || 'N/A',
      empleado: entry.empleado || (entry.tasks && entry.tasks[0] ? entry.tasks[0].empleado : 'N/A'),
      horas: entry.horas || (entry.tasks && entry.tasks[0] ? entry.tasks[0].horasEstimadas : '0'),
      descripcion: entry.descripcion || (entry.tasks && entry.tasks[0] ? entry.tasks[0].descripcion : 'N/A'),
      realizada: entry.realizada || 'SI',
      tasks: entry.tasks || [],
      deletedAt: entry.deletedAt || new Date().toISOString(),
      deletedBy: entry.deletedBy || 'Agente de Control'
    };
    db.deletedOrdersLog.push(logItem);
    this.write(db);
    return logItem;
  }
}

module.exports = new LocalDB();
