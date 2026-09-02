const fs = require('fs');
const path = require('path');

function genUniqueId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveUsableDbPath() {
  const bundledPath = path.join(__dirname, 'db.json');
  let targetPath = process.env.DB_PATH;
  
  if (!targetPath && process.platform === 'linux') {
    if (fs.existsSync('/data')) {
      targetPath = '/data/db.json';
    } else if (fs.existsSync('/home/cbelocures')) {
      targetPath = '/home/cbelocures/data/db.json';
    }
  }

  if (!targetPath || targetPath === bundledPath) {
    return bundledPath;
  }
  
  try {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const testFile = path.join(dir, `.writable_test_${Date.now()}`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return targetPath;
  } catch (err) {
    console.warn(`[DB] Configured DB_PATH (${targetPath}) is not writable: ${err.message}. Falling back to bundled path: ${bundledPath}`);
    return bundledPath;
  }
}

const DB_PATH = resolveUsableDbPath();

// Mirrors server.js's isHerreria()/isEdilicio() classification checks (duplicated here since
// database.js has no dependency on server.js) - used to keep Taller and Herrería/Edilicio
// orders that happen to share the same generic `interno` (e.g. "REPARACIONES INTERNAS") from
// being merged into one order by getWorkOrders()'s dedup below.
function classifySectorFromClasificacion(clasificacion) {
  const norm = String(clasificacion || '').toLowerCase();
  if (norm.includes('herrer')) return 'Herreria';
  if (norm.includes('edilic')) return 'Edilicio';
  return 'Taller';
}

function normalizeEmail(email) {
  if (!email) return '';
  let normalized = String(email).trim().toLowerCase();
  if (!normalized.includes('@')) {
    normalized += '@contenedoreshugo.com.ar';
  }
  const parts = normalized.split('@');
  if (parts.length !== 2) {
    return normalized;
  }
  let localPart = parts[0];
  let domain = parts[1];

  // Automatically sanitize any paniol25 / ppaniol / panol typos to "paniol"
  if (/^pan[i]?ol\d*$/i.test(localPart) || localPart.includes('paniol25') || localPart.includes('ppaniol')) {
    localPart = 'paniol';
  }

  // Correct any variations of contenedoreshugo or contrnedoreshugo
  if (domain.includes('contenedoreshugo') || domain.includes('contrnedoreshugo')) {
    domain = 'contenedoreshugo.com.ar';
  }
  return `${localPart}@${domain}`;
}

// Turnos: Mañana 06-14, Tarde 14-22, Noche 22-06 (hora de Argentina, sin importar
// en qué timezone corra el servidor).
function getTurnoForDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: 'numeric',
    hour12: false
  }).formatToParts(date);
  const hourPart = parts.find(p => p.type === 'hour');
  const hour = hourPart ? parseInt(hourPart.value, 10) % 24 : date.getHours();
  if (hour >= 6 && hour < 14) return 'Mañana';
  if (hour >= 14 && hour < 22) return 'Tarde';
  return 'Noche';
}

