const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

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
    if (!fs.existsSync(DB_PATH)) {
      this.write(DEFAULT_DB);
    } else {
      // Ensure all root keys exist
      try {
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
      } catch (e) {
        console.error("Error reading database, resetting to default:", e);
        this.write(DEFAULT_DB);
      }
    }
  }

  // Read raw DB contents synchronously to prevent async race conditions in Node event loop
  read() {
    try {
      const content = fs.readFileSync(DB_PATH, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      console.error("Error parsing db.json, returning default structure:", e);
      return JSON.parse(JSON.stringify(DEFAULT_DB));
    }
  }

  // Write contents atomically/synchronously to prevent data corruption
  write(data) {
    try {
      const content = JSON.stringify(data, null, 2);
      fs.writeFileSync(DB_PATH, content, 'utf8');
    } catch (e) {
      console.error("Error writing to db.json:", e);
    }
  }

  // --- Settings Methods ---
  getSettings() {
    const db = this.read();
    return { ...DEFAULT_DB.settings, ...(db.settings || {}) };
  }

  saveSettings(settings) {
    const db = this.read();
    db.settings = { ...db.settings, ...settings };
    this.write(db);
    return db.settings;
  }

  // --- Users Methods ---
  getUser(username) {
    if (!username) return null;
    const db = this.read();
    const key = username.toLowerCase().trim();
    return db.users ? db.users[key] : null;
  }

  saveUser(username, password) {
    if (!username) return null;
    const db = this.read();
    if (!db.users) db.users = {};
    const key = username.toLowerCase().trim();
    db.users[key] = {
      username: username.trim(),
      password: password
    };
    this.write(db);
    return db.users[key];
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
      horasEstimadas: parseFloat(t.horasEstimadas) || 0,
      descripcion: t.descripcion || "",
      status: t.status || "Pendiente", // Pendiente, Finalizada
      timerStart: t.timerStart || null
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
      createdBy: orderData.createdBy || null
    };

    db.workOrders.push(newOrder);
    this.write(db);
    return newOrder;
  }

  updateWorkOrder(id, updates) {
    const db = this.read();
    const idx = db.workOrders.findIndex(o => o.id === id);
    if (idx !== -1) {
      db.workOrders[idx] = { ...db.workOrders[idx], ...updates };
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
