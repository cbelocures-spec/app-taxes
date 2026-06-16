const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.json');

function normalizeEmail(email) {
  if (!email) return email;
  let normalized = String(email).trim().toLowerCase();
  // Correct common domain spelling mistakes
  normalized = normalized.replace('@contrnedoreshugo.com.ar', '@contenedoreshugo.com.ar');
  normalized = normalized.replace('@contenedoreshugo.com.a', '@contenedoreshugo.com.ar');
  normalized = normalized.replace('@contenedoreshugo.co.ar', '@contenedoreshugo.com.ar');
  normalized = normalized.replace('@contenedoreshugo.com.ar.', '@contenedoreshugo.com.ar');
  return normalized;
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
    googleScriptUrl: "",
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
        this.write(DEFAULT_DB);
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
    return db.catalogs || DEFAULT_DB.catalogs;
  }

  saveCatalogs(catalogs) {
    const db = this.read();
    
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
    
    const incomingEmps = catalogs.empleados || [];
    const mergedEmps = [...incomingEmps];
    for (const cEmp of customEmps) {
      if (!mergedEmps.some(e => String(e.value).toLowerCase() === cEmp.value.toLowerCase())) {
        mergedEmps.push(cEmp);
      }
    }

    db.catalogs = {
      rodados: catalogs.rodados || [],
      responsables: catalogs.responsables || [],
      empleados: mergedEmps,
      centrosCosto: catalogs.centrosCosto || []
    };
    this.write(db);
    return db.catalogs;
  }

  // --- Work Orders Methods ---
  getWorkOrders() {
    const db = this.read();
    return db.workOrders || [];
  }

  getWorkOrderById(id) {
    const orders = this.getWorkOrders();
    return orders.find(o => o.id === id);
  }

  createWorkOrder(orderData) {
    const db = this.read();
    
    const tasks = (orderData.tasks || []).map((t, idx) => ({
      id: t.id || `${Date.now()}-${idx}`,
      centroCosto: t.centroCosto || "",
      empleado: t.empleado || "",
      horasEstimadas: parseFloat(String(t.horasEstimadas).replace(',', '.')) || 0,
      descripcion: t.descripcion || "",
      status: t.status || "Pendiente", // Pendiente, Finalizada
      timerStart: t.timerStart || null,
      timerStarted: t.timerStarted === true || t.timerStarted === 'true',
      timerHistory: Array.isArray(t.timerHistory) ? t.timerHistory : []
    }));

    // If any task is "Pendiente" or there are no tasks, keep it "local" (do not sync yet)
    const allCompleted = tasks.length > 0 && tasks.every(t => t.status === "Finalizada");

    // Create new Work Order object with defaults
    const newOrder = {
      id: Date.now().toString(), // local unique ID
      rodado: orderData.rodado || "",
      responsable: orderData.responsable || "",
      fechaEntrega: orderData.fechaEntrega || "",
      horario: orderData.horario || "",
      interno: orderData.interno || "",
      clasificacion: orderData.clasificacion || "",
      incidente: orderData.incidente || "",
      syncStatus: "local",
      syncError: null,
      syncDate: null,
      createdAt: new Date().toISOString(),
      tasks: tasks,
      createdBy: orderData.createdBy ? normalizeEmail(orderData.createdBy) : null
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
    const filtered = db.workOrders.filter(o => o.id !== id);
    db.workOrders = filtered;
    this.write(db);
    return true;
  }
}

module.exports = new LocalDB();