function getDefaultUserPermissions(username, sector) {
  const normUser = normalizeEmail(username || '');
  const isPaniol = normUser.includes('paniol') || normUser.includes('panol') || normUser.includes('pañol') || sector === 'Admin';
  if (isPaniol) {
    return {
      canDelete: true,
      canSync: true,
      canCreateOrder: true,
      canViewSettings: true,
      canViewHistory: true,
      canViewMasivas: true,
      canViewParteTaller: true,
      canViewPreventivos: true,
      canRestoreBackup: true,
      allowedSectors: ['Herrería', 'Edilicio', 'Taller']
    };
  }
  
  // Default for sector users
  const defaultSector = sector || 'Herrería';
  return {
    canDelete: true,
    canSync: true,
    canCreateOrder: true,
    canViewSettings: true,
    canViewHistory: true,
    canViewMasivas: true,
    canViewParteTaller: true,
    canViewPreventivos: true,
    canRestoreBackup: false,
    allowedSectors: [defaultSector]
  };
}

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
    cleanUsername.includes('carmona')
  ) {
    return 'Herrería';
  }
  if (
    cleanUsername.includes('ftoledo') || 
    cleanUsername.includes('toledo')
  ) {
    return 'Edilicio';
  }
  if (
    cleanUsername.includes('sergios') || 
    cleanUsername.includes('taller') ||
    cleanUsername.includes('ibrahim')
  ) {
    return 'Taller';
  }
  return 'Taller';
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
    // Read-only CSV export of the "insumos" tab (a warehouse/pañol sheet fed by another
    // sector, not by this app) - lets us pull withdrawn-parts rows without needing a
    // custom Apps Script endpoint from that sector.
    insumosSheetCsvUrl: "https://docs.google.com/spreadsheets/d/1EsRlEMIKU0P98WP-0gTJ0rn2Tu7Sjf__Re26YQpi7Ow/export?format=csv&gid=1958299152",
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
  users: {},
  insumosPendientes: [],
  preventivosMasivaCustom: []
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
        
        // AUTO-MERGE: Ensure all rodados from bundled db.json exist in active DB
        const bundledPath = path.join(__dirname, 'db.json');
        if (DB_PATH !== bundledPath && fs.existsSync(bundledPath)) {
          try {
            const bundledData = JSON.parse(fs.readFileSync(bundledPath, 'utf8'));
            if (bundledData.catalogs && Array.isArray(bundledData.catalogs.rodados)) {
              if (!data.catalogs) data.catalogs = {};
              if (!Array.isArray(data.catalogs.rodados)) data.catalogs.rodados = [];
              
              const activeMap = new Map();
              data.catalogs.rodados.forEach(ro => {
                if (ro && ro.value) activeMap.set(String(ro.value).trim(), ro);
              });
              
              let mergedCount = 0;
              bundledData.catalogs.rodados.forEach(ro => {
                if (ro && ro.value) {
                  const key = String(ro.value).trim();
                  if (!activeMap.has(key)) {
                    data.catalogs.rodados.push(ro);
                    activeMap.set(key, ro);
                    mergedCount++;
                  }
                }
              });
              
              if (mergedCount > 0) {
                console.log(`[DB] Auto-merged ${mergedCount} missing rodados from bundled db.json into active DB.`);
                changed = true;
              }
            }
          } catch (mergeErr) {
            console.error("[DB] Failed to auto-merge bundled rodados:", mergeErr.message);
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

  // Ultra-fast in-memory cache with atomic disk sync
  read() {
    try {
      if (fs.existsSync(DB_PATH)) {
        const stat = fs.statSync(DB_PATH);
        if (this._memCache && stat.mtimeMs === this._lastMtime) {
          return this._memCache;
        }
        const content = fs.readFileSync(DB_PATH, 'utf8');
        const parsed = JSON.parse(content);
        this._memCache = parsed;
        this._lastMtime = stat.mtimeMs;
        return this._memCache;
      }
    } catch (err) {
      if (this._memCache) return this._memCache;
    }
    this._memCache = JSON.parse(JSON.stringify(DEFAULT_DB));
    return this._memCache;
  }

  // Write contents atomically/synchronously to prevent data corruption
  write(data) {
    try {
      const dir = path.dirname(DB_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const content = JSON.stringify(data, null, 2);
      const tmpPath = DB_PATH + `.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      fs.writeFileSync(tmpPath, content, 'utf8');
      try {
        fs.renameSync(tmpPath, DB_PATH);
      } catch (renameErr) {
        fs.copyFileSync(tmpPath, DB_PATH);
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
    } catch (e) {
      console.error("Error writing to db.json:", e.message);
      try {
        // Direct write fallback if temp file fails
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
      } catch (directErr) {
        throw new Error(`Permisos insuficientes para escribir en ${DB_PATH} (${e.message}).`);
      }
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
    if (!settings.insumosSheetCsvUrl) {
      settings.insumosSheetCsvUrl = DEFAULT_DB.settings.insumosSheetCsvUrl;
    }
    if (!settings.username || String(settings.username).trim() === '') {
      settings.username = "paniol@contenedoreshugo.com.ar";
    } else {
      settings.username = normalizeEmail(settings.username);
    }
    if (!settings.password || String(settings.password).trim() === '') {
      settings.password = "Paniol2015";
    }
    if (settings.autoSyncDisabled === undefined) {
      settings.autoSyncDisabled = false;
    }
    return settings;
  }

  saveSettings(settings) {
    const db = this.read();
    const cleanSettings = { ...settings };
    if (cleanSettings.password && (cleanSettings.password.includes("••") || cleanSettings.password.includes("•"))) {
      delete cleanSettings.password; // Prevent overwriting real password with masked string
    }
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
      ...(db.users[key] || {}),
      username: key,
      password: password !== undefined ? password : (db.users[key] ? db.users[key].password : undefined)
    };
    this.write(db);
    return db.users[key];
  }

  getAllUsers() {
    const db = this.read();
    if (!db.users) db.users = {};

    // "ibrahim@contenedoreshugo.com.ar" was a mistaken duplicate of the real account
    // ("a.brahim@...", Brahim Hugo Adrian) that used to be seeded below - no real person logs
    // in with it, so remove it if an earlier run of this seeding already created it.
    if (db.users['ibrahim@contenedoreshugo.com.ar']) {
      delete db.users['ibrahim@contenedoreshugo.com.ar'];
      this.write(db);
    }

    // Ensure default system users exist in database
    const defaultKnownUsers = [
      'paniol@contenedoreshugo.com.ar',
      'sergios@contenedoreshugo.com.ar',
      'jcarmona@contenedoreshugo.com.ar',
      'ftoledo@contenedoreshugo.com.ar',
      'a.brahim@contenedoreshugo.com.ar'
    ];
    defaultKnownUsers.forEach(email => {
      if (!db.users[email]) {
        db.users[email] = { username: email };
      }
    });

    return Object.keys(db.users).map(key => {
      const u = db.users[key] || {};
      const sector = getSectorByUsername(key);
      const permissions = this.getUserPermissions(key, sector);
      return {
        username: key,
        sector: sector,
        permissions: permissions,
        password: u.password || ""
      };
    });
  }

  getUserPermissions(username, sectorOverride = null) {
    if (!username) return getDefaultUserPermissions('', 'Taller');
    const db = this.read();
    const key = normalizeEmail(username);
    const userObj = db.users ? db.users[key] : null;
    const sector = sectorOverride || getSectorByUsername(key);
    const defaults = getDefaultUserPermissions(key, sector);

    // Admin/Pañol always get full defaults — don't let corrupted DB values override them
    const isPaniol = key.includes('paniol') || key.includes('panol') || key.includes('pañol') || sector === 'Admin';
    if (isPaniol) return defaults;
    
    if (userObj && userObj.permissions && typeof userObj.permissions === 'object') {
      // Normalize stored allowedSectors: replace any corrupted encoding
      let allowedSectors = Array.isArray(userObj.permissions.allowedSectors) ? userObj.permissions.allowedSectors : defaults.allowedSectors;
      allowedSectors = allowedSectors.map(s => {
        const low = String(s).toLowerCase();
        if (low.includes('herrer')) return 'Herrería';
        if (low.includes('edil')) return 'Edilicio';
        if (low.includes('taller')) return 'Taller';
        return s;
      });
      // A Herrería/Edilicio user (identified by their own username, e.g. Toledo/Carmona) must
      // always be able to see their own sector's orders, even if their stored allowedSectors
      // is empty or was saved without it by mistake (e.g. via the Autorizaciones panel) -
      // being locked out of your own work is worse than over-granting a view your role already
      // implies.
      if ((sector === 'Herrería' || sector === 'Edilicio') && !allowedSectors.some(s => s === sector)) {
        allowedSectors = [...allowedSectors, sector];
      }
      return {
        canDelete: userObj.permissions.canDelete !== undefined ? !!userObj.permissions.canDelete : defaults.canDelete,
        canSync: userObj.permissions.canSync !== undefined ? !!userObj.permissions.canSync : defaults.canSync,
        canCreateOrder: userObj.permissions.canCreateOrder !== undefined ? !!userObj.permissions.canCreateOrder : defaults.canCreateOrder,
        canViewSettings: userObj.permissions.canViewSettings !== undefined ? !!userObj.permissions.canViewSettings : defaults.canViewSettings,
        canViewHistory: userObj.permissions.canViewHistory !== undefined ? !!userObj.permissions.canViewHistory : defaults.canViewHistory,
        canViewMasivas: userObj.permissions.canViewMasivas !== undefined ? !!userObj.permissions.canViewMasivas : defaults.canViewMasivas,
        canViewParteTaller: userObj.permissions.canViewParteTaller !== undefined ? !!userObj.permissions.canViewParteTaller : defaults.canViewParteTaller,
        canViewPreventivos: userObj.permissions.canViewPreventivos !== undefined ? !!userObj.permissions.canViewPreventivos : defaults.canViewPreventivos,
        canRestoreBackup: userObj.permissions.canRestoreBackup !== undefined ? !!userObj.permissions.canRestoreBackup : defaults.canRestoreBackup,
        allowedSectors
      };
    }
    return defaults;
  }

  saveUserPermissions(username, permissions) {
    if (!username) return null;
    const db = this.read();
    if (!db.users) db.users = {};
    const key = normalizeEmail(username);
    if (!db.users[key]) {
      db.users[key] = { username: key };
    }
    db.users[key].permissions = permissions;
    this.write(db);
    return db.users[key].permissions;
  }

  normalizeEmail(email) {
    return normalizeEmail(email);
  }

  // --- Parte Taller Methods ---
  // Lives in db.json now instead of a Google Apps Script's PropertiesService.
  // That Sheets-backed store had no real transaction safety (chunked properties
  // with no locking), which is what caused a cascade of data-loss incidents:
  // races between concurrent saves silently produced an "empty" read, and
  // callers that saw that then wrote a blank state right back on top of real
  // data. write() here is atomic (tmp file + rename), so that whole class of
  // bug isn't reachable this way.
  getParteTallerState() {
    const db = this.read();
    return db.parteTallerState || {
      servicios_pendientes: [],
      reparacion: [],
      fuera_de_servicio: [],
      inversiones: [],
      transito: [],
      resumen: { totales: {} }
    };
  }

  saveParteTallerState(state) {
    const db = this.read();
    db.parteTallerState = state;
    this.write(db);
    return state;
  }

  // --- Áreas Edilicio Methods ---
  // Supervisor-maintained list of building areas/sectors (Baño, Oficina, Depósito, etc.) used
  // to split Edilicio work into separate O.T.s per area instead of one big order per building.
  getAreasEdilicio() {
    const db = this.read();
    return Array.isArray(db.areasEdilicio) ? db.areasEdilicio : [];
  }

  addAreaEdilicio(nombre) {
    const clean = String(nombre || '').trim();
    if (!clean) return this.getAreasEdilicio();
    const db = this.read();
    if (!Array.isArray(db.areasEdilicio)) db.areasEdilicio = [];
    const exists = db.areasEdilicio.some(a => a.trim().toLowerCase() === clean.toLowerCase());
    if (!exists) {
      db.areasEdilicio.push(clean);
      this.write(db);
    }
    return db.areasEdilicio;
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
    let incomingRodados = (catalogs.rodados || []).map(ro => ({ ...ro, label: cleanEncoding(ro.label) }));
    
    // Merge rather than overwrite: keep all existing rodados, updating properties of existing ones if they match
    let cleanRodados = [];
    if (incomingRodados.length === 0 && db.catalogs && Array.isArray(db.catalogs.rodados) && db.catalogs.rodados.length > 0) {
      console.log(`[DB] Incoming rodados array empty, preserving existing catalog (${db.catalogs.rodados.length} rodados).`);
      cleanRodados = db.catalogs.rodados;
    } else {
      const rodadosMap = new Map();
      const existingRodados = (db.catalogs && Array.isArray(db.catalogs.rodados)) ? db.catalogs.rodados : [];
      
      // Populate map with existing items first
      existingRodados.forEach(ro => {
        if (ro && ro.value) rodadosMap.set(String(ro.value).trim(), ro);
      });
      
      // Merge/overwrite with incoming items
      incomingRodados.forEach(ro => {
        if (ro && ro.value) rodadosMap.set(String(ro.value).trim(), ro);
      });
      
      cleanRodados = Array.from(rodadosMap.values());
      console.log(`[DB] Merged incoming catalogs: went from ${existingRodados.length} to ${cleanRodados.length} total rodados.`);
    }
    const cleanResponsables = (catalogs.responsables && catalogs.responsables.length > 0) 
      ? catalogs.responsables.map(r => ({ ...r, label: cleanEncoding(r.label) })) 
      : ((db.catalogs && db.catalogs.responsables) || []);
    const cleanIncomingEmps = (catalogs.empleados && catalogs.empleados.length > 0) 
      ? catalogs.empleados.map(e => ({ ...e, label: cleanEncoding(e.label) }))
      : ((db.catalogs && db.catalogs.empleados) || []);
    
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
      centrosCosto: (catalogs.centrosCosto && catalogs.centrosCosto.length > 0) ? catalogs.centrosCosto : ((db.catalogs && db.catalogs.centrosCosto) || [])
    };
    this.write(db);
    return db.catalogs;
  }

  getSyncableOrders() {
    const db = this.read();
    return (db.workOrders || []).filter(o => o.deleted !== true);
  }

  // --- Work Orders Methods ---
  // Returns ACTIVE (non-archived) orders only — strictly deduplicated by internal ID ('interno')
  // plus sector plus clasificación, or 'id'. Two orders can share the same generic `interno`
  // (e.g. "REPARACIONES INTERNAS") while genuinely belonging to different sectors (Taller vs
  // Herrería/Edilicio) - those must stay separate order cards, each with its own OT number, not
  // merged into one. Clasificación is part of the key for the same reason: a real vehicle can
  // have an Auxilio job AND a separate Correctivo job open at once for the same interno - those
  // are two distinct OTs in Taxes, not one, and merging them made editing/deleting a task from
  // one silently no-op if that task actually lived in the other (it kept reappearing on every
  // refresh, since the merge just re-combined it back in from the untouched sibling order).
  getWorkOrders() {
    const db = this.read();
    const active = (db.workOrders || []).filter(o => !o.archived && o.deleted !== true);

    // Strict deduplication map
    const uniqueMap = new Map();
    active.forEach(order => {
      // Área must be part of this key: Edilicio can have several genuinely separate open
      // orders for the same building (one per área), and without área here they all share
      // the same interno+sector+clasificacion and got wrongly folded into a single card,
      // silently dumping every área's tasks into whichever order was created first.
      const key = order.interno
        ? `${String(order.interno).trim().toLowerCase()}::${classifySectorFromClasificacion(order.clasificacion)}::${String(order.clasificacion || '').trim().toLowerCase()}::${String(order.area || '').trim().toLowerCase()}`
        : String(order.id);
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, { ...order, tasks: [...(order.tasks || [])] });
      } else {
        // Merge tasks into existing order card to prevent duplicate UI cards
        const existing = uniqueMap.get(key);
        const existingTaskIds = new Set((existing.tasks || []).map(t => t.id || (t.empleado + '-' + t.descripcion)));
        (order.tasks || []).forEach(t => {
          const tKey = t.id || (t.empleado + '-' + t.descripcion);
          if (!existingTaskIds.has(tKey)) {
            existing.tasks.push(t);
            existingTaskIds.add(tKey);
          }
        });
      }
    });
    return Array.from(uniqueMap.values());
  }

  // Returns ARCHIVED orders only — used by the History/Historial section
  getArchivedOrders() {
    const db = this.read();
    return (db.workOrders || []).filter(o => o.archived === true && o.deleted !== true);
  }

  // Returns ARCHIVED orders with pagination — prevents browser freezing when history has 500+ orders
  getArchivedOrdersPaginated(page = 1, limit = 50) {
    const db = this.read();
    const archived = (db.workOrders || []).filter(o => o.archived === true && o.deleted !== true);
    archived.sort((a, b) => new Date(b.archivedAt || b.createdAt || 0) - new Date(a.archivedAt || a.createdAt || 0));
    
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, parseInt(limit) || 50);
    const startIndex = (pageNum - 1) * limitNum;
    const paginated = archived.slice(startIndex, startIndex + limitNum);
    return {
      total: archived.length,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(archived.length / limitNum) || 1,
      orders: paginated
    };
  }

  // Auto-archives 100% finished orders ONLY if they have a valid Taxes OT number (taxesOrderNumber)
  autoArchiveStaleFinishedOrders() {
    const db = this.read();
    let count = 0;

    (db.workOrders || []).forEach(order => {
      if (!order.archived && order.deleted !== true && order.estadoUnidad !== 'fuera_de_servicio') {
        const hasOtNumber = order.taxesOrderNumber && String(order.taxesOrderNumber).trim() !== '';
        const tasks = order.tasks || [];
        const allSynced = tasks.length > 0 && tasks.every(t => t && t.synced === true);
        const isOperativo = order.estadoUnidad === 'operativo';
        
        // STRICT RULE: Must be OPERATIVO + valid Taxes OT + 100% tasks finished + 100% tasks synced + NOT manually unarchived!
        if (hasOtNumber && isCompleted && allSynced && isOperativo && !isManuallyUnarchived) {
          order.archived = true;
          order.archivedAt = order.archivedAt || new Date().toISOString();
          count++;
        }
      }
    });

    if (count > 0) {
      console.log(`[DB Safeguard] Auto-archived ${count} completed orders with valid Taxes OT numbers to Historial.`);
      this.write(db);
    }
    return count;
  }

  getWorkOrderById(id) {
    // Search across all orders (active + archived)
    const db = this.read();
    return (db.workOrders || []).find(o => o.id === id);
  }

  // Soft-archive an order: marks it as archived ONLY if it has a valid Taxes OT number
  archiveWorkOrder(id) {
    const db = this.read();
    const order = db.workOrders.find(o => o.id === id);
    if (!order) return false;
    
    // STRICT RULE: Order MUST have a valid Taxes OT number to be archived to Historial!
    if (!order.taxesOrderNumber || String(order.taxesOrderNumber).trim() === '') {
      console.warn(`[DB] Order ${id} cannot be archived: missing assigned Taxes OT number.`);
      return false;
    }
    
    order.archived = true;
    order.archivedAt = new Date().toISOString();
    // A deliberate manual (re-)archive supersedes any earlier manual un-archive.
    order.unarchivedManually = false;
    this.write(db);
    return true;
  }

  createWorkOrder(orderData) {
    const db = this.read();
    const targetInterno = orderData.interno ? String(orderData.interno).trim() : null;
    
    const tasks = (orderData.tasks || []).map((t, idx) => ({
      id: t.id || genUniqueId(),
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
      id: orderData.id ? String(orderData.id) : genUniqueId(), // preserve Railway ID if provided
      rodado: orderData.rodado || "",
      responsable: orderData.responsable || "",
      fechaEntrega: orderData.fechaEntrega || "",
      horario: orderData.horario || "",
      interno: orderData.interno || "",
      clasificacion: orderData.clasificacion || "",
      incidente: orderData.incidente || "",
      syncStatus: orderData.syncStatus || "pending",
      syncError: orderData.syncError || null,
      syncDate: orderData.syncDate || null,
      createdAt: orderData.createdAt || new Date().toISOString(),
      tasks: tasks,
      createdBy: orderData.createdBy ? normalizeEmail(orderData.createdBy) : null,
      taxesOrderNumber: orderData.taxesOrderNumber || null,
      estadoUnidad: orderData.estadoUnidad || 'operativo',
      combustibleReset: orderData.combustibleReset || null,
      sector: orderData.sector || null,
      // Which area/room of the building this Edilicio order is for (Baño, Oficina, etc.) - lets
      // the same interno (building) hold several separate open O.T.s at once, one per area,
      // instead of every Edilicio job for that building merging into a single order.
      area: orderData.area || null,
      // Flagged from Parte Taller's "Agregar/Editar Unidad" switch when the supervisor knows
      // Elastiquero still has to log its own tasks on this same job, possibly after the unit
      // already went back to Operativo - lets Elastiquero find and reopen THIS exact order later
      // instead of guessing by a time window or creating a disconnected duplicate.
      pendingElastiquero: !!orderData.pendingElastiquero,
      archived: !!orderData.archived,
      deleted: !!orderData.deleted,
      deletedAt: orderData.deletedAt || null
    };

    db.workOrders.push(newOrder);
    this.write(db);
    // Save backup snapshot automatically
    this.saveBackupSnapshot(newOrder);
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

      // PERMANENT OT GUARANTEE: Never erase an existing taxesOrderNumber from a routine/partial
      // update! Once assigned, it stays - UNLESS the caller explicitly asks to clear it via
      // forceClearTaxesNumber (used by POST /api/orders/:id/reset-taxes-number, whose entire
      // purpose is to deliberately wipe a stale/deleted-in-Taxes OT so a fresh one gets created;
      // without this escape hatch that endpoint silently did nothing).
      const explicitTaxesNumberClear = cleanUpdates.forceClearTaxesNumber === true;
      delete cleanUpdates.forceClearTaxesNumber;
      if (!explicitTaxesNumberClear && db.workOrders[idx].taxesOrderNumber && (!cleanUpdates.taxesOrderNumber || String(cleanUpdates.taxesOrderNumber).trim() === '')) {
        delete cleanUpdates.taxesOrderNumber;
      }

      const explicitArchiveOverride = Object.prototype.hasOwnProperty.call(cleanUpdates, 'archived');
      db.workOrders[idx] = { ...db.workOrders[idx], ...cleanUpdates };

      // Auto-archive to Historial once every task is both Finalizada/Completada AND already
      // synced to Taxes, and the unit is back in service. syncWorker.js/railway_sync_agent.js
      // update orders directly through this method (not through server.js's PUT /api/orders/:id,
      // which has its own copy of this same rule for manual edits) - without checking it here
      // too, an order synced entirely in the background could sit "done" forever and never move
      // to Historial. Skipped when this call itself explicitly sets `archived` (a manual
      // archive/unarchive action, or the PUT route's own computed value) - that always wins.
      if (!explicitArchiveOverride) {
        const o = db.workOrders[idx];
        const tasks = o.tasks || [];
        const allDoneAndSynced = tasks.length > 0 && tasks.every(t => t && (t.status === 'Finalizada' || t.status === 'Completada') && t.synced === true);
        // unarchivedManually is set by the manual "un-archive" action (PATCH .../unarchive) so a
        // user can pull an order back out of Historial to fix something - without checking it
        // here, the very next background save (syncWorker/railway_sync_agent, or even just an
        // unrelated field update) saw the same already-synced tasks and immediately sent it
        // right back to Historial, since nothing else in this codebase ever read this flag.
        if (!o.archived && !o.deleted && !o.unarchivedManually && o.estadoUnidad !== 'fuera_de_servicio' && allDoneAndSynced) {
          o.archived = true;
          o.archivedAt = o.archivedAt || new Date().toISOString();
        }
      }

      this.write(db);
      // Save backup snapshot automatically on every meaningful update
      this.saveBackupSnapshot(db.workOrders[idx]);
      return db.workOrders[idx];
    }
    return null;
  }

  cleanDuplicateTasksInActiveOrders() {
    const db = this.read();
    let cleanedCount = 0;
    (db.workOrders || []).forEach(order => {
      if (!order.deleted && !order.archived && Array.isArray(order.tasks) && order.tasks.length > 0) {
        // NOTE: this used to also run three hardcoded, interno-specific filters here (112, 158,
        // 155) that deleted any task NOT matching a specific description substring, replacing
        // an empty result with a single synthetic placeholder task. Those were one-off fixes for
        // a specific historical data problem, but this whole function runs automatically on
        // EVERY server startup (see the "Auto-clean duplicate tasks" call in server.js) - so
        // they kept permanently wiping out any *new*, real task added later for those same
        // internos on every restart/redeploy (confirmed: this deleted a running-timer task for
        // Ojeda Fernández, Miguel on Interno 158). Removed - a one-off cleanup belongs in a
        // one-off script, never in code that runs unconditionally on every boot.

        // Generic deduplication by clean description + employee
        const seen = new Set();
        const cleanTasks = [];
        (order.tasks || []).forEach(t => {
          if (!t) return;
          const key = `${String(t.empleado || '').trim().toLowerCase()}_${String(t.descripcion || '').trim().toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            cleanTasks.push(t);
          }
        });

        if (cleanTasks.length !== order.tasks.length) {
          order.tasks = cleanTasks;
          cleanedCount++;
        }
      }
    });

    if (cleanedCount > 0) {
      console.log(`[DB Auto-Clean] Deduplicated tasks across ${cleanedCount} active orders.`);
      this.write(db);
    }
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

  setServiceOverride(interno, km, hs) {
    const db = this.read();
    if (!db.odometerOverrides) db.odometerOverrides = {};
    const key = String(interno).trim();
    if (!db.odometerOverrides[key]) {
      db.odometerOverrides[key] = { interno: key };
    }
    const val = Number(String(km || hs || 0).replace(',', '.'));
    db.odometerOverrides[key].ultServiceKm = val;
    db.odometerOverrides[key].ultServiceHs = val;
    db.odometerOverrides[key].updatedAt = new Date().toISOString();
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

  clearAllOdometerOverrides() {
    const db = this.read();
    db.odometerOverrides = {};
    this.write(db);
  }

  // --- Insumos retirados (warehouse withdrawals) pending supervisor approval ---
  // Fed from a read-only CSV export of a sheet maintained by another sector (the
  // warehouse/pañol) - this app never writes to that sheet, only tracks approval
  // state locally, keyed by the sheet's own "id egreso".
  getInsumosPendientes() {
    const db = this.read();
    return db.insumosPendientes || [];
  }

  // Adds any rows not already tracked (matched by idEgreso), tagging each new one with
  // the turno computed from the moment we first saw it (the source sheet has no
  // timestamp column of its own).
  upsertInsumosFromRows(rows) {
    const db = this.read();
    if (!Array.isArray(db.insumosPendientes)) db.insumosPendientes = [];
    const existingIds = new Set(db.insumosPendientes.map(i => i.idEgreso));
    const now = new Date();
    let added = 0;
    (rows || []).forEach(row => {
      if (!row || !row.idEgreso || existingIds.has(row.idEgreso)) return;
      db.insumosPendientes.push({
        idEgreso: row.idEgreso,
        otTaxes: row.otTaxes || '',
        interno: row.interno || '',
        material: row.material || '',
        cantidad: row.cantidad || '',
        operario: row.operario || '',
        turno: getTurnoForDate(now),
        estado: 'pendiente',
        aprobadoPor: null,
        fechaDetectado: now.toISOString(),
        fechaResolucion: null
      });
      existingIds.add(row.idEgreso);
      added++;
    });
    if (added > 0) this.write(db);
    return added;
  }

  resolveInsumoPendiente(idEgreso, estado, aprobadoPor) {
    const db = this.read();
    if (!Array.isArray(db.insumosPendientes)) return null;
    const item = db.insumosPendientes.find(i => i.idEgreso === idEgreso);
    if (!item) return null;
    item.estado = estado;
    item.aprobadoPor = aprobadoPor;
    item.fechaResolucion = new Date().toISOString();
    this.write(db);
    return item;
  }

  // --- Preventivos custom de Carga Masiva ---
  // Definidos a mano por el usuario (nombre + sector + si necesita su propia hoja de
  // control en Google Sheets), se suman a los 10 tipos fijos como botones permanentes.
  getPreventivosMasivaCustom() {
    const db = this.read();
    return db.preventivosMasivaCustom || [];
  }

  addPreventivoMasivaCustom({ label, sector, necesitaHoja }) {
    const db = this.read();
    if (!Array.isArray(db.preventivosMasivaCustom)) db.preventivosMasivaCustom = [];
    const cleanLabel = String(label || '').trim();
    if (!cleanLabel) throw new Error('El nombre del preventivo no puede estar vacío.');

    const slugBase = cleanLabel
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'preventivo';
    let key = slugBase;
    let suffix = 1;
    const existingKeys = new Set(db.preventivosMasivaCustom.map(p => p.key));
    while (existingKeys.has(key)) {
      suffix++;
      key = `${slugBase}_${suffix}`;
    }

    const item = {
      key,
      label: cleanLabel,
      sector: sector || 'Mecanica',
      necesitaHoja: !!necesitaHoja,
      hoja: necesitaHoja ? cleanLabel : null,
      createdAt: new Date().toISOString()
    };
    db.preventivosMasivaCustom.push(item);
    this.write(db);
    return item;
  }

  // Permite corregir un preventivo custom ya creado - en particular necesitaHoja, por si al
  // crearlo se olvidaron de tildar "Necesita seguimiento en la Hoja de Controles" y quedo sin
  // columna ni hoja asignada.
  updatePreventivoMasivaCustom(key, { label, sector, necesitaHoja } = {}) {
    const db = this.read();
    if (!Array.isArray(db.preventivosMasivaCustom)) db.preventivosMasivaCustom = [];
    const item = db.preventivosMasivaCustom.find(p => p.key === key);
    if (!item) throw new Error('Preventivo no encontrado.');

    if (label !== undefined) {
      const cleanLabel = String(label || '').trim();
      if (!cleanLabel) throw new Error('El nombre del preventivo no puede estar vacío.');
      item.label = cleanLabel;
    }
    if (sector !== undefined) {
      const cleanSector = String(sector || '').trim();
      if (!cleanSector) throw new Error('Sector inválido.');
      item.sector = cleanSector;
    }
    if (necesitaHoja !== undefined) {
      item.necesitaHoja = !!necesitaHoja;
      item.hoja = item.necesitaHoja ? (item.hoja || item.label) : item.hoja;
    }
    this.write(db);
    return item;
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

  // ─── 7-DAY ROLLING BACKUP ────────────────────────────────────────────────────

  saveBackupSnapshot(order) {
    if (!order || !order.id) return;
    const db = this.read();
    if (!db.backupOrders) db.backupOrders = {};

    // Prune old entries first (entries older than 7 days, one by one)
    this.pruneBackupOrders(db);

    // Store the latest snapshot keyed by order ID
    db.backupOrders[order.id] = {
      ...order,
      _backupAt: new Date().toISOString()
    };

    this.write(db);
  }

  pruneBackupOrders(dbArg) {
    const db = dbArg || this.read();
    if (!db.backupOrders) return;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const key of Object.keys(db.backupOrders)) {
      const entry = db.backupOrders[key];
      const backupTime = entry._backupAt ? new Date(entry._backupAt).getTime() : 0;
      const createdTime = entry.createdAt ? new Date(entry.createdAt).getTime() : 0;
      // Use the oldest of createdAt vs _backupAt — prune when createdAt is older than 7 days
      if (createdTime && createdTime < sevenDaysAgo) {
        delete db.backupOrders[key];
        pruned++;
      }
    }
    if (pruned > 0 && !dbArg) this.write(db);
    return pruned;
  }

  getBackupOrders() {
    const db = this.read();
    if (!db.backupOrders) return [];
    return Object.values(db.backupOrders).sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta; // newest first
    });
  }

  restoreFromBackup(orderId) {
    const db = this.read();
    if (!db.backupOrders || !db.backupOrders[orderId]) return null;
    const snapshot = { ...db.backupOrders[orderId] };
    delete snapshot._backupAt;

    // Restore: undelete, unarchive, reset sync to success if it has a Taxes number
    snapshot.deleted = false;
    snapshot.deletedAt = null;
    snapshot.archived = false;
    snapshot.archivedAt = null;
    if (!snapshot.syncStatus || snapshot.syncStatus === 'pending' || snapshot.syncStatus === 'syncing') {
      if (snapshot.taxesOrderNumber) {
        snapshot.syncStatus = 'success';
      }
    }

    // Upsert into workOrders
    const idx = db.workOrders.findIndex(o => o.id === orderId);
    if (idx !== -1) {
      db.workOrders[idx] = snapshot;
    } else {
      db.workOrders.push(snapshot);
    }
    this.write(db);
    return snapshot;
  }

  hasDuplicateActiveOrder(interno, clasificacion, sector = 'Taller', excludeOrderId = null) {
    if (sector !== 'Taller') return false;
    const db = this.read();
    const cleanInt = String(interno || '').trim().toUpperCase();
    const cleanClas = String(clasificacion || '').trim().toUpperCase();
    if (!cleanInt || !cleanClas) return false;

    return (db.workOrders || []).some(o => {
      if (o.archived || o.deleted === true) return false;
      if (excludeOrderId && String(o.id) === String(excludeOrderId)) return false;
      const orderSector = o.sector || getSectorByUsername(o.createdBy) || 'Taller';
      if (orderSector !== 'Taller') return false;
      const oInt = String(o.interno || '').trim().toUpperCase();
      const oClas = String(o.clasificacion || '').trim().toUpperCase();
      return oInt === cleanInt && oClas === cleanClas;
    });
  }

  canOrderBeArchived(order) {
    if (!order) return false;
    if (order.estadoUnidad !== 'operativo') return false;
    if (order.fuera_de_servicio === true) return false;
    const tasks = Array.isArray(order.tasks) ? order.tasks : [];
    if (tasks.length === 0) return false;
    return tasks.every(t => t.synced === true);
  }

  autoPauseWorkerActiveTasks(employeeName, newOrderId = null, newTaskId = null) {
    if (!employeeName) return null;
    const db = this.read();
    const cleanEmp = String(employeeName).trim().toLowerCase();
    let autoPausedInfo = null;

    (db.workOrders || []).forEach(o => {
      if (o.archived || o.deleted === true) return;
      (o.tasks || []).forEach((t, idx) => {
        if (!t) return;
        if (String(o.id) === String(newOrderId) && String(idx) === String(newTaskId)) return;
        const taskEmp = String(t.empleado || '').trim().toLowerCase();
        if (taskEmp === cleanEmp && (t.timerStarted || t.timerStart > 0)) {
          const now = Date.now();
          const elapsed = t.timerStart > 0 ? (now - t.timerStart) : 0;
          t.timerStarted = false;
          t.timerStart = 0;
          t.accumulatedTime = (t.accumulatedTime || 0) + elapsed;
          if (!t.timerHistory) t.timerHistory = [];
          t.timerHistory.push({ action: 'pause', timestamp: new Date().toISOString(), autoPaused: true });
          if (t.accumulatedTime > 0) {
            t.horasEstimadas = Math.round((t.accumulatedTime / (1000 * 60 * 60)) * 100) / 100;
          }
          autoPausedInfo = { orderId: o.id, interno: o.interno || 'Unidad', taskIndex: idx, taskDesc: t.descripcion };
          console.log(`[AutoPause] Paused active task for employee "${employeeName}" in Order Interno ${o.interno}`);
        }
      });
    });

    if (autoPausedInfo) {
      this.write(db);
    }
    return autoPausedInfo;
  }
}

module.exports = new LocalDB();
module.exports.getTurnoForDate = getTurnoForDate;
module.exports.genUniqueId = genUniqueId;
// Exposed so other modules that need to persist alongside db.json (e.g. the Carga Masiva
// controles excel) write to the same durable volume instead of the bundled code directory,
// which gets replaced wholesale on every deploy.
module.exports.DB_PATH = DB_PATH;
