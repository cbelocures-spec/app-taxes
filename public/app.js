
// Must match APP_VERSION in server.js and the ?v= on index.html's <script src="app.js">.
// A tab left open from before a deploy keeps running this old code in memory forever —
// no request it makes on its own would ever notice the backend moved on. This is what
// let a stale tab's outdated window._ptState wipe the Parte Taller sheet again even
// after the fix had already shipped. Polling and reloading closes that gap.
const CURRENT_APP_VERSION = '152';

function startAppVersionWatch() {
  setInterval(async () => {
    try {
      const res = await fetch('/api/app-version');
      const data = await res.json();
      if (data && data.version && data.version !== CURRENT_APP_VERSION) {
        console.warn(`[AppVersion] Nueva versión detectada (${data.version} != ${CURRENT_APP_VERSION}). Recargando...`);
        window.location.reload();
      }
    } catch (e) {
      // Silencioso: fallas de red transitorias no deben interrumpir el trabajo.
    }
  }, 60000);
}

function getEstimatedTaskHoursMax(taskText, mechanicName) {
  const txt = (taskText || '').toLowerCase();
  
  // 1. Piso de cabina, Chapería y Soldaduras pesadas (Empírico P90: 6.5 a 7.0 hs)
  if (txt.includes('piso') || txt.includes('cabina') || txt.includes('soldar soporte') || txt.includes('soldadura')) {
    return '6.5 hs (Máx DB)';
  }

  // 2. Bombas hidráulicas y Embragues completos (Empírico P90: 4.5 hs)
  if (txt.includes('bomba') || txt.includes('embrague') || txt.includes('diferencial') || txt.includes('caja')) {
    return '4.5 hs (Máx DB)';
  }

  // 3. Pistones y Cilindros hidráulicos (Empírico P90: 4.0 hs)
  if (txt.includes('piston') || txt.includes('pistón') || txt.includes('cilindro')) {
    return '4.0 hs (Máx DB)';
  }

  // 4. Mangueras, Frenos, Elásticos y Dirección (Empírico P90: 3.5 hs)
  if (txt.includes('manguera') || txt.includes('freno') || txt.includes('elastico') || txt.includes('elástico') || txt.includes('direccion') || txt.includes('dirección')) {
    return '3.5 hs (Máx DB)';
  }

  // 5. Pérdidas de Gasoil, Motores de Arranque y Alternadores (Empírico P90: 3.0 hs)
  if (txt.includes('gasoil') || txt.includes('arranque') || txt.includes('alternador') || txt.includes('inyeccion') || txt.includes('inyector')) {
    return '3.0 hs (Máx DB)';
  }

  // 6. Luces, Faros, Bocinas, Vigías y Engrase (Empírico P90: 2.0 hs)
  if (txt.includes('luz') || txt.includes('luces') || txt.includes('faro') || txt.includes('bocina') || txt.includes('vigia') || txt.includes('vigía') || txt.includes('engrase')) {
    return '2.0 hs (Máx DB)';
  }

  return '3.5 hs (Máx DB)';
}

// ---- Helper functions (mirror of server-side helpers) ----
function isHerreria(cls) {
  if (!cls) return false;
  const norm = String(cls).toLowerCase().trim();
  return norm.includes('herrer');
}
function isEdilicio(cls) {
  if (!cls) return false;
  const norm = String(cls).toLowerCase().trim();
  return norm.includes('edil');
}

// Intercept fetch to automatically include supervisor username header and handle 401s
const originalFetch = window.fetch;
window.fetch = async function(url, options = {}) {
  options.headers = options.headers || {};
  if (options.headers instanceof Headers) {
    options.headers.set('bypass-tunnel-reminder', 'true');
    options.headers.set('ngrok-skip-browser-warning', 'true');
  } else {
    options.headers['bypass-tunnel-reminder'] = 'true';
    options.headers['ngrok-skip-browser-warning'] = 'true';
  }
  const username = localStorage.getItem('currentUserUsername');
  if (username) {
    if (options.headers instanceof Headers) {
      options.headers.set('X-User-Username', username);
    } else {
      options.headers['X-User-Username'] = username;
    }
  }
  const usuarioLogueadoStr = localStorage.getItem('usuarioLogueado');
  if (usuarioLogueadoStr) {
    try {
      const uObj = JSON.parse(usuarioLogueadoStr);
      if (uObj && uObj.permisos) {
        if (options.headers instanceof Headers) {
          options.headers.set('X-User-Permissions', JSON.stringify(uObj.permisos));
        } else {
          options.headers['X-User-Permissions'] = JSON.stringify(uObj.permisos);
        }
      }
    } catch(e) {}
  }
  try {
    const response = await originalFetch(url, options);
    
    // If server returns 401 and it's not a login request, check if we can auto-login
    if (response.status === 401 && !url.includes('/api/login')) {
      const savedPassword = localStorage.getItem('currentUserPassword');
      if (savedPassword && username) {
        console.warn('Session invalid or expired (401 from server). Attempting automatic background re-login...');
        try {
          const loginRes = await originalFetch('/api/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'bypass-tunnel-reminder': 'true',
              'ngrok-skip-browser-warning': 'true'
            },
            body: JSON.stringify({ username, password: savedPassword })
          });
          if (loginRes.ok) {
            console.log('Background re-login successful. Retrying original request...');
            // Retry the original request
            return await originalFetch(url, options);
          }
        } catch (loginErr) {
          console.error('Background re-login failed:', loginErr);
        }
      }
      
      console.warn('Could not recover session. Logging out...');
      localStorage.setItem('userExplicitlyLoggedOut', '1');
      localStorage.removeItem('currentUserUsername');
      localStorage.removeItem('currentUserPassword');
      checkUserSession();
      showToast("Su sesión ha expirado o el servidor se reinició. Por favor, inicie sesión de nuevo.", "danger");
    }
    return response;
  } catch (err) {
    throw err;
  }
};

// Global State
let cachedCatalogs = { rodados: [], responsables: [], empleados: [], centrosCosto: [] };
let cachedInternoOptions = [];
let cachedAreasEdilicio = [];
let cachedNovelties = [];
let activeOrders = [];
// Task ids with an optimistic dashboard change (pause/resume/finish) whose PUT save is still
// in flight. The background 2s poll (fetchOrders) can otherwise land between the optimistic
// local update and the server actually persisting it, momentarily overwriting the just-paused
// (or just-finished) task with the server's still-stale pre-save state - which looks like the
// task "resumed on its own". fetchOrders() keeps the local version for any id listed here.
let pendingOptimisticTaskIds = new Set();
let currentRetryOrderId = null;
let currentEditingOrderId = null;
// Real (already-saved) task IDs removed from the modal during this edit session. removeTaskField()
// only takes the card out of the DOM — without tracking this separately and sending it as
// deletedTaskIds, the server's task-merge logic (which preserves every existing task unless its id
// is explicitly listed as deleted) silently restores "deleted" tasks on save.
let deletedTaskIdsInModal = new Set();
let catalogSyncInterval = null;
let activeMechanicsList = [];
let selectedOrderIds = new Set();
let selectedHistoryOrderIds = new Set();
let isCurrentUserSupervisor = false;
let editModalHasRenderingError = false;
let currentSelectedSector = 'Taller';

const MECANICA_EMPLOYEES = [
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

const HERRERIA_EMPLOYEES = [
  "Arando Quispe, Atanacio Félix",
  "Banegas, Matías Ezequiel",
  "Carmona González, Juan Manuel",
  "García, Yamandú Liborio",
  "GIMENEZ DEOLINDO EMANUEL",
  "Gonzalez Nicolas Maximiliano",
  "Lara Gustavo",
  "LUNA AGUSTIN",
  "Medina Daniel",
  "Montiel, Víctor David",
  "Peñalva, Cristian Germán",
  "Romero, Juan Manuel",
  "Victor Lizarraga",
  "Federico",
  "Luciano",
  ];

const EDILICIO_EMPLOYEES = [
  "Orosco, Damian Agustin",
  "RODRIGUEZ CARLOS FERNANDO"
];

// Mirrors syncWorker.js's CREATOR_USERNAME_TO_RESPONSABLE - used here only to pre-select the
// "Responsable" dropdown with whoever is logged in, so the field shows the right name instead
// of blank/whatever was left over from a previous order.
const CREATOR_USERNAME_TO_RESPONSABLE = {
  'jcarmona@contenedoreshugo.com.ar': 'Carmona González, Juan Manuel',
  'a.brahim@contenedoreshugo.com.ar': 'Brahim, Hugo Adrian',
  'sergios@contenedoreshugo.com.ar': 'Schirripa, Sergio Ricardo',
  'n.rodriguez@contenedoreshugo.com.ar': 'RODRIGUEZ NICOLAS',
  'paniol@contenedoreshugo.com.ar': 'Belocures, Cesar Hernán'
};

function getSectorEmployees(sector) {
  const isHerreria = (sector === 'Herrería');
  const isEdilicio = (sector === 'Edilicio');
  const baseDefaults = isHerreria
    ? [...HERRERIA_EMPLOYEES, "Federico", "Luciano", "Digno"]
    : isEdilicio
      ? [...EDILICIO_EMPLOYEES]
      : [...MECANICA_EMPLOYEES];

  const mapped = (currentEmployeeMappings && currentEmployeeMappings[sector]) ? currentEmployeeMappings[sector] : [];
  mapped.forEach(m => {
    if (m && m.appName && m.appName.trim()) {
      const name = m.appName.trim();
      if (!baseDefaults.some(b => b.toLowerCase() === name.toLowerCase())) {
        baseDefaults.push(name);
      }
    }
  });

  return baseDefaults;
}

// Used only by the Inicio dashboard board (one card per task) to decide which sector's board
// a given task belongs on. Orders can be legitimately shared across sectors (e.g. the generic
// "REPARACIONES INTERNAS" bucket, where several people from different sectors each log their
// own task under the same OT) - so this must go strictly by the TASK's own centro de costo,
// never by the order's overall clasificacion/sector or by guessing from the employee's name
// (name-based matching used to false-positive, e.g. flagging "PANETTA ALBARRACIN FEDERICO" -
// a Taller employee - as Herrería just because Herrería's roster has an unrelated "Federico"
// alias). A task's centroCosto is stored as a catalog code (e.g. "11"), never the word
// "Herreria" itself - that only appears in the catalog's LABEL for that code.
function getTaskCentroCostoSector(centroCosto, fallbackSector) {
  const cleanCc = String(centroCosto || '').trim();
  // No centro de costo recorded on the task itself - not enough evidence to say it belongs to
  // a different sector than the order it's already in, so fall back to that instead of
  // defaulting to Taller (which used to silently pull blank-CC Herrería/Edilicio tasks onto
  // the Taller board).
  if (!cleanCc) return fallbackSector || 'Taller';
  const ccOpt = (cachedCatalogs && cachedCatalogs.centrosCosto) ? cachedCatalogs.centrosCosto.find(c => c && c.value === cleanCc) : null;
  const ccLabel = (ccOpt && ccOpt.label ? ccOpt.label : cleanCc).toUpperCase();
  if (ccLabel.includes('HERRER')) return 'Herrería';
  if (ccLabel.includes('EDIL')) return 'Edilicio';
  return 'Taller';
}

function populateDatalist(datalistId, options) {
  const el = document.getElementById(datalistId);
  if (!el) return;
  el.innerHTML = options.map(opt => `<option value="${opt.value}">${opt.label}</option>`).join('');
}

function findRodadoForInterno(intVal) {
  const cleanInt = String(intVal || '').trim().toUpperCase();
  if (!cleanInt) return null;
  const rodados = cachedCatalogs.rodados || [];

  // 1. Exact match by interno or value first, across the whole catalog,
  // so a short interno (e.g. "5") earlier in the list never steals a
  // selection meant for a longer one (e.g. "57").
  const exactMatch = rodados.find(r => {
    const rInt = String(r.interno || '').trim().toUpperCase();
    const rVal = String(r.value || '').trim().toUpperCase();
    return (rInt && rInt === cleanInt) || (rVal && rVal === cleanInt);
  });
  if (exactMatch) return exactMatch;

  // 2. Fallback: fuzzy match by label text only (used while the user is
  // still typing a partial interno).
  return rodados.find(r => {
    const rLbl = String(r.label || '').trim().toUpperCase();
    return rLbl && rLbl.includes(cleanInt);
  }) || null;
}

function findRodadoOption(selectEl, cleanInterno, rodadoOpt) {
  if (!selectEl) return null;
  const options = Array.from(selectEl.options || []);
  if (options.length === 0) return null;

  const intStr = String(cleanInterno || '').trim().toUpperCase();
  if (!intStr) return null;

  // 1. Match by rodadoOpt.value
  if (rodadoOpt && rodadoOpt.value) {
    const optMatch = options.find(opt => String(opt.value).trim().toUpperCase() === String(rodadoOpt.value).trim().toUpperCase());
    if (optMatch) return optMatch;
  }

  // 2. Exact match by intStr as option value or option text
  const exactMatch = options.find(opt => 
    String(opt.value).trim().toUpperCase() === intStr ||
    String(opt.text).trim().toUpperCase() === intStr
  );
  if (exactMatch) return exactMatch;

  // 3. Match by option text containing intStr (partial typing fallback).
  // Deliberately NOT "intStr.includes(txt)" - that direction let a short
  // option text (e.g. interno "5") falsely match a longer typed value
  // (e.g. "57") whenever it appeared earlier in the option list.
  const matchText = options.find(opt => {
    const txt = String(opt.text || '').toUpperCase().trim();
    if (!txt || txt.startsWith('SELECCIONAR')) return false;
    return txt.includes(intStr) || txt.includes(`INTERNO ${intStr}`) || txt.includes(`INTERNO: ${intStr}`);
  });
  if (matchText) return matchText;

  // 4. Match by catalog rodado label containing intStr
  if (rodadoOpt && rodadoOpt.label) {
    const catalogLabel = String(rodadoOpt.label).toUpperCase().trim();
    const matchCat = options.find(opt => {
      const txt = String(opt.text || '').toUpperCase().trim();
      return txt && !txt.startsWith('SELECCIONAR') && (txt.includes(catalogLabel) || catalogLabel.includes(txt));
    });
    if (matchCat) return matchCat;
  }

  return null;
}

// On Page Load
document.addEventListener('DOMContentLoaded', () => {
  // Set default dates and times
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  document.getElementById('form-fecha').value = `${yyyy}-${mm}-${dd}`;
  
  const hh = String(today.getHours()).padStart(2, '0');
  const min = String(today.getMinutes()).padStart(2, '0');
  document.getElementById('form-hora').value = `${hh}:${min}`;

  // Check user session first
  checkUserSession();
  initCardBgPicker();
  startAppVersionWatch();

  // If logged in, fetch initial data
  if (localStorage.getItem('currentUserUsername')) {
    fetchSettings();
    fetchCatalogs();
    fetchAreasEdilicio();
    fetchOrders();
    fetchActiveMechanics();
    fetchParteTallerEstado();
    fetchPrevCombustible();
    fetchAndRenderInsumosPendientes();
    setInterval(fetchAndRenderInsumosPendientes, 30000);
  }

  // Setup Event Listeners
  document.getElementById('settings-form').addEventListener('submit', saveSettings);

  // Dynamic change listener for Centro de Costo (task-cc) and Empleado conflict checking
  const tasksContainer = document.getElementById('modal-tasks-list');
  if (tasksContainer) {
    tasksContainer.addEventListener('change', async (e) => {
      if (e.target && e.target.classList.contains('task-cc')) {
        const card = e.target.closest('.task-item-card');
        if (card) {
          updateEmployeeDropdownForCard(card);
        }
      } else if (e.target && e.target.classList.contains('task-emp')) {
        const selectEl = e.target;
        const card = selectEl.closest('.task-item-card');
        if (!card) return;
        
        const taskId = card.id;
        const isTimerRunning = localStorage.getItem(`timer_start_${taskId}`) !== null;
        
        if (isTimerRunning && selectEl.value) {
          const conflict = getConflictForEmployee(selectEl.value, taskId);
          if (conflict) {
            const empOpt = cachedCatalogs.empleados.find(emp => emp.value === selectEl.value);
            const empName = empOpt ? empOpt.label : "El operario";
            const rodadoInfo = conflict.orderRodado || `Interno ${conflict.orderInterno}`;
            const confirmMsg = `El mecánico ${empName} ya está trabajando en otra tarea activa para el rodado: ${rodadoInfo}.\n\n¿Desea pausar esa tarea automáticamente para asignar este operario a la tarea activa actual?`;
            
            if (confirm(confirmMsg)) {
              await pauseTask(conflict);
            } else {
              // Revert selection
              const oldVal = selectEl.dataset.prevVal || "";
              selectEl.value = oldVal;
              if (selectEl.rebuildSearchable) {
                selectEl.rebuildSearchable();
              }
              showToast("Asignación cancelada", "warning");
            }
          }
        }
      } else if (e.target && e.target.classList.contains('task-status')) {
        const selectEl = e.target;
        const card = selectEl.closest('.task-item-card');
        if (card && selectEl.value === 'Finalizada') {
          const taskId = card.id;
          const timerKey = `timer_start_${taskId}`;
          const isRunning = localStorage.getItem(timerKey) !== null;
          if (isRunning) {
            clearLocalStorageTimerKeys(taskId);
            if (activeIntervalTimers[taskId]) {
              clearInterval(activeIntervalTimers[taskId]);
              delete activeIntervalTimers[taskId];
            }
            // Reset button UI
            const btn = document.getElementById(`timer-btn-${taskId}`);
            if (btn) {
              btn.classList.remove('running');
              btn.querySelector('.material-icons').textContent = 'play_arrow';
              btn.querySelector('.btn-text').textContent = 'Iniciar';
            }
            const display = document.getElementById(`timer-display-${taskId}`);
            if (display) {
              display.textContent = '00:00:00';
            }
          }

          // Finalizing directly from a PAUSED state (never clicked "Reanudar" first) left a gap
          // in the history - [Inició, Pausó, Fin] with nothing between Pausó and Fin -
          // calculateTotalElapsedSeconds only sums Inicio/Reanudo→Pausa/Fin pairs, so that gap
          // silently counted as zero worked time even though work may well have continued right
          // up to Fin. Insert a "Reanudó" stamped at the SAME instant as that Pausó (not "now" -
          // a resume can't be timestamped after the fact) so the pause collapses to zero-length
          // and the whole Inicio-to-Fin span counts, same as if it had never been paused.
          if (!isRunning) {
            const historyBeforeFin = JSON.parse(card.dataset.timerHistory || '[]');
            const lastEvent = historyBeforeFin[historyBeforeFin.length - 1];
            const wasPaused = lastEvent && String(lastEvent.type || '').trim().toLowerCase().startsWith('paus');
            if (wasPaused) {
              historyBeforeFin.push({ type: 'Reanudó', formatted: lastEvent.formatted, timestamp: lastEvent.timestamp });
              card.dataset.timerHistory = JSON.stringify(historyBeforeFin);
              renderTaskTimerHistory(card);
            }
          }

          addTaskTimerEvent(card, 'Fin');

          const history = JSON.parse(card.dataset.timerHistory || '[]');
          const totalMinutes = Math.round(calculateTotalElapsedSeconds(history, null) / 60);
          const totalHours = minutesToHmm(totalMinutes);
          const hoursInput = card.querySelector('.task-hours');
          if (hoursInput) {
            hoursInput.value = totalHours.toFixed(2);
            updateHoursReadable(hoursInput);
          }

          const rodadoEl = document.getElementById('form-rodado');
          const rodadoVal = rodadoEl ? rodadoEl.options[rodadoEl.selectedIndex]?.text : '';
          const internoEl = document.getElementById('form-interno');
          const internoVal = internoEl ? internoEl.value : '';

          const empSelect = card.querySelector('.task-emp');
          const empVal = empSelect ? empSelect.value : '';
          const empOpt = cachedCatalogs.empleados.find(emp => emp.value === empVal);
          const empName = empOpt ? empOpt.label : '';

          const ccSelect = card.querySelector('.task-cc');
          const ccVal = ccSelect ? ccSelect.value : '';
          const ccOpt = cachedCatalogs.centrosCosto.find(cc => cc.value === ccVal);
          const ccName = ccOpt ? ccOpt.label : '';

          const descTextarea = card.querySelector('.task-desc');
          const descVal = descTextarea ? descTextarea.value : '';

          const insumoInput = card.querySelector('.task-insumos');
          const insumosVal = insumoInput ? insumoInput.value : '';

          const taskInfo = {
            interno: internoVal,
            rodado: rodadoVal,
            empleado: empName,
            centroCosto: ccName,
            descripcion: descVal,
            insumos: insumosVal
          };

          promptDiagnosis(taskInfo).then(result => {
            if (result) {
              const textareaEl = card.querySelector('.task-desc');
              const insumoEl = card.querySelector('.task-insumos');
              if (textareaEl) {
                let additions = [];
                if (result.diagnosis) additions.push('Diagnóstico: ' + result.diagnosis);
                if (result.insumos) additions.push('Insumos: ' + result.insumos);
                if (additions.length > 0) {
                  const prefix = textareaEl.value.trim() ? ' - ' : '';
                  textareaEl.value = textareaEl.value.trim() + prefix + additions.join(' - ');
                  textareaEl.dispatchEvent(new Event('input', { bubbles: true }));
                }
              }
              if (insumoEl && result.insumos) {
                insumoEl.value = result.insumos;
              }
            }

            const allModalTaskCards = Array.from(document.querySelectorAll('#modal-tasks-list .task-item-card'));
            const stillHasPending = allModalTaskCards.some(otherCard => {
              if (otherCard === card) return false;
              const statusSel = otherCard.querySelector('.task-status');
              return statusSel && statusSel.value !== 'Finalizada';
            });

            if (!stillHasPending && internoVal) {
              openUnitStatusModal(internoVal, currentEditingOrderId);
            }
          });
        }
      }
    });
  }

  // Poll for orders sync status in real time (2s interval for instant multi-device coordination)
  setInterval(fetchOrders, 2000);
  setInterval(checkWorkerStatus, 5000);
  setInterval(fetchSettingsPolling, 10000);

  // Fetch novelties and employee mappings on startup
  fetchNovelties();
  if (typeof loadAndRenderEmployeeMappings === 'function') loadAndRenderEmployeeMappings();

  const preClasifEl = document.getElementById('pre-form-clasificacion');
  if (preClasifEl) preClasifEl.addEventListener('change', setupAllFieldsForSector);
  const formClasifEl = document.getElementById('form-clasificacion');
  if (formClasifEl) formClasifEl.addEventListener('change', setupAllFieldsForSector);

  // Listen for changes on rodado field to auto-populate interno
  const rodadoSelect = document.getElementById('form-rodado');
  if (rodadoSelect) {
    rodadoSelect.addEventListener('change', () => {
      const internoInput = document.getElementById('form-interno');
      if (internoInput) {
        const sector = getSectorByUsername(localStorage.getItem('currentUserUsername'));
        if (sector === 'Herrería') {
          // Herrería: do NOT auto-populate Interno, leave it empty or let them type
          internoInput.value = "";
          if (internoInput.rebuildSearchable) {
            internoInput.rebuildSearchable();
          }
          showNoveltiesForInterno("");
        } else {
          // Taller / Admin / Edilicio: auto-populate Interno from rodado catalog data if available!
          const rodadoVal = rodadoSelect.value;
          const rodadoOpt = (cachedCatalogs.rodados || []).find(r => String(r.value) === String(rodadoVal));
          if (rodadoOpt && rodadoOpt.interno) {
            let optionExists = Array.from(internoInput.options).some(opt => opt.value === String(rodadoOpt.interno));
            if (!optionExists) {
              const newOpt = document.createElement('option');
              newOpt.value = String(rodadoOpt.interno);
              newOpt.textContent = String(rodadoOpt.interno);
              internoInput.appendChild(newOpt);
            }
            internoInput.value = String(rodadoOpt.interno);
            if (internoInput.rebuildSearchable) {
              internoInput.rebuildSearchable();
            }
            showNoveltiesForInterno(rodadoOpt.interno);
          } else if (!internoInput.value) {
            showNoveltiesForInterno("");
          }
        }
      }
    });
  }

  // Listen for changes on interno field to show novelties sidebar and auto-populate Rodado
  const internoInput = document.getElementById('form-interno');
  if (internoInput) {
    const handleInternoChange = () => {
      const val = internoInput.value.trim();
      showNoveltiesForInterno(val);

      const sector = getSectorByUsername(localStorage.getItem('currentUserUsername'));
      if (sector !== 'Herrería' && val) {
        const rodadoSelect = document.getElementById('form-rodado');
        if (rodadoSelect) {
          const rodadoOpt = findRodadoForInterno(val);
          let matchedOpt = findRodadoOption(rodadoSelect, val, rodadoOpt);
          
          if (!matchedOpt && val) {
            // Auto-create & select option for Rodado if no catalog match exists so Rodado is NEVER left blank!
            let optionExists = Array.from(rodadoSelect.options).find(opt => String(opt.value).trim().toUpperCase() === val.toUpperCase());
            if (!optionExists) {
              optionExists = document.createElement('option');
              optionExists.value = val;
              optionExists.textContent = val;
              rodadoSelect.appendChild(optionExists);
            }
            matchedOpt = optionExists;
          }

          if (matchedOpt && rodadoSelect.value !== matchedOpt.value) {
            rodadoSelect.value = matchedOpt.value;
            if (rodadoSelect.rebuildSearchable) {
              rodadoSelect.rebuildSearchable();
            }
          }
        }
      }
    };
    internoInput.addEventListener('input', handleInternoChange);
    internoInput.addEventListener('change', handleInternoChange);
  }

  // Show pending items (novelties + Parte Taller) for the unit selected in "Identificar Unidad"
  const preInternoSelectEl = document.getElementById('pre-form-interno');
  if (preInternoSelectEl) {
    preInternoSelectEl.addEventListener('input', refreshPreOrderPendingItems);
    preInternoSelectEl.addEventListener('change', refreshPreOrderPendingItems);
  }
  const preInternoTextEl = document.getElementById('pre-form-interno-text');
  if (preInternoTextEl) {
    preInternoTextEl.addEventListener('input', refreshPreOrderPendingItems);
    preInternoTextEl.addEventListener('change', refreshPreOrderPendingItems);
  }

  // Search input listeners for Carga Masiva auto-checking on Enter or Blur
  const bulkSearch = document.getElementById('bulk-vehicle-search');
  if (bulkSearch) {
    bulkSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        filterBulkVehicles(true);
      }
    });
    bulkSearch.addEventListener('blur', () => {
      filterBulkVehicles(true);
    });
  }
});

// SIDEBAR MENU (replaces the old bottom nav bar - opened via the hamburger button in the header)
function openSidebarMenu() {
  const menu = document.getElementById('sidebar-menu');
  const overlay = document.getElementById('sidebar-overlay');
  if (menu) menu.classList.add('open');
  if (overlay) overlay.classList.add('open');
}

function closeSidebarMenu() {
  const menu = document.getElementById('sidebar-menu');
  const overlay = document.getElementById('sidebar-overlay');
  if (menu) menu.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
}

function toggleSidebarMenu() {
  const menu = document.getElementById('sidebar-menu');
  if (menu && menu.classList.contains('open')) {
    closeSidebarMenu();
  } else {
    openSidebarMenu();
  }
}
window.openSidebarMenu = openSidebarMenu;
window.closeSidebarMenu = closeSidebarMenu;
window.toggleSidebarMenu = toggleSidebarMenu;

// 1. SPA ROUTING
let parteTallerAutoRefreshInterval = null;

function switchView(viewId) {
  console.log("Switching view to:", viewId);
  try {
    // Parte Taller needs to stay in sync with live task starts/pauses and the Google Sheet
    // reconciliation without someone manually hitting "Actualizar" - only poll while this
    // specific view is actually on screen, not in the background from every other tab.
    if (parteTallerAutoRefreshInterval) {
      clearInterval(parteTallerAutoRefreshInterval);
      parteTallerAutoRefreshInterval = null;
    }
    // Picking any item from the sidebar menu should also close it - it's an off-canvas
    // overlay now (see SIDEBAR MENU above), not a bar that stays on screen.
    closeSidebarMenu();

    // Deactivate all views
    document.querySelectorAll('.app-view').forEach(v => {
      v.classList.remove('active');
      v.style.display = 'none';
    });
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));

    // Activate selected view
    const viewEl = document.getElementById(`view-${viewId}`);
    if (viewEl) {
      viewEl.classList.add('active');
      viewEl.style.display = 'block';
    }

    const navEl = document.getElementById(`nav-${viewId}`);
    if (navEl) navEl.classList.add('active');

    // Clear selections when changing views
    if (viewId !== 'orders') {
      try {
        selectedOrderIds.clear();
        updateBulkSyncActionBar();
        document.querySelectorAll('.order-select-checkbox').forEach(chk => chk.checked = false);
      } catch (e) {}
    }
    if (viewId !== 'history') {
      try {
        selectedHistoryOrderIds.clear();
        updateHistoryBulkDeleteActionBar();
        document.querySelectorAll('.history-order-select-checkbox').forEach(chk => chk.checked = false);
      } catch (e) {}
    }

    if (viewId === 'orders') {
      try { renderOrders(); } catch(e) { console.error("renderOrders error:", e); }
    }

    if (viewId === 'settings') {
      try { renderEmployeeHoursSummary(); } catch(e) {}
      const empMappingsSection = document.getElementById('employee-mappings-section');
      if (empMappingsSection) {
        empMappingsSection.style.display = 'block';
        if (typeof loadAndRenderEmployeeMappings === 'function') {
          try { loadAndRenderEmployeeMappings(); } catch(e) {}
        }
      }
      if (typeof loadUserPermissionsUI === 'function') {
        try { loadUserPermissionsUI(); } catch(e) {}
      }
    }

    if (viewId === 'bulk') {
      try {
        // Reset the task list every time this tab is opened, not just when empty - the tab
        // stays mounted in the DOM between visits, so leftover task cards (or a preventivo
        // type left "active" from a previous batch) would otherwise get resubmitted alongside
        // a new selection, producing duplicate tasks inside every order of the new batch.
        const container = document.getElementById('bulk-tasks-container');
        if (container) {
          container.innerHTML = '';
          activePreventivoTypes = new Set();
          syncPreventivoButtons();
          addBulkTaskField();
        }
        renderBulkVehicleSelector();
      } catch(e) {}
    }

    if (viewId === 'preventivos') {
      try { fetchPreventivoFlota(); } catch(e) {}
    }

    if (viewId === 'gomeria') {
      // Reset every time the tab is opened, not just when empty - same reasoning as 'bulk':
      // the tab stays mounted in the DOM between visits, so a leftover interno block from a
      // previous batch would otherwise sit there ready to get resubmitted alongside a new one.
      try {
        const container = document.getElementById('gomeria-internos-container');
        if (container) {
          container.innerHTML = '';
          addGomeriaInternoBlock();
        }
      } catch(e) {}
    }

    if (viewId === 'partetaller') {
      try { autoSetPtSupervisorSelect(); } catch(e) {}
      try { fetchParteTallerEstado(); } catch(e) {}
      parteTallerAutoRefreshInterval = setInterval(() => {
        try { fetchParteTallerEstado(); } catch(e) {}
      }, 60000);
    }

    if (viewId === 'historial') {
      try { fetchArchivedOrders(); } catch(e) {}
    }
  } catch (err) {
    console.error("[switchView Error]:", err);
  }
}

window.switchView = switchView;

// 2. MODAL CONTROLLERS
function openPreOrderModal() {
  setupAllFieldsForSector();

  // Reset the searchable select for Interno by repopulating and rebuilding it
  const preInternoSelect = document.getElementById('pre-form-interno');
  if (preInternoSelect) {
    if (cachedInternoOptions && cachedInternoOptions.length > 0) {
      populateSelect('pre-form-interno', cachedInternoOptions, "Seleccionar Rodado...");
    }
    preInternoSelect.value = "";
    if (preInternoSelect.rebuildSearchable) {
      preInternoSelect.rebuildSearchable();
    } else {
      // Manually clear the search input inside the searchable wrapper
      const wrapper = preInternoSelect.closest ? preInternoSelect.closest('.searchable-select-container') : null;
      if (wrapper) {
        const searchInput = wrapper.querySelector('.searchable-select-search-input');
        if (searchInput) searchInput.value = '';
        const labelSpan = wrapper.querySelector('.trigger-label');
        if (labelSpan) labelSpan.textContent = 'Seleccionar Rodado...';
      }
    }
  }
  const preInternoText = document.getElementById('pre-form-interno-text');
  if (preInternoText) {
    preInternoText.value = "";
  }

  // Ensure classification options match the current selected sector tab
  updateClassificationSelectOptions();

  // Set default classification (Herrería for Herrería - it's a real Taxes value there).
  // Taller AND Edilicio are left blank on purpose - pedido explicito del usuario: auto-
  // seleccionar "Correctivo" hacia que gente que en realidad necesitaba cargar un Auxilio se
  // equivocara sin darse cuenta, porque el campo ya venia lleno. Ahora tiene que elegirlo a
  // mano (submitPreOrderCheck ya bloquea continuar si queda vacio). Edilicio no tiene un valor
  // propio de clasificacion en Taxes - ese sector se identifica por el Centro de Costo de la
  // tarea, no por este campo.
  const clsEl = document.getElementById('pre-form-clasificacion');
  if (clsEl) {
    const currentUser = localStorage.getItem('currentUserUsername');
    const userSector = getSectorByUsername(currentUser);
    if (userSector === 'Herrería' || currentSelectedSector === 'Herrería') {
      clsEl.value = 'Herrería';
    } else {
      clsEl.value = '';
    }
  }

  // Set up input vs select based on user sector AND updated classification
  setupAllFieldsForSector();

  // Reset pending-items shortcut list from any previously selected unit
  window._preOrderPendingItems = [];
  const pendingGroup = document.getElementById('pre-order-pending-items-group');
  const pendingList = document.getElementById('pre-order-pending-items-list');
  if (pendingGroup) pendingGroup.style.display = 'none';
  if (pendingList) pendingList.innerHTML = '';

  document.getElementById('pre-order-modal').classList.add('open');
}

function closePreOrderModal() {
  document.getElementById('pre-order-modal').classList.remove('open');
}

function toggleDiagInsumosCollapse(forceOpen = null) {
  const body = document.getElementById('diag-insumos-body');
  const chevron = document.getElementById('diag-insumos-chevron');
  const header = document.getElementById('diag-insumos-header');
  if (!body || !chevron) return;

  const shouldOpen = forceOpen !== null ? forceOpen : (body.style.display === 'none' || body.style.display === '');
  if (shouldOpen) {
    body.style.display = 'grid';
    chevron.style.transform = 'rotate(180deg)';
    if (header) header.style.borderRadius = '8px 8px 0 0';
  } else {
    body.style.display = 'none';
    chevron.style.transform = 'rotate(0deg)';
    if (header) header.style.borderRadius = '8px';
  }
}

function updateDiagInsumosBadge() {
  const modal = document.getElementById('diagnosis-modal');
  if (!modal) return;
  const badge = document.getElementById('diag-insumos-badge');
  const count = modal.querySelectorAll('.diag-insumo-check:checked').length;
  if (badge) {
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
}

function promptDiagnosis(taskInfo = null) {
  return new Promise((resolve) => {
    const modal = document.getElementById('diagnosis-modal');
    const textarea = document.getElementById('diagnosis-text');
    const btnSave = document.getElementById('btn-diagnosis-save');
    const btnSkip = document.getElementById('btn-diagnosis-skip');

    if (!modal || !textarea) {
      resolve(null);
      return;
    }

    // This checklist (Aceite Motor, Refrigerante, Grasa Diferencial, etc.) is Taller/Mecánica
    // specific - irrelevant to Herrería (blacksmith) or Edilicio (building maintenance) work.
    // Both callers pass the task's own centro de costo LABEL (not raw code) here.
    const insumosSectionEl = document.getElementById('diag-insumos-section');
    if (insumosSectionEl) {
      const ccLabel = String((taskInfo && taskInfo.centroCosto) || '').toUpperCase();
      const isTallerIrrelevant = ccLabel.includes('HERRER') || ccLabel.includes('EDIL');
      insumosSectionEl.style.display = isTallerIrrelevant ? 'none' : '';
    }

    const summaryEl = document.getElementById('diagnosis-task-summary');
    if (summaryEl) {
      if (taskInfo) {
        let html = '';
        if (taskInfo.interno) html += `<div><strong>Interno:</strong> ${taskInfo.interno} ${taskInfo.rodado ? `(${taskInfo.rodado})` : ''}</div>`;
        if (taskInfo.empleado) html += `<div><strong>Operario:</strong> ${taskInfo.empleado}</div>`;
        if (taskInfo.centroCosto) html += `<div><strong>Centro de Costo:</strong> ${taskInfo.centroCosto}</div>`;
        if (taskInfo.descripcion) html += `<div style="margin-top: 4px; border-top: 1px solid #cbd5e1; padding-top: 4px; color: #334155;"><strong>Tarea:</strong> ${taskInfo.descripcion}</div>`;
        summaryEl.innerHTML = html;
        summaryEl.style.display = 'block';
      } else {
        summaryEl.style.display = 'none';
      }
    }

    // Reset textarea and checkboxes
    textarea.value = '';
    const checkboxes = modal.querySelectorAll('.diag-insumo-check');
    checkboxes.forEach(chk => {
      chk.checked = false;
      toggleInsumoRow(chk); // Hide inline inputs
    });

    if (taskInfo && taskInfo.insumos && typeof taskInfo.insumos === 'string' && taskInfo.insumos.trim()) {
      const items = taskInfo.insumos.split('|').map(s => s.trim()).filter(Boolean);
      let hasAnyChecked = false;
      items.forEach(item => {
        let name = item;
        let qty = '';
        if (item.includes(':')) {
          const parts = item.split(':');
          name = parts[0].trim();
          qty = parts.slice(1).join(':').trim();
        }

        const chkList = Array.from(checkboxes);
        const targetChk = chkList.find(chk => chk.value.trim().toLowerCase() === name.toLowerCase());
        if (targetChk) {
          targetChk.checked = true;
          toggleInsumoRow(targetChk);
          hasAnyChecked = true;
          if (qty) {
            const row = targetChk.closest('.insumo-row');
            if (row) {
              const qtyInput = row.querySelector('.insumo-qty-input');
              if (qtyInput) {
                qtyInput.value = qty;
              }
            }
          }
        }
      });
      if (hasAnyChecked && typeof toggleDiagInsumosCollapse === 'function') {
        toggleDiagInsumosCollapse(true);
      }
    } else {
      if (typeof toggleDiagInsumosCollapse === 'function') {
        toggleDiagInsumosCollapse(false);
      }
    }
    if (typeof updateDiagInsumosBadge === 'function') {
      updateDiagInsumosBadge();
    }

    modal.classList.add('open');

    // Clear any previous event listeners by cloning buttons
    const newBtnSave = btnSave.cloneNode(true);
    const newBtnSkip = btnSkip.cloneNode(true);
    btnSave.parentNode.replaceChild(newBtnSave, btnSave);
    btnSkip.parentNode.replaceChild(newBtnSkip, btnSkip);

    const closeModal = () => {
      modal.classList.remove('open');
    };

    newBtnSave.addEventListener('click', () => {
      const val = textarea.value.trim();
      
      // Collect insumos from modal
      const lineas = [];
      const checkedBoxes = modal.querySelectorAll('.diag-insumo-check:checked');
      checkedBoxes.forEach(chk => {
        const nombre = chk.value;
        const row = chk.closest('.insumo-row');
        const input = row ? row.querySelector('.insumo-qty-input') : null;
        const cantidad = input ? input.value.trim() : '';
        if (cantidad !== '') {
          lineas.push(`${nombre}: ${cantidad}`);
        } else {
          lineas.push(nombre);
        }
      });
      const insumosVal = lineas.join(' | ');

      closeModal();
      resolve({
        diagnosis: val || null,
        insumos: insumosVal || null
      });
    });

    newBtnSkip.addEventListener('click', () => {
      closeModal();
      resolve(null);
    });
  });
}

// --- SIMPLE UNIT STATUS MODAL (shown when the last task of an order is finalized) ---

let _unitStatusModalCtx = null;

function openUnitStatusModal(interno, orderId) {
  _unitStatusModalCtx = { interno, orderId };
  const subtitle = document.getElementById('unit-status-modal-subtitle');
  if (subtitle) subtitle.textContent = `Interno ${interno} · última tarea finalizada`;
  const modal = document.getElementById('unit-status-modal');
  if (modal) modal.classList.add('open');
}

function closeUnitStatusModal() {
  const modal = document.getElementById('unit-status-modal');
  if (modal) modal.classList.remove('open');
  _unitStatusModalCtx = null;
}

// Instead of silently auto-matching checklist text against finalized task descriptions (which
// missed anything that wasn't converted into a task with the exact same wording, e.g. work done
// off the books), this opens the interactive review modal so a human decides what's actually
// resolved before the status change goes through.
async function resolveUnitStatusModal(estado) {
  const ctx = _unitStatusModalCtx;
  closeUnitStatusModal();
  if (!ctx) return;
  await openChecklistReviewModal(ctx.interno, ctx.orderId, estado);
}

// Applies the order-side status change (estadoUnidad + Taxes sync on Operativo) - the Parte
// Taller side is handled separately by applyParteTallerReconciliation, called just before this.
async function applyUnitStatusChange(interno, orderId, estado) {
  const order = activeOrders.find(o => o.id === orderId);
  if (order) {
    order.estadoUnidad = estado;
    try {
      const currentUsername = localStorage.getItem('currentUserUsername') || 'paniol@contenedoreshugo.com.ar';
      await fetch(`/api/orders/${orderId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-user-username': currentUsername
        },
        body: JSON.stringify({
          rodado: order.rodado,
          responsable: order.responsable,
          fechaEntrega: order.fechaEntrega,
          horario: order.horario,
          interno: order.interno,
          clasificacion: order.clasificacion,
          incidente: order.incidente,
          // Drop any task with no real id before resending - see resolveDatabaseConflicts()
          // for why (the server mints a brand-new id for it every time, duplicating it forever).
          tasks: (order.tasks || []).filter(t => t && t.id),
          estadoUnidad: estado,
          // Operativo = no more tasks coming, this is the moment to push everything to
          // Taxes in one shot. Fuera de servicio leaves the order open (job still going),
          // so it doesn't force a resync here - it rides along with the next explicit sync.
          ...(estado === 'operativo' ? { syncStatus: 'pending' } : {})
        })
      });
      fetchOrders();
    } catch (e) {
      console.error('[applyUnitStatusChange] Error al actualizar estadoUnidad:', e);
    }
  }

  if (estado === 'operativo') {
    if (order && order.id) {
      showToast("Sincronizando tareas en Taxes al pasar a Operativo...", "info");
      try {
        const res = await fetch('/api/orders/finalize-tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: order.id })
        });
        const data = await res.json();
        if (data.status === 'success' || data.success) {
          showToast("✅ Tareas sincronizadas con éxito en Taxes al pasar a Operativo", "success");
        } else {
          showToast(data.message || "Error al sincronizar tareas en Taxes", "warning");
        }
      } catch (err) {
        console.error('[applyUnitStatusChange] Error al sincronizar tareas al pasar a operativo:', err);
      }
    } else {
      showToast("Unidad marcada como Operativa", "success");
    }
  } else {
    showToast("Unidad marcada como Fuera de servicio", "warning");
  }
  fetchOrders();
}

// --- CHECKLIST REVIEW MODAL: shown when confirming Operativo/Fuera de Servicio -----------
// Shows every pending Parte Taller item for this interno (across all lists, deduplicated) so a
// human can check off what's actually done and add anything new, instead of relying on a
// silent text-match against finalized tasks. Unchecked items (plus anything newly added) end
// up as the unit's fresh Parte Taller entry: Servicios Pendientes if the unit is Operativo
// (still working, just minor pending items), or Fuera de Servicio if not (still down).

let _checklistReviewCtx = null;

// Manual correction for internos whose "equipo" is just wrong in the Taxes catalog itself
// (e.g. interno 153 is a real Compactador but Taxes has it catalogued as "CAMION"). The real
// fix is correcting it in Taxes directly - add here only as a stopgap for a specific interno
// someone's already flagged, not as a permanent home for every miscategorized unit. Keep in
// sync with INTERNO_TIPO_OVERRIDES in server.js.
const INTERNO_TIPO_OVERRIDES = {
  '153': 'COMPACTADOR'
};

function getUnitTipoForInterno(interno) {
  const cleanInterno = String(interno || '').trim();
  if (INTERNO_TIPO_OVERRIDES[cleanInterno]) return INTERNO_TIPO_OVERRIDES[cleanInterno];
  const rodadoOpt = cachedCatalogs.rodados
    ? cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === cleanInterno)
    : null;
  const equipo = String(rodadoOpt ? rodadoOpt.equipo || '' : '').trim().toUpperCase();
  if (equipo.startsWith('COMPACTADOR')) return 'COMPACTADOR';
  if (equipo.startsWith('VOLQUETE')) return 'VOLQUETE';
  if (equipo.startsWith('ROLL OFF')) return 'ROLL - OFF';
  // Real planchas are catalogued as "CHASIS CON PLANCHA", not "PLANCHA ..." - startsWith missed
  // every single one of them (they all fell through to 'Otro' instead).
  if (equipo.includes('PLANCHA')) return 'PLANCHA';
  return 'Otro';
}

async function openChecklistReviewModal(interno, orderId, estado) {
  // Defensive reset: if a previous confirm on this same modal left the button stuck as
  // disabled/"Guardando..." (e.g. an error skipped the reset at the end of
  // confirmChecklistReviewAndApply), the modal must never reopen already showing that state.
  const confirmBtn = document.getElementById('pt-review-confirm-btn');
  if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirmar'; }

  let items = [];
  let tipo = '';
  try {
    const res = await fetch('/api/parte-taller/estado');
    const data = await res.json();
    const state = data.state || data;
    const cleanInterno = String(interno || '').trim().toLowerCase();
    ['transito', 'servicios_pendientes', 'reparacion', 'fuera_de_servicio'].forEach(listName => {
      (state[listName] || []).forEach(unit => {
        if (String(unit.interno || '').trim().toLowerCase() !== cleanInterno) return;
        if (unit.tipo && !tipo) tipo = unit.tipo;
        const entries = (Array.isArray(unit.novedad_items) && unit.novedad_items.length > 0)
          ? unit.novedad_items
          : (unit.novedad || '').split('\n').map(line => {
              const l = line.trim();
              if (!l) return null;
              const hecho = l.startsWith('[X]') || l.startsWith('[x]');
              const texto = l.replace(/^\[\s*[xX]?\s*\]\s*/, '').trim();
              return texto ? { texto, hecho } : null;
            }).filter(Boolean);
        entries.forEach(e => {
          if (e.hecho) return;
          const clean = String(e.texto || '').trim();
          if (clean && !items.some(it => it.toUpperCase() === clean.toUpperCase())) items.push(clean);
        });
      });
    });
  } catch (e) {
    console.error('[openChecklistReviewModal] Error leyendo Parte Taller:', e);
  }

  if (!tipo) tipo = getUnitTipoForInterno(interno);
  _checklistReviewCtx = { interno, orderId, estado, tipo, newItems: [] };

  const titleEl = document.getElementById('pt-review-title');
  if (titleEl) titleEl.textContent = `Confirmar interno ${interno}`;
  const badge = document.getElementById('pt-review-estado-badge');
  if (badge) {
    if (estado === 'operativo') {
      badge.textContent = 'Operativo';
      badge.style.background = 'var(--success-light)';
      badge.style.color = '#065f46';
    } else {
      badge.textContent = 'Fuera de servicio';
      badge.style.background = 'var(--danger-light)';
      badge.style.color = '#991b1b';
    }
  }

  // Only ask where the leftover items land when the unit ISN'T going back into service -
  // Operativo always means Servicios Pendientes, no choice to make there.
  const destinoContainer = document.getElementById('pt-review-destino-container');
  const destinoSelect = document.getElementById('pt-review-destino');
  const footerText = document.getElementById('pt-review-footer-text');
  if (estado === 'operativo') {
    if (destinoContainer) destinoContainer.style.display = 'none';
    if (footerText) footerText.textContent = 'Lo que no marques (y lo nuevo que agregues) queda anotado en Servicio Pendiente.';
  } else {
    if (destinoContainer) destinoContainer.style.display = 'block';
    if (destinoSelect) destinoSelect.value = 'fuera_de_servicio';
    if (footerText) footerText.textContent = 'Lo que no marques (y lo nuevo que agregues) queda anotado en el destino elegido arriba.';
  }

  const container = document.getElementById('pt-review-checklist');
  if (container) {
    container.innerHTML = items.length === 0
      ? '<p style="font-size:13px; color:var(--text-muted); margin:0;">No hay ítems pendientes registrados para esta unidad.</p>'
      : items.map(texto => `
        <label style="display:flex; align-items:flex-start; gap:8px; font-size:13px; cursor:pointer;">
          <input type="checkbox" class="pt-review-item-chk" data-texto="${String(texto).replace(/"/g, '&quot;')}" style="margin-top:2px;">
          <span>${texto}</span>
        </label>
      `).join('');
  }
  const newItemsList = document.getElementById('pt-review-new-items-list');
  if (newItemsList) newItemsList.innerHTML = '';
  const newItemInput = document.getElementById('pt-review-new-item-input');
  if (newItemInput) newItemInput.value = '';

  const modal = document.getElementById('pt-checklist-review-modal');
  if (modal) modal.classList.add('open');
}

function closeChecklistReviewModal() {
  const modal = document.getElementById('pt-checklist-review-modal');
  if (modal) modal.classList.remove('open');
  _checklistReviewCtx = null;
}

function ptReviewAddNewItem() {
  const input = document.getElementById('pt-review-new-item-input');
  if (!input || !_checklistReviewCtx) return;
  const val = input.value.trim();
  if (!val) return;
  _checklistReviewCtx.newItems.push(val);
  input.value = '';
  renderChecklistReviewNewItems();
}

function ptReviewRemoveNewItem(idx) {
  if (!_checklistReviewCtx) return;
  _checklistReviewCtx.newItems.splice(idx, 1);
  renderChecklistReviewNewItems();
}

function renderChecklistReviewNewItems() {
  const container = document.getElementById('pt-review-new-items-list');
  if (!container || !_checklistReviewCtx) return;
  container.innerHTML = _checklistReviewCtx.newItems.map((texto, idx) => `
    <div style="display:flex; align-items:center; gap:8px; font-size:13px;">
      <span class="material-icons" style="font-size:15px; color: var(--primary);">fiber_new</span>
      <span style="flex:1;">${String(texto).replace(/</g, '&lt;')}</span>
      <button type="button" onclick="ptReviewRemoveNewItem(${idx})" style="border:none; background:none; cursor:pointer; color:var(--text-muted); padding:0;">
        <span class="material-icons" style="font-size:15px;">close</span>
      </button>
    </div>
  `).join('');
}

// Rebuilds this interno's Parte Taller entry from scratch: dropped entirely if every item is
// resolved, otherwise a fresh entry in Servicios Pendientes (Operativo) or Fuera de Servicio
// (not Operativo) holding exactly the still-open items.
async function applyParteTallerReconciliation(interno, estado, remainingItems, tipo, destino) {
  try {
    const res = await fetch('/api/parte-taller/estado');
    const data = await res.json();
    const state = data.state || data;
    const cleanInterno = String(interno || '').trim().toLowerCase();

    ['transito', 'servicios_pendientes', 'reparacion', 'fuera_de_servicio', 'inversiones'].forEach(listName => {
      if (Array.isArray(state[listName])) {
        state[listName] = state[listName].filter(u => String(u.interno || '').trim().toLowerCase() !== cleanInterno);
      }
    });

    if (remainingItems.length > 0) {
      // Operativo always goes to Servicios Pendientes (nothing to choose there). Otherwise use
      // whatever destino the user picked in the modal (Fuera de Servicio or En Preparación),
      // falling back to Fuera de Servicio if none was passed.
      const targetList = estado === 'operativo' ? 'servicios_pendientes' : (destino || 'fuera_de_servicio');
      if (!state[targetList]) state[targetList] = [];
      const novedad_items = remainingItems.map(texto => ({ texto, hecho: false }));
      const unit = {
        interno: String(interno).trim(),
        tipo: tipo || 'Otro',
        novedad: novedad_items.map(x => `[ ] ${x.texto}`).join('\n'),
        novedad_items
      };
      if (targetList === 'fuera_de_servicio' || targetList === 'inversiones') {
        unit.dia_parado = new Date().toLocaleDateString('es-AR');
        unit.dias_en_reparacion = 0;
      } else {
        unit.servicio = '';
      }
      state[targetList].push(unit);
    }

    await fetch('/api/parte-taller/novedad', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: 'save_state', state })
    });
    fetchParteTallerEstado();
  } catch (e) {
    console.error('[applyParteTallerReconciliation] Error guardando Parte Taller:', e);
  }
}

async function confirmChecklistReviewAndApply() {
  const ctx = _checklistReviewCtx;
  if (!ctx) return;
  const { interno, orderId, estado, tipo } = ctx;

  const uncheckedTexts = Array.from(document.querySelectorAll('.pt-review-item-chk:not(:checked)')).map(chk => chk.dataset.texto);
  const remainingItems = [...uncheckedTexts, ...ctx.newItems];

  const destinoSelect = document.getElementById('pt-review-destino');
  const destino = (estado !== 'operativo' && destinoSelect) ? destinoSelect.value : null;

  const btn = document.getElementById('pt-review-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

  try {
    await applyParteTallerReconciliation(interno, estado, remainingItems, tipo, destino);
    closeChecklistReviewModal();
    await applyUnitStatusChange(interno, orderId, estado);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Confirmar'; }
  }
}

function openPtUnitModalForInterno(interno, sourceOrderId) {
  window._ptLinkedOrderId = sourceOrderId || null; // usado por savePtUnit para sincronizar el estado de vuelta a la orden
  if (!window._ptState) {
    openPtAddUnitModal();
    document.getElementById('pt-unit-interno').value = interno;
    return;
  }
  const lists = ['transito', 'servicios_pendientes', 'reparacion', 'fuera_de_servicio'];
  for (const listName of lists) {
    const list = window._ptState[listName] || [];
    if (list.some(u => String(u.interno).trim() === String(interno).trim())) {
      openPtEditUnitModal(interno, listName);
      return;
    }
  }
  // No está registrada en Parte Taller todavía — abrir en modo agregar
  openPtAddUnitModal();
  document.getElementById('pt-unit-interno').value = interno;
}


async function submitPreOrderCheck() {
  const currentUser = localStorage.getItem('currentUserUsername');
  const userSector = getSectorByUsername(currentUser);

  const preInternoSelect = document.getElementById('pre-form-interno');
  
  let interno = preInternoSelect ? preInternoSelect.value.trim() : "";
  console.log("[submitPreOrderCheck] Initial interno value:", interno);
  
  // Fallback if they typed in search box but didn't click/confirm
  if (!interno && preInternoSelect && preInternoSelect.closest) {
    const wrapper = preInternoSelect.closest('.searchable-select-container');
    const searchInput = wrapper ? wrapper.querySelector('.searchable-select-search-input') : null;
    if (searchInput && searchInput.value.trim()) {
      interno = searchInput.value.trim();
    }
  }

  const clasificacion = document.getElementById('pre-form-clasificacion').value;
  console.log("[submitPreOrderCheck] Final interno:", interno, "clasificacion:", clasificacion);

  if (!interno || !clasificacion) {
    showToast("Por favor complete el Interno y la Clasificación", "danger");
    return;
  }

  const isCarmona = currentUser === 'jcarmona@contenedoreshugo.com.ar' || currentUser === 'j.carmona@contenedoreshugo.com.ar';

  let existingOrder = null;
  if (!isCarmona) {
    // Only match existing order if it is fuera_de_servicio, belongs to the SAME sector group,
    // AND has the SAME clasificacion - a Correctivo/Preventivo/Auxilio for the same vehicle
    // are separate jobs and must always get their own order, never get merged into whichever
    // other job happens to already be open for that interno.
    existingOrder = activeOrders.find(o => {
      const isSameInterno = String(o.interno).trim() === String(interno);
      if (!isSameInterno) return false;
      if (o.estadoUnidad !== 'fuera_de_servicio') return false;
      const isSameClasif = String(o.clasificacion || '').trim().toLowerCase() === String(clasificacion || '').trim().toLowerCase();
      if (!isSameClasif) return false;

      // Separate Herrería/Edilicio from Taller:
      const orderIsHerreria = isHerreriaOrder(o);
      const orderIsEdilicio = isEdilicioOrder(o);

      if (userSector === 'Herrería') {
        return orderIsHerreria;
      } else if (userSector === 'Edilicio') {
        return orderIsEdilicio;
      } else {
        // Taller user: only match existing Taller orders (NOT Herrería or Edilicio)
        return !orderIsHerreria && !orderIsEdilicio;
      }
    });
  }

  if (existingOrder) {
    const orderCls = existingOrder.clasificacion || "Sin Clasificar";
    showToast(`Abriendo orden en curso de Taller del interno ${interno} (${orderCls})...`, "warning");
    closePreOrderModal();
    editOrder(existingOrder.id);
  } else {
    // Read checked pending-items BEFORE closing the modal (closing just hides it, but
    // let's not depend on that - grab the selection while it's still guaranteed live).
    const items = window._preOrderPendingItems || [];
    const checkedIndices = Array.from(document.querySelectorAll('#pre-order-pending-items-list input[type="checkbox"]:checked'))
      .map(cb => parseInt(cb.dataset.idx, 10));
    const selectedItems = checkedIndices.map(idx => items[idx]).filter(Boolean);

    // Default: one task per selected item. If more than one is selected, ask how many
    // tasks to group them into (e.g. 2 items -> 1 task means both go in the SAME task).
    let taskGroups = selectedItems.map(item => [item]);
    if (selectedItems.length > 1) {
      const input = window.prompt(
        `Seleccionaste ${selectedItems.length} ítems. ¿En cuántas tareas los agrupamos?`,
        String(selectedItems.length)
      );
      if (input === null) return; // cancelled: stay on the pre-order modal, nothing created
      const parsed = parseInt(input, 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= selectedItems.length) {
        taskGroups = splitItemsIntoGroups(selectedItems, parsed);
      }
    }

    closePreOrderModal();
    openNewOrderModal(interno, clasificacion);

    if (taskGroups.length > 0) {
      taskGroups.forEach(group => {
        addTaskField({
          centroCosto: mapRubroToCentroCosto(group[0].tipo),
          empleado: "",
          horasEstimadas: 0,
          status: "Pendiente",
          descripcion: group.map(i => i.texto).join(' / ')
        });
      });
    } else {
      // No item selected: don't make the user click "Agregar Tarea" for nothing. Call with no
      // taskData (not an object with blank fields) so addTaskField's own per-sector default
      // (Taller->Mecánica, Herrería->Herrería, Edilicio->Edilicio) actually applies to Centro
      // de Costo - passing an object with centroCosto:"" bypassed that default entirely, since
      // addTaskField only uses it when taskData is exactly null.
      addTaskField();
    }
  }
}

// Splits items into exactly `groupCount` contiguous, balanced groups (never empty,
// as long as groupCount <= items.length) so several pending items can share one task.
function splitItemsIntoGroups(items, groupCount) {
  const result = [];
  const base = Math.floor(items.length / groupCount);
  let remainder = items.length % groupCount;
  let idx = 0;
  for (let g = 0; g < groupCount; g++) {
    const size = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    result.push(items.slice(idx, idx + size));
    idx += size;
  }
  return result;
}

// Novelties for this interno that haven't already been turned into a Finalizada
// task in some active order (same filter used by the big order form's sidebar).
function getUncompletedNoveltiesForInterno(interno) {
  // Disposed per user rule: Old Google Sheets novelties are disabled so they never cross-contaminate orders
  return [];
}

// Renders the pending-items shortcut list in "Identificar Unidad" (pre-order-modal)
// once a Rodado/Interno is selected, so a task can be created straight from a novelty
// or a Parte Taller pending service.
function refreshPreOrderPendingItems() {
  const group = document.getElementById('pre-order-pending-items-group');
  const list = document.getElementById('pre-order-pending-items-list');
  if (!group || !list) return;

  const preInternoSelect = document.getElementById('pre-form-interno');
  const preInternoText = document.getElementById('pre-form-interno-text');
  let interno = preInternoSelect ? preInternoSelect.value.trim() : "";
  if (!interno && preInternoText && preInternoText.value) {
    interno = preInternoText.value.trim();
  }

  if (!interno) {
    group.style.display = 'none';
    list.innerHTML = '';
    window._preOrderPendingItems = [];
    return;
  }

  const novelties = getUncompletedNoveltiesForInterno(interno).map(n => ({
    texto: [n.rubro, n.subrubro, n.observacion].filter(Boolean).join(' - '),
    tipo: n.rubro
  }));
  const pendingServices = (typeof getPendingServiceEntriesForInterno === 'function')
    ? getPendingServiceEntriesForInterno(interno)
    : [];
  const items = [...novelties, ...pendingServices];

  window._preOrderPendingItems = items;
  group.style.display = 'block';

  if (items.length === 0) {
    list.innerHTML = '<p style="font-size:12px; color:var(--text-muted); margin:0;">No hay ítems pendientes para esta unidad.</p>';
    return;
  }

  const originColors = {
    transito: '#0288d1',
    servicios_pendientes: '#2196f3',
    reparacion: '#f59e0b',
    fuera_de_servicio: '#ef4444'
  };

  list.innerHTML = items.map((item, idx) => {
    const originColor = originColors[item.origen] || 'var(--text-muted)';
    const originBadge = item.origenLabel
      ? `<span class="badge" style="background:${originColor}; color:white; font-size:10px; white-space:nowrap;">${escapeHtml(item.origenLabel)}</span>`
      : '';
    return `
    <label style="display:flex; align-items:center; gap:8px; padding:10px 12px; border:1px solid var(--border-color); border-radius:8px; cursor:pointer;">
      <input type="checkbox" data-idx="${idx}" style="width:18px; height:18px; flex-shrink:0; accent-color:var(--primary);">
      <span style="font-size:13px; flex:1;">${escapeHtml(item.texto)}</span>
      ${originBadge}
    </label>`;
  }).join('');
}

function openNewOrderModal(presetInterno = "", presetClasificacion = "") {
  console.log("[openNewOrderModal] presetInterno:", presetInterno, "presetClasificacion:", presetClasificacion);
  currentEditingOrderId = null;
  deletedTaskIdsInModal = new Set();
  document.getElementById('modal-order-title').textContent = "Nueva Orden de Trabajo";
  
  const modal = document.getElementById('new-order-modal');
  modal.classList.remove('readonly-mode');
  modal.classList.add('open');
  // Reset form
  document.getElementById('work-order-form').reset();
  
  // Set up input vs select based on user sector
  setupAllFieldsForSector();

  const userSector = getSectorByUsername(localStorage.getItem('currentUserUsername'));
  const isHerreria = (userSector === 'Herrería');
  const cleanInterno = String(presetInterno || '').trim();
  const rodadoOpt = findRodadoForInterno(cleanInterno);
  console.log("[openNewOrderModal] found rodadoOpt:", rodadoOpt);

  // 1. Populate Interno select options FIRST before setting any values
  const internoSelect = document.getElementById('form-interno');
  if (internoSelect) {
    if (cachedInternoOptions && cachedInternoOptions.length > 0) {
      populateSelect('form-interno', cachedInternoOptions, "Seleccionar Interno...");
    }
  }

  // 2. Auto-select matching Rodado
  const rodadoSelect = document.getElementById('form-rodado');
  if (rodadoSelect) {
    const matchedOpt = findRodadoOption(rodadoSelect, cleanInterno, rodadoOpt);
    if (matchedOpt) {
      rodadoSelect.value = matchedOpt.value;
    } else {
      rodadoSelect.value = "";
    }
    if (rodadoSelect.rebuildSearchable) {
      rodadoSelect.rebuildSearchable();
    }
  }
  const rodadoText = document.getElementById('form-rodado-text');
  if (rodadoText) {
    rodadoText.value = "";
  }
  
  // 3. Auto-populate Interno value
  if (internoSelect) {
    if (cleanInterno) {
      let optionExists = Array.from(internoSelect.options).some(opt => opt.value === cleanInterno);
      if (!optionExists) {
        const newOpt = document.createElement('option');
        newOpt.value = cleanInterno;
        newOpt.textContent = cleanInterno;
        internoSelect.appendChild(newOpt);
      }
      internoSelect.value = cleanInterno;
    } else {
      internoSelect.value = "";
    }
    if (internoSelect.rebuildSearchable) {
      internoSelect.rebuildSearchable();
    }
  }
  
  const internoText = document.getElementById('form-interno-text');
  if (internoText) {
    internoText.value = isHerreria ? cleanInterno : "";
  }

  // 4. Auto-populate Clasificación
  const clasificacionEl = document.getElementById('form-clasificacion');
  if (clasificacionEl) {
    const isHerreriaTabOrUser = isHerreria || currentSelectedSector === 'Herrería';
    // Edilicio has no real Taxes clasificacion value (see server.js's getOrderSector) - that
    // sector is identified by the task's Centro de Costo, not by this field, so it defaults
    // to "Correctivo" same as Taller.
    clasificacionEl.value = presetClasificacion || (isHerreriaTabOrUser ? 'Herrería' : 'Correctivo');
  }

  // 4.5 Pre-select Responsable with whoever is logged in - the payload used to always send
  // the literal string "AUTO" regardless of what this field showed, so it never mattered what
  // was selected here; now it does, so default it to the real person instead of leaving
  // whatever was left selected from a previously edited order. Options are keyed by numeric
  // catalog id, not by name, so match by the option's visible text.
  const responsableSelectEl = document.getElementById('form-responsable');
  if (responsableSelectEl) {
    // The Edilicio/Herrería TAB decides the responsable here, not who happens to be logged
    // in - someone using the shared device account can create an Edilicio order without
    // logging in as Toledo specifically, and it still needs Toledo as responsable, not
    // whoever's session it was created under.
    let mappedResponsable;
    if (currentSelectedSector === 'Edilicio') {
      mappedResponsable = 'Toledo, Fernando Damián';
    } else if (currentSelectedSector === 'Herrería') {
      mappedResponsable = 'Carmona González, Juan Manuel';
    } else {
      mappedResponsable = CREATOR_USERNAME_TO_RESPONSABLE[String(localStorage.getItem('currentUserUsername') || '').toLowerCase().trim()];
    }
    const matchedOpt = mappedResponsable
      ? Array.from(responsableSelectEl.options).find(opt => opt.textContent.trim() === mappedResponsable)
      : null;
    responsableSelectEl.value = matchedOpt ? matchedOpt.value : "";
  }

  // Re-run setupAllFieldsForSector now that Clasificación has been populated!
  setupAllFieldsForSector();
  
  // Reset dates
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  document.getElementById('form-fecha').value = `${yyyy}-${mm}-${dd}`;
  
  const hh = String(today.getHours()).padStart(2, '0');
  const min = String(today.getMinutes()).padStart(2, '0');
  document.getElementById('form-hora').value = `${hh}:${min}`;

  // Clear task fields
  const container = document.getElementById('modal-tasks-list');
  container.innerHTML = `
    <div class="tasks-empty-state" id="tasks-empty-state">
      <span class="material-icons">assignment_late</span>
      <p>No hay tareas asignadas.</p>
      <small>Haz clic en "AGREGAR TAREA" para crear la primera tarea.</small>
    </div>
  `;
  updateTaskCountBadge();
  
  // Show novelties/pending-items panel for the preselected unit (empty interno hides it)
  showNoveltiesForInterno(cleanInterno);
}

function closeNewOrderModal() {
  const modal = document.getElementById('new-order-modal');
  modal.classList.remove('open', 'readonly-mode');
  currentEditingOrderId = null;
  currentCombustibleReset = null;
  
  // Hide novelties panel
  showNoveltiesForInterno("");
}

function editOrder(orderId) {
  let order = activeOrders.find(o => o.id === orderId);
  if (!order && typeof archivedOrders !== 'undefined' && Array.isArray(archivedOrders)) {
    order = archivedOrders.find(o => o.id === orderId);
  }
  if (!order) return;

  currentEditingOrderId = orderId;
  deletedTaskIdsInModal = new Set();

  // Set modal title
  document.getElementById('modal-order-title').textContent = "Editar Orden de Trabajo";

  // Ensure NOT read-only
  document.getElementById('new-order-modal').classList.remove('readonly-mode');

  // Open modal
  document.getElementById('new-order-modal').classList.add('open');

  // Set up input vs select based on user sector
  setupAllFieldsForSector();

  // Find corresponding Rodado value in cachedCatalogs (robust: case-insensitive, trimmed)
  const rodadoSelect = document.getElementById('form-rodado');
  const rodadoText = document.getElementById('form-rodado-text');
  const cleanRodado = String(order.rodado || '').trim().toUpperCase();
  const rodadoOpt = cachedCatalogs.rodados.find(r =>
    String(r.label || '').trim().toUpperCase() === cleanRodado ||
    String(r.value || '').trim() === String(order.rodado || '').trim()
  );
  if (rodadoOpt) {
    rodadoSelect.value = rodadoOpt.value;
  } else {
    // If no exact match, try to add as option so it doesn't reset
    if (order.rodado) {
      const newOpt = document.createElement('option');
      newOpt.value = order.rodado;
      newOpt.textContent = order.rodado;
      rodadoSelect.appendChild(newOpt);
      rodadoSelect.value = order.rodado;
    } else {
      rodadoSelect.value = "";
    }
  }
  if (rodadoSelect.rebuildSearchable) {
    rodadoSelect.rebuildSearchable();
  }
  if (rodadoText) {
    rodadoText.value = order.rodado || "";
  }
  const internoText = document.getElementById('form-interno-text');
  if (internoText) {
    internoText.value = order.interno || "";
  }

  // Populate basic inputs
  const internoSelect = document.getElementById('form-interno');
  if (internoSelect) {
    if (order.interno) {
      let optionExists = Array.from(internoSelect.options).some(opt => opt.value === order.interno);
      if (!optionExists) {
        const newOpt = document.createElement('option');
        newOpt.value = order.interno;
        newOpt.textContent = order.interno;
        internoSelect.appendChild(newOpt);
      }
      internoSelect.value = order.interno;
    } else {
      internoSelect.value = "";
    }
    if (internoSelect.rebuildSearchable) {
      internoSelect.rebuildSearchable();
    }
  }

  const clasifSelect = document.getElementById('form-clasificacion');
  if (clasifSelect) {
    clasifSelect.value = order.clasificacion || '';
    if (order.clasificacion && !clasifSelect.value) {
      const cleanVal = order.clasificacion.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
      const matchedOpt = Array.from(clasifSelect.options).find(opt => {
        const cleanOpt = (opt.value || opt.textContent || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        return cleanOpt === cleanVal;
      });
      if (matchedOpt) {
        clasifSelect.value = matchedOpt.value;
      }
    }
  }
  setupAllFieldsForSector();
  const areaSelectEdit = document.getElementById('form-area-edilicio');
  if (areaSelectEdit) areaSelectEdit.value = order.area || '';
  document.getElementById('form-incidente').value = order.incidente;
  document.getElementById('form-fecha').value = order.fechaEntrega;
  document.getElementById('form-hora').value = order.horario;

  // Clear modal tasks
  const container = document.getElementById('modal-tasks-list');
  container.innerHTML = "";

  // Populate tasks
  const validTasks = (order.tasks || []).filter(t => t !== null && t !== undefined);
  if (validTasks.length > 0) {
    validTasks.forEach(t => {
      addTaskField(t);
    });
  } else {
    container.innerHTML = `
      <div class="tasks-empty-state" id="tasks-empty-state">
        <span class="material-icons">assignment_late</span>
        <p>No hay tareas asignadas.</p>
        <small>Haz clic en "AGREGAR TAREA" para crear la primera tarea.</small>
      </div>
    `;
    updateTaskCountBadge();
  }
  
  // Show novelties side panel if present
  showNoveltiesForInterno(order.interno);
}

function viewOrder(orderId) {
  const order = activeOrders.find(o => o.id === orderId) || archivedOrders.find(o => o.id === orderId);
  if (!order) return;

  // Open in read-only mode (no save, no edit)
  currentEditingOrderId = null;
  deletedTaskIdsInModal = new Set();

  // Set modal title with sync date
  const syncDate = order.syncDate ? ` — Subida: ${new Date(order.syncDate).toLocaleDateString('es-AR')}` : '';
  document.getElementById('modal-order-title').textContent = `Ver Orden${syncDate}`;

  // Mark modal as readonly
  const modal = document.getElementById('new-order-modal');
  modal.classList.add('open', 'readonly-mode');

  // Set up input vs select based on user sector
  setupAllFieldsForSector();

  // Find corresponding Rodado value in cachedCatalogs (robust: case-insensitive, trimmed)
  const rodadoSelect = document.getElementById('form-rodado');
  const rodadoText = document.getElementById('form-rodado-text');
  const cleanRodado = String(order.rodado || '').trim().toUpperCase();
  const rodadoOpt = cachedCatalogs.rodados.find(r =>
    String(r.label || '').trim().toUpperCase() === cleanRodado ||
    String(r.value || '').trim() === String(order.rodado || '').trim()
  );
  if (rodadoOpt) {
    rodadoSelect.value = rodadoOpt.value;
  } else {
    if (order.rodado) {
      const newOpt = document.createElement('option');
      newOpt.value = order.rodado;
      newOpt.textContent = order.rodado;
      rodadoSelect.appendChild(newOpt);
      rodadoSelect.value = order.rodado;
    } else {
      rodadoSelect.value = "";
    }
  }
  if (rodadoSelect.rebuildSearchable) {
    rodadoSelect.rebuildSearchable();
  }
  if (rodadoText) {
    rodadoText.value = order.rodado || "";
  }
  const internoText = document.getElementById('form-interno-text');
  if (internoText) {
    internoText.value = order.interno || "";
  }

  // Populate basic inputs
  const internoSelect = document.getElementById('form-interno');
  if (internoSelect) {
    if (order.interno) {
      let optionExists = Array.from(internoSelect.options).some(opt => opt.value === order.interno);
      if (!optionExists) {
        const newOpt = document.createElement('option');
        newOpt.value = order.interno;
        newOpt.textContent = order.interno;
        internoSelect.appendChild(newOpt);
      }
      internoSelect.value = order.interno;
    } else {
      internoSelect.value = "";
    }
    if (internoSelect.rebuildSearchable) {
      internoSelect.rebuildSearchable();
    }
  }
  document.getElementById('form-clasificacion').value = order.clasificacion;
  setupAllFieldsForSector();
  const areaSelectView = document.getElementById('form-area-edilicio');
  if (areaSelectView) areaSelectView.value = order.area || '';
  document.getElementById('form-incidente').value = order.incidente || '';
  document.getElementById('form-fecha').value = order.fechaEntrega;
  document.getElementById('form-hora').value = order.horario;

  // Clear modal tasks
  const container = document.getElementById('modal-tasks-list');
  container.innerHTML = "";

  // Populate tasks (read-only, no timers)
  const validTasksView = (order.tasks || []).filter(t => t !== null && t !== undefined);
  if (validTasksView.length > 0) {
    validTasksView.forEach(t => {
      addTaskField(t);
    });
  } else {
    container.innerHTML = `
      <div class="tasks-empty-state" id="tasks-empty-state">
        <span class="material-icons">assignment_late</span>
        <p>No hay tareas asignadas.</p>
      </div>
    `;
    updateTaskCountBadge();
  }
  
  // Clear/Hide novelties side panel in read-only mode
  showNoveltiesForInterno("");
}

function openErrorModal(errorLog, orderId) {
  currentRetryOrderId = orderId;
  // Look up the real, current error from the loaded orders list by ID —
  // safer than embedding the raw error text directly into the HTML/onclick,
  // which could break if the error message contains quotes or backticks.
  if (!errorLog && orderId) {
    const order = (activeOrders || []).find(o => o.id === orderId);
    errorLog = order ? order.syncError : null;
  }
  document.getElementById('error-modal-log').textContent = errorLog || "Error desconocido durante la sincronización.";
  document.getElementById('error-modal').classList.add('open');
}

function closeErrorModal() {
  document.getElementById('error-modal').classList.remove('open');
  currentRetryOrderId = null;
}

// 3. FETCH CONFIGURATION & SETTINGS
async function fetchSettings() {
  try {
    // Pass current user so server returns THIS user's credentials, not global ones
    const currentUsername = localStorage.getItem('currentUserUsername') || '';
    const qs = currentUsername ? `?username=${encodeURIComponent(currentUsername)}&_=${Date.now()}` : `?_=${Date.now()}`;
    const res = await fetch(`/api/settings${qs}`);
    if (!res.ok) throw new Error("Error fetching settings");
    const data = await res.json();
    
    document.getElementById('set-portal-url').value = data.portalUrl || "https://taxes.com.ar";
    document.getElementById('set-username').value = data.username || "";
    document.getElementById('set-password').value = data.password || "";
    const insumosUrlInput = document.getElementById('set-google-insumos-url');
    if (insumosUrlInput) insumosUrlInput.value = data.googleScriptUrl || "";
    const activeTasksInput = document.getElementById('set-google-active-tasks-url');
    if (activeTasksInput) {
      activeTasksInput.value = data.googleActiveTasksUrl || "";
    }
    const prevScriptInput = document.getElementById('set-preventivo-script-url');
    if (prevScriptInput) prevScriptInput.value = data.preventivoScriptUrl || "";
    const ptScriptInput = document.getElementById('set-partetaller-script-url');
    if (ptScriptInput) ptScriptInput.value = data.parteTallerScriptUrl || "";
    const geminiApiKeyInput = document.getElementById('set-gemini-api-key');
    if (geminiApiKeyInput) geminiApiKeyInput.value = data.geminiApiKey || "";
    const claudeApiKeyInput = document.getElementById('set-claude-api-key');
    if (claudeApiKeyInput) claudeApiKeyInput.value = data.claudeApiKey || "";
    
    isCurrentUserSupervisor = !!data.isSupervisor;
    const hoursSection = document.getElementById('supervisor-hours-section');
    if (hoursSection) {
      hoursSection.style.display = isCurrentUserSupervisor ? 'block' : 'none';
      if (isCurrentUserSupervisor) {
        renderEmployeeHoursSummary();
      }
    }

    // NOTE: DO NOT set current-user from server settings —
    // the header always shows the locally logged-in user (from localStorage)
    // checkUserSession() already handles this correctly on login.
    
    updateCatalogSyncUI(data);
  } catch (error) {
    console.error("Error fetching settings:", error);
  }
}

async function saveSettings(e) {
  e.preventDefault();
  
  const portalUrl = document.getElementById('set-portal-url').value;
  const username = document.getElementById('set-username').value;
  const password = document.getElementById('set-password').value;
  const googleScriptUrl = document.getElementById('set-google-insumos-url')?.value || '';
  const googleActiveTasksUrl = document.getElementById('set-google-active-tasks-url')?.value || '';
  const preventivoScriptUrl = document.getElementById('set-preventivo-script-url')?.value || '';
  const parteTallerScriptUrl = document.getElementById('set-partetaller-script-url')?.value || '';
  const geminiApiKey = document.getElementById('set-gemini-api-key')?.value || '';
  const claudeApiKey = document.getElementById('set-claude-api-key')?.value || '';
  const currentUsername = localStorage.getItem('currentUserUsername') || '';

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-username': currentUsername  // Tell server which user is saving
      },
      body: JSON.stringify({ portalUrl, username, password, googleScriptUrl, googleActiveTasksUrl, preventivoScriptUrl, parteTallerScriptUrl, geminiApiKey, claudeApiKey })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Error al comunicarse con el servidor");
    }
    const data = await res.json();
    
    if (password && password !== "••••••••••••") {
      localStorage.setItem('currentUserPassword', password);
    }
    showToast("Ajustes guardados correctamente", "success");
    // NOTE: DO NOT overwrite current-user here — header always shows localStorage user
    
    // Automatically trigger catalog sync on credentials save
    triggerCatalogSync();
  } catch (error) {
    showToast(`Error al guardar ajustes: ${error.message}`, "danger");
    console.error(error);
  }
}

async function testGoogleInsumosConnection() {
  const url = document.getElementById('set-google-insumos-url')?.value.trim();
  if (!url) {
    showToast("Por favor, ingresa una URL primero", "warning");
    return;
  }

  const btn = document.getElementById('btn-test-google-insumos');
  const originalText = btn ? btn.textContent : 'Probar';
  if (btn) { btn.textContent = "..."; btn.disabled = true; }

  try {
    // Test the doGet with action=addInsumo test param
    const testUrl = `${url}${url.includes('?') ? '&' : '?'}action=addInsumo&interno=TEST&insumo=TEST&cantidad=1&empleado=TEST&supervisor=TEST&numeroOrden=0`;
    const res = await fetch(`/api/settings/test-google-sheet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: testUrl })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP error ${res.status}`);
    }

    const data = await res.json();
    if (data.status === 'success' || data.status === 'not_found') {
      showToast("¡Conexión con Google Sheets Insumos/Pañol exitosa!", "success");
    } else {
      showToast(`Error del script: ${data.message || 'Desconocido'}`, "danger");
    }
  } catch (error) {
    console.error(error);
    showToast(`Falló la conexión: ${error.message}. Verificá que esté publicado como 'Cualquiera'.`, "danger");
  } finally {
    if (btn) { btn.textContent = originalText; btn.disabled = false; }
  }
}

async function testGoogleActiveTasksConnection() {
  const url = document.getElementById('set-google-active-tasks-url').value.trim();
  if (!url) {
    showToast("Por favor, ingresa una URL primero", "warning");
    return;
  }

  const btn = document.getElementById('btn-test-google-active-tasks');
  const originalText = btn.textContent;
  btn.textContent = "...";
  btn.disabled = true;

  try {
    const res = await fetch('/api/settings/test-google-active-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP error ${res.status}`);
    }

    const data = await res.json();
    if (data.status === 'success' || data.status === 'not_found') {
      showToast("¡Conexión con Google Sheets de Tareas Activas exitosa!", "success");
    } else {
      showToast(`Error del script: ${data.message || 'Desconocido'}`, "danger");
    }
  } catch (error) {
    console.error(error);
    showToast(`Falló la conexión: ${error.message}. Verifica haberlo publicado como 'Cualquiera' (Anyone).`, "danger");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// 4. SYNC DROP-DOWN CATALOGS FROM WEBSITE
async function triggerCatalogSync() {
  try {
    const res = await fetch('/api/catalogs/sync', { method: 'POST' });
    if (!res.ok) throw new Error("Failed to trigger sync");
    
    showToast("Conexión con Taxes iniciada", "warning");
  } catch (error) {
    showToast("Error al iniciar conexión", "danger");
  }
}

async function fetchSettingsPolling() {
  // Only update connection UI status, don't overwrite input values while user is typing
  try {
    const res = await fetch(`/api/settings?_=${Date.now()}`);
    if (res.ok) {
      const data = await res.json();
      lastKnownSettings = data;
      updateCatalogSyncUI(data);
    }
  } catch (e) {}
}

let lastSyncStatus = "idle";
let lastKnownSettings = null;

function updateCatalogSyncUI(settings) {
  const btn = document.getElementById('btn-sync-catalogs');
  const spinner = document.getElementById('catalog-sync-spinner');
  const btnText = document.getElementById('catalog-sync-text');
  const statusText = document.getElementById('catalog-status-text');

  if (!statusText || !btn) return;

  const status = settings.catalogSyncStatus || "idle";
  const error = settings.catalogSyncError || "";

  // Trigger catalog reload when transitions from syncing to success
  if (lastSyncStatus === "syncing" && status === "success") {
    fetchCatalogs();
    showToast("Conexión exitosa y catálogos actualizados", "success");
  } else if (lastSyncStatus === "syncing" && status === "error") {
    showToast("Fallo al conectar con Taxes", "danger");
  }
  
  lastSyncStatus = status;

  if (status === "syncing") {
    btn.disabled = true;
    spinner.style.animation = "spin 1s linear infinite";
    btnText.textContent = "Conectando...";
    statusText.style.color = "var(--warning)";
    statusText.innerHTML = `<span class="material-icons" style="font-size:14px; vertical-align:middle; animation: spin 1.5s linear infinite;">sync</span> Iniciando conexión con Taxes.com.ar...`;
  } else if (status === "success") {
    btn.disabled = false;
    spinner.style.animation = "none";
    btnText.textContent = "Sincronizar Catálogos desde Taxes";
    statusText.style.color = "var(--success)";
    statusText.style.fontWeight = "600";
    statusText.innerHTML = `✓ Conectado con éxito a Taxes. Catálogos listos.`;
  } else if (status === "error") {
    btn.disabled = false;
    spinner.style.animation = "none";
    btnText.textContent = "Reintentar Conexión";
    statusText.style.color = "var(--danger)";
    statusText.style.fontWeight = "600";
    statusText.innerHTML = `⚠ Error de conexión: ${error.substring(0, 80)}${error.length > 80 ? '...' : ''}`;
  } else {
    btn.disabled = false;
    spinner.style.animation = "none";
    btnText.textContent = "Sincronizar Catálogos desde Taxes";
    // Check if we have real catalog data loaded
    const rodadosCount = (cachedCatalogs && cachedCatalogs.rodados) ? cachedCatalogs.rodados.length : 0;
    const empleadosCount = (cachedCatalogs && cachedCatalogs.empleados) ? cachedCatalogs.empleados.length : 0;
    if (rodadosCount > 5) {
      statusText.style.color = "var(--success)";
      statusText.style.fontWeight = "600";
      statusText.innerHTML = `✓ Catálogos de Taxes listos: ${rodadosCount} vehículos, ${empleadosCount} operarios.`;
    } else {
      statusText.style.color = "var(--text-muted)";
      statusText.style.fontWeight = "";
      statusText.innerHTML = `Catálogos no sincronizados. Hacé clic para conectar con Taxes.`;
    }
  }
}

async function checkWorkerStatus() {
  try {
    const res = await fetch('/api/worker/status');
    const data = await res.json();
    const icon = document.getElementById('global-sync-icon');
    
    if (data.isScraping) {
      icon.className = "material-icons sync-indicator active";
    } else {
      // Check if any order is currently syncing
      const hasSyncingOrders = activeOrders.some(o => o.syncStatus === 'syncing');
      if (hasSyncingOrders) {
        icon.className = "material-icons sync-indicator active";
      } else {
        icon.className = "material-icons sync-indicator idle";
      }
    }
  } catch (e) {
    // Ignore network polls errors silently
  }
}

// 5. CATALOG DATA & DROPDOWNS POPULATION
async function fetchCatalogs() {
  try {
    const res = await fetch('/api/catalogs');
    if (!res.ok) throw new Error("Error fetching catalogs");
    const data = await res.json();
    
    // --- FALLBACK: if catalogs never synced (empty arrays), use hardcoded defaults ---
    // This prevents task creation from failing when Puppeteer can't reach Taxes
    const FALLBACK_CENTROS_COSTO = [
      { value: '15', label: 'MECANICA' },
      { value: '16', label: 'HERRERIA' },
      { value: '17', label: 'EDILICIO' },
      { value: '18', label: 'LAVADO' },
      { value: '19', label: 'ADMINISTRACION' }
    ];
    if (!data.centrosCosto || data.centrosCosto.length === 0) {
      data.centrosCosto = FALLBACK_CENTROS_COSTO;
    }
    if (!data.empleados || data.empleados.length === 0) {
      // Build fallback employees from hardcoded lists
      const fallbackEmps = [...new Set([...MECANICA_EMPLOYEES, ...HERRERIA_EMPLOYEES])];
      data.empleados = fallbackEmps.map(name => ({ value: name, label: name }));
    }

    cachedCatalogs = {
      rodados: data.rodados || [],
      responsables: data.responsables || [],
      empleados: data.empleados || [],
      centrosCosto: data.centrosCosto || []
    };
    
    // Populate form dropdowns
    populateSelect('form-rodado', data.rodados, "Seleccionar Rodado...");
    populateSelect('form-responsable', data.responsables, "Seleccionar Responsable...");

    // Extract unique internal numbers from rodados catalog and active orders
    const rawInternos = (data.rodados || []).map(r => {
      return String(r.interno || r.value || '').trim();
    }).filter(Boolean);
    if (Array.isArray(activeOrders)) {
      activeOrders.forEach(o => {
        if (o.interno) rawInternos.push(String(o.interno).trim());
      });
    }

    const uniqueInternos = [...new Set(rawInternos)].filter(Boolean);
    uniqueInternos.sort((a, b) => {
      const numA = parseInt(a, 10);
      const numB = parseInt(b, 10);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });

    const internoOptions = uniqueInternos.map(int => {
      const r = (data.rodados || []).find(r => r && String(r.interno || r.value || '').trim() === int);
      let label = int;
      if (r && r.modelo) {
        label = `${int} - ${r.modelo}` + (r.equipo ? ` (${r.equipo})` : '');
      }
      return { value: int, label: label };
    });
    cachedInternoOptions = internoOptions;
    populateSelect('form-interno', internoOptions, "Seleccionar Interno...");
    populateSelect('pre-form-interno', internoOptions, "Seleccionar Interno...");

    // Populate Parte Taller datalist for internal selection
    const ptDatalist = document.getElementById('pt-interno-list');
    if (ptDatalist) {
      ptDatalist.innerHTML = uniqueInternos.map(int => `<option value="${int}"></option>`).join('');
    }

    // Convert select elements to searchable selects
    convertSelectToSearchable(document.getElementById('form-rodado'));
    convertSelectToSearchable(document.getElementById('form-interno'));
    convertSelectToSearchable(document.getElementById('pre-form-interno'));

    // Initialize Carga Masiva tasks
    const bulkContainer = document.getElementById('bulk-tasks-container');
    if (bulkContainer) {
      bulkContainer.innerHTML = '';
      activePreventivoTypes = new Set();
      syncPreventivoButtons();
      addBulkTaskField();
    }
    
    // Render the bulk vehicle selector list
    renderBulkVehicleSelector();

    // Update catalog status UI now that cachedCatalogs is populated
    if (lastKnownSettings) {
      updateCatalogSyncUI(lastKnownSettings);
    } else if (data.rodados && data.rodados.length > 5) {
      const statusEl = document.getElementById('catalog-status-text');
      if (statusEl) {
        statusEl.style.color = 'var(--success)';
        statusEl.style.fontWeight = '600';
        statusEl.innerHTML = `✓ Catálogos de Taxes listos: ${data.rodados.length} vehículos, ${(data.empleados||[]).length} operarios.`;
      }
    }

    // Refresh UI since catalogs are now available
    if (activeOrders && activeOrders.length > 0) {
      renderOrders();
    }
  } catch (error) {
    console.error("Error loading catalogs:", error);
  }
}

async function fetchAreasEdilicio() {
  try {
    const res = await fetch('/api/areas-edilicio');
    if (!res.ok) throw new Error("Error fetching areas edilicio");
    const data = await res.json();
    cachedAreasEdilicio = Array.isArray(data.areas) ? data.areas : [];
    populateAreaEdilicioSelect();
  } catch (error) {
    console.error("Error loading areas edilicio:", error);
  }
}

function populateAreaEdilicioSelect(selectedValue) {
  const select = document.getElementById('form-area-edilicio');
  if (!select) return;
  const preserve = selectedValue !== undefined ? selectedValue : select.value;
  select.innerHTML = '<option value="">Seleccionar área...</option>' +
    cachedAreasEdilicio.map(a => `<option value="${a.replace(/"/g, '&quot;')}">${a}</option>`).join('') +
    '<option value="__new__">+ Agregar área nueva...</option>';
  if (preserve && preserve !== '__new__') {
    const exists = Array.from(select.options).some(opt => opt.value === preserve);
    if (exists) select.value = preserve;
  }
}

function onFormAreaEdilicioChange() {
  const select = document.getElementById('form-area-edilicio');
  const newRow = document.getElementById('form-area-edilicio-new-row');
  if (!select || !newRow) return;
  if (select.value === '__new__') {
    newRow.style.display = 'flex';
    const input = document.getElementById('form-area-edilicio-new-input');
    if (input) input.focus();
  } else {
    newRow.style.display = 'none';
  }
}

async function saveNewAreaEdilicio() {
  const input = document.getElementById('form-area-edilicio-new-input');
  const nombre = input ? input.value.trim() : '';
  if (!nombre) {
    return showToast("Escribí un nombre para la nueva área.", "danger");
  }
  try {
    const res = await fetch('/api/areas-edilicio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre })
    });
    if (!res.ok) throw new Error("Error al guardar el área");
    const data = await res.json();
    cachedAreasEdilicio = Array.isArray(data.areas) ? data.areas : cachedAreasEdilicio;
    populateAreaEdilicioSelect(nombre);
    const newRow = document.getElementById('form-area-edilicio-new-row');
    if (newRow) newRow.style.display = 'none';
    if (input) input.value = '';
    showToast("Área agregada.", "success");
  } catch (error) {
    showToast("No se pudo guardar el área.", "danger");
  }
}

function populateSelect(selectId, options, placeholder) {
  const select = document.getElementById(selectId);
  if (!select) return;

  select.innerHTML = `<option value="">${placeholder}</option>`;
  
  if (options && options.length > 0) {
    options.forEach(opt => {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      select.appendChild(el);
    });
  }
}

// 6. DYNAMIC TASKS GENERATION (Inside Modal Form)
function updateTaskCountBadge() {
  const container = document.getElementById('modal-tasks-list');
  const taskCards = container.querySelectorAll('.task-item-card');
  const count = taskCards.length;
  
  document.getElementById('task-count-badge').textContent = count;
  
  const emptyState = document.getElementById('tasks-empty-state');
  if (count > 0 && emptyState) {
    emptyState.style.display = 'none';
  } else if (count === 0 && emptyState) {
    emptyState.style.display = 'block';
  }
}

function updateEmployeeDropdownForCard(card) {
  try {
    const ccSelect = card.querySelector('.task-cc');
    const empSelect = card.querySelector('.task-emp');
    if (!ccSelect || !empSelect) return;

    const selectedCc = ccSelect.value;
    const currentValue = empSelect.value;

    const currentUser = localStorage.getItem('currentUserUsername');
    const userSector = getSectorByUsername(currentUser);

    let filteredEmployees = cachedCatalogs.empleados || [];

    // Detect sector by label text of the selected CC option (robust, not hardcoded)
    const selectedOption = ccSelect.options && ccSelect.selectedIndex >= 0 ? ccSelect.options[ccSelect.selectedIndex] : null;
    const selectedLabel = selectedOption ? String(selectedOption.textContent || '').trim().toUpperCase() : '';
    const isHerreriaCC = selectedLabel.includes('HERRER') || selectedCc === "HERRERIA" || selectedCc === "16" || userSector === 'Herrería';
    const isMecanicaCC = selectedLabel.includes('MECAN') || selectedCc === "15" || selectedCc === "MECANICA";
    const isEdilicioCC = selectedLabel.includes('EDILIC') || selectedCc === "EDILICIO" || selectedCc === "8" || userSector === 'Edilicio';

    const cleanName = (str) => {
      if (typeof str !== 'string') return '';
      return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
    };

    if (isHerreriaCC) {
      // Herrería filter with dynamic mapped employees
      const herreriaNames = getSectorEmployees('Herrería');
      const herreriaNamesCleaned = new Set(herreriaNames.map(name => cleanName(name)));
      
      let matchedEmployees = (cachedCatalogs.empleados || []).filter(emp => {
        if (!emp || !emp.label) return false;
        const empCleaned = cleanName(emp.label);
        if (herreriaNamesCleaned.has(empCleaned)) return true;
        for (const hName of herreriaNamesCleaned) {
          if (empCleaned.includes(hName) || hName.includes(empCleaned)) {
            return true;
          }
        }
        return false;
      });

      herreriaNames.forEach(name => {
        const exists = matchedEmployees.some(emp => emp && emp.label && cleanName(emp.label) === cleanName(name));
        if (!exists) {
          matchedEmployees.push({ value: name, label: name });
        }
      });

      filteredEmployees = matchedEmployees;

    } else if (isMecanicaCC) { // MECANICA
      const mecanicaNames = getSectorEmployees('Taller');
      const mecanicaNamesCleaned = new Set(mecanicaNames.map(name => cleanName(name)));
      let matchedEmployees = (cachedCatalogs.empleados || []).filter(emp => {
        if (!emp || !emp.label) return false;
        const empCleaned = cleanName(emp.label);
        if (mecanicaNamesCleaned.has(empCleaned)) return true;
        for (const mName of mecanicaNamesCleaned) {
          if (empCleaned.includes(mName) || mName.includes(empCleaned)) {
            return true;
          }
        }
        return false;
      });

      mecanicaNames.forEach(name => {
        const exists = matchedEmployees.some(emp => emp && emp.label && cleanName(emp.label) === cleanName(name));
        if (!exists) {
          matchedEmployees.push({ value: name, label: name });
        }
      });

      filteredEmployees = matchedEmployees;
    } else if (isEdilicioCC) {
      const edilicioNames = getSectorEmployees('Edilicio');
      const edilicioNamesCleaned = new Set(edilicioNames.map(name => cleanName(name)));
      let matchedEmployees = (cachedCatalogs.empleados || []).filter(emp => {
        if (!emp || !emp.label) return false;
        const empCleaned = cleanName(emp.label);
        return edilicioNamesCleaned.has(empCleaned);
      });

      edilicioNames.forEach(name => {
        const exists = matchedEmployees.some(emp => emp && emp.label && cleanName(emp.label) === cleanName(name));
        if (!exists) {
          matchedEmployees.push({ value: name, label: name });
        }
      });

      filteredEmployees = matchedEmployees;
    }

    // Populate options
    let empOptions = `<option value="">Seleccionar Empleado...</option>`;
    filteredEmployees.forEach(opt => {
      if (!opt) return;
      const optVal = String(opt.value || "");
      const optLabel = String(opt.label || opt.value || "");
      const isSelected = optVal === String(currentValue) ||
                         optLabel === String(currentValue) ||
                         (typeof cleanName === 'function' && cleanName(optLabel) === cleanName(String(currentValue)));
      empOptions += `<option value="${optVal}" ${isSelected ? "selected" : ""}>${optLabel}</option>`;
    });
    empSelect.innerHTML = empOptions;

    // Ensure option is selected or auto-created if custom
    const matchedOpt = filteredEmployees.find(opt => opt && (
      String(opt.value) === String(currentValue) || 
      String(opt.label) === String(currentValue) || 
      (typeof cleanName === 'function' && cleanName(opt.label) === cleanName(String(currentValue)))
    ));
    if (matchedOpt) {
      empSelect.value = matchedOpt.value;
    } else if (currentValue && String(currentValue).trim() !== '') {
      const customOpt = document.createElement('option');
      customOpt.value = currentValue;
      customOpt.textContent = currentValue;
      customOpt.selected = true;
      empSelect.appendChild(customOpt);
      empSelect.value = currentValue;
    }

    // Rebuild the searchable select UI dropdown options
    if (empSelect.rebuildSearchable) {
      empSelect.rebuildSearchable();
    }
  } catch (err) {
    console.error("Error updating employee dropdown:", err, card);
    editModalHasRenderingError = true;
    showToast("Error al filtrar el listado de empleados. Por favor, recargue la página.", "danger");
  }
}

// Timeline track label for the Inicio dashboard (one card per task, timeline layout) - shows
// every Inició/Pausó/Reanudó event in order, one per line, not just the most recent pair, so a
// task paused/resumed several times still shows its whole history.
function getTimelineFullHistoryLabel(timerHistory, timerStart) {
  const lines = [];
  if (Array.isArray(timerHistory)) {
    timerHistory.forEach(h => {
      if (!h || !h.formatted) return;
      const type = String(h.type || '').toLowerCase();
      if (type.startsWith('paus')) {
        lines.push(`<span style="color: var(--warning);">${h.formatted}</span>`);
      } else if (type.startsWith('inici') || type.startsWith('reanud')) {
        lines.push(h.formatted);
      }
    });
  }
  if (lines.length === 0 && timerStart) {
    lines.push(new Date(timerStart).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false }));
  }
  return lines.join('<br>');
}

function renderTimerHistoryHtml(history) {
  if (!Array.isArray(history) || history.length === 0) return '';
  return history.map(item => {
    const type = String(item.type || '').trim().toLowerCase();
    let label = item.type;
    let icon = 'play_arrow';
    if (type.startsWith('inici')) {
      icon = 'play_arrow';
      label = 'Inició';
    } else if (type.startsWith('paus')) {
      icon = 'pause';
      label = 'Pausó';
    } else if (type.startsWith('reanud')) {
      icon = 'replay';
      label = 'Reanudó';
    } else if (type.startsWith('fin')) {
      icon = 'stop';
      label = 'Fin';
    }
    // Older/legacy timerHistory entries only ever stored `timestamp`, never a pre-formatted
    // string - showing item.formatted directly on those renders the literal text "undefined".
    // Derive the display time from the timestamp itself when formatted is missing.
    const displayTime = item.formatted || (item.timestamp
      ? new Date(item.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' })
      : '--:--');
    return `<span style="display: inline-flex; align-items: center; gap: 2px; background: #e2e8f0; padding: 2px 5px; border-radius: 4px; font-size: 10px; color: var(--text-color);"><span class="material-icons" style="font-size: 10px;">${icon}</span>${label}: <strong>${displayTime}</strong></span>`;
  }).join(' ');
}

function addTaskTimerEvent(card, type) {
  if (!card) return;
  const history = JSON.parse(card.dataset.timerHistory || '[]');
  const now = new Date();
  const formatted = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  history.push({ type, formatted, timestamp: Date.now() });
  card.dataset.timerHistory = JSON.stringify(history);
  renderTaskTimerHistory(card);
}

function renderTaskTimerHistory(card) {
  if (!card) return;
  const logEl = card.querySelector('.timer-history-log');
  if (logEl) {
    const history = JSON.parse(card.dataset.timerHistory || '[]');
    logEl.innerHTML = renderTimerHistoryHtml(history);
  }
}

function addTaskField(taskData = null) {
  try {
    const container = document.getElementById('modal-tasks-list');
    const emptyState = document.getElementById('tasks-empty-state');
    if (emptyState) emptyState.style.display = 'none';

    const taskIndex = container.querySelectorAll('.task-item-card').length;
    // Use task ID from data if editing, else generate a unique card ID
    const taskId = taskData && taskData.id ? taskData.id : `task-card-${Date.now()}-${taskIndex}`;

    const currentUser = localStorage.getItem('currentUserUsername');
    const userSector = getSectorByUsername(currentUser);
    // Also honor the order's own Clasificación (not just the logged-in user's sector) -
    // an Admin/Pañol account creating an Edilicio/Herrería order isn't detected as that
    // sector by username, but the task should still default to its Centro de Costo.
    const activeClasif = document.getElementById('form-clasificacion') ? document.getElementById('form-clasificacion').value : '';
    // activeClasif === 'Herrería' still applies (that's a real Taxes clasificacion value), but
    // activeClasif === 'Edilicio' never matches anymore - Taxes has no such clasificacion value,
    // so Edilicio orders now carry "Correctivo" there too; currentSelectedSector/userSector
    // alone decide isEdilicioTask.
    const isHerreriaTask = (userSector === 'Herrería' || currentSelectedSector === 'Herrería' || activeClasif === 'Herrería');
    const isEdilicioTask = (userSector === 'Edilicio' || currentSelectedSector === 'Edilicio');
    let defaultCcVal = "15"; // default to MECANICA
    if (isHerreriaTask) {
      const herrOpt = (cachedCatalogs.centrosCosto || []).find(opt => opt && (opt.value === "11" || opt.value === "HERRERIA" || (opt.label && String(opt.label).toLowerCase().includes("herrer"))));
      if (herrOpt) {
        defaultCcVal = herrOpt.value;
      }
    } else if (isEdilicioTask) {
      const ediOpt = (cachedCatalogs.centrosCosto || []).find(opt => opt && (opt.value === "8" || opt.value === "EDILICIO" || (opt.label && String(opt.label).toLowerCase().includes("edilic"))));
      if (ediOpt) {
        defaultCcVal = ediOpt.value;
      }
    }

    // The "Insumos / Repuestos Utilizados" checklist (Aceite Motor, Refrigerante, etc.) is
    // Taller/Mecánica-specific - irrelevant to Herrería/Edilicio work. When editing an existing
    // task, go by ITS OWN centro de costo (most accurate); for a brand-new task, fall back to
    // the current tab/user sector, matching the same signal defaultCcVal above just used.
    const existingCcOpt = (taskData && taskData.centroCosto)
      ? (cachedCatalogs.centrosCosto || []).find(opt => opt && opt.value === taskData.centroCosto)
      : null;
    const hideInsumosSection = existingCcOpt
      ? /herrer|edil/i.test(String(existingCcOpt.label || ''))
      : (isHerreriaTask || isEdilicioTask);

    // Build select option strings
    let ccOptions = `<option value="">Seleccionar Centro Costo...</option>`;
    (cachedCatalogs.centrosCosto || []).forEach(opt => {
      if (!opt) return;
      const isSelected = taskData ? (opt.value === taskData.centroCosto) : (opt.value === defaultCcVal);
      ccOptions += `<option value="${opt.value}" ${isSelected ? "selected" : ""}>${opt.label || opt.value}</option>`;
    });

    const isNew = taskData === null;
    // Whether the card renders as "currently running" must follow the task's own
    // `timerStarted` flag - merely HAVING timer history (which every already-worked task
    // does, running or not) used to be enough on its own to mark it running here. That
    // meant reopening the edit modal for an order with an already-paused task (any history
    // at all) silently re-flagged it as running on save, which then made the server's
    // auto-pause-conflicting-timers logic think that employee "just started" here and pause
    // their real, currently-running timer on a completely different order.
    const timerStarted = taskData && (taskData.timerStarted === true || taskData.timerStarted === 'true') ? 'true' : 'false';
    const timerHistoryJson = taskData && taskData.timerHistory ? JSON.stringify(taskData.timerHistory) : '[]';

    let displayHours = taskData ? parseFloat(String(taskData.horasEstimadas).replace(',', '.')) || 0 : 0;
    // Only fall back to timer-history calculation if there's no stored horasEstimadas value.
    // If the user manually set horasEstimadas (> 0), always use that instead of recalculating.
    if (displayHours === 0 && taskData && Array.isArray(taskData.timerHistory) && taskData.timerHistory.length > 0) {
      const totalSeconds = calculateTotalElapsedSeconds(taskData.timerHistory, null);
      displayHours = minutesToHmm(Math.round(totalSeconds / 60));
    }

    const isLocked = !!(taskData && taskData.verifiedLocked);
    const lockedAttr = isLocked ? 'disabled' : '';

    const isSynced = !!(taskData && taskData.synced === true);
    // Tasks created before the "Fecha Tarea" field existed have no stored date - defaulting
    // those to "today" (the day someone happens to reopen/resave them) was baking in the wrong
    // day forever once the date-lock below freezes it. Derive it from when the timer actually
    // started instead; only a genuinely brand-new task (no history yet) falls back to today.
    const derivedDateFromHistory = (taskData && Array.isArray(taskData.timerHistory) && taskData.timerHistory.length > 0)
      ? (() => {
          const timestamps = taskData.timerHistory.map(h => h && h.timestamp).filter(ts => typeof ts === 'number' && ts > 0);
          return timestamps.length > 0 ? new Date(Math.min(...timestamps)).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }) : null;
        })()
      : null;
    const taskDateVal = (taskData && taskData.date) ? taskData.date.split('T')[0] : (derivedDateFromHistory || new Date().toISOString().split('T')[0]);
    // Once a task is opened (already exists) its date is frozen for good, even if the day
    // rolls over while it's still running - only a brand-new task lets you pick the date.
    const dateLockedAttr = (isLocked || !isNew) ? 'disabled' : '';

    const cardHtml = `
      <div class="task-item-card ${isNew ? 'new-task' : ''}" id="${taskId}" data-timer-started="${timerStarted}" data-timer-history='${timerHistoryJson}'>
        <div class="task-item-header">
          <span class="task-item-title">Tarea #${taskIndex + 1}</span>
          ${isSynced ? `
            <span class="badge-status success" style="background:#d1fae5; color:#065f46; border:1px solid #a7f3d0; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:600; display:inline-flex; align-items:center; gap:3px;">
              <span class="material-icons" style="font-size:13px;">check_circle</span> Sincronizada
            </span>
          ` : ''}
          ${taskData && taskData.verifiedLocked ? `
            <span class="material-icons task-lock-icon" style="cursor:pointer; color: var(--success); font-size: 18px;" title="Ya verificado en Taxes. Click para forzar re-control." onclick="unlockTaskVerification('${taskData.id}', '${taskId}')">lock</span>
          ` : `
            <span class="material-icons task-lock-icon" style="color: var(--text-muted); font-size: 18px;" title="Pendiente de verificar en el próximo control.">lock_open</span>
          `}
          <button type="button" class="task-delete-btn" onclick="${isLocked ? 'showLockedTaskAlert()' : `removeTaskField('${taskId}')`}">
            <span class="material-icons">delete</span>
          </button>
        </div>

        <div class="task-fields-wrapper" style="position:relative;">
          ${isLocked ? `<div class="task-locked-overlay" onclick="showLockedTaskAlert()" title="Tarea cerrada y verificada — no se puede modificar" style="position:absolute; inset:0; z-index:5; cursor:not-allowed;"></div>` : ''}

          <div class="form-row">
            <div class="form-group col-6">
              <label>Fecha Tarea</label>
              <input type="date" class="task-date" value="${taskDateVal}" ${dateLockedAttr}>
            </div>
            <div class="form-group col-6">
              <label>Centro de Costo *</label>
              <select class="task-cc" required ${lockedAttr}>
                ${ccOptions}
              </select>
            </div>
          </div>

          <div class="form-group">
            <label>Empleado Asignado *</label>
            <select class="task-emp" required ${lockedAttr}>
              <option value="">Seleccionar Empleado...</option>
            </select>
          </div>

          <div class="form-row">
            <div class="form-group col-6">
              <label>Horas Estimadas</label>
              <input type="number" step="0.01" min="0" value="${displayHours.toFixed(2)}" class="task-hours" oninput="updateHoursReadable(this)" ${lockedAttr}>
              <small class="hours-readable" style="color:var(--primary);font-size:11px;margin-top:2px;display:block;">${displayHours > 0 ? formatDecimalHours(displayHours) : ''}</small>
            </div>
            <div class="form-group col-6">
              <label>Estado Inicial</label>
              <select class="task-status" ${lockedAttr}>
                <option value="Pendiente" ${(taskData && taskData.status === 'Pendiente') ? 'selected' : ''}>Pendiente</option>
                <option value="Finalizada" ${(taskData && taskData.status === 'Finalizada') ? 'selected' : ''}>Finalizada</option>
              </select>
            </div>
          </div>

          <!-- TIMER CHRONOMETER WIDGET -->
          <div class="timer-container-row">
            <div class="timer-label">
              <span class="material-icons" style="font-size:16px;">timer</span>
              <span>Cronómetro</span>
            </div>
            <div class="timer-widget">
              <span class="timer-time" id="timer-display-${taskId}">00:00:00</span>
              <button type="button" class="btn btn-primary btn-xs btn-timer-toggle" id="timer-btn-${taskId}" onclick="${isLocked ? 'showLockedTaskAlert()' : `toggleTaskTimer('${taskId}')`}" ${lockedAttr}>
                <span class="material-icons" style="font-size:14px;">play_arrow</span>
                <span class="btn-text">Iniciar</span>
              </button>
            </div>
          </div>

          <div class="form-group" style="margin-top: 12px;">
            <label>Descripción de Actividades</label>
            <textarea placeholder="Describe las actividades a realizar..." rows="2" class="task-desc" ${lockedAttr}>${taskData ? taskData.descripcion || '' : ''}</textarea>
          </div>

          <div class="form-group task-insumos-section" style="margin-top: 10px; ${hideInsumosSection ? 'display: none;' : ''}">
            <label style="font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Insumos / Repuestos Utilizados</label>
            <div class="insumos-checkbox-grid">
              <div class="insumo-row">
                <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Aceite Motor" onchange="toggleInsumoRow(this)" ${lockedAttr}> Aceite Motor</label>
                <input type="text" placeholder="ej: 5L" class="insumo-qty-input" style="display: none;" ${lockedAttr}>
              </div>
              <div class="insumo-row">
                <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Refrigerante" onchange="toggleInsumoRow(this)" ${lockedAttr}> Refrigerante</label>
                <input type="text" placeholder="ej: 3L" class="insumo-qty-input" style="display: none;" ${lockedAttr}>
              </div>
              <div class="insumo-row">
                <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Grasa Diferencial" onchange="toggleInsumoRow(this)" ${lockedAttr}> Grasa Diferencial</label>
                <input type="text" placeholder="ej: 1Kg" class="insumo-qty-input" style="display: none;" ${lockedAttr}>
              </div>
              <div class="insumo-row">
                <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Grasa Caja" onchange="toggleInsumoRow(this)" ${lockedAttr}> Grasa Caja</label>
                <input type="text" placeholder="ej: 2L" class="insumo-qty-input" style="display: none;" ${lockedAttr}>
              </div>
              <div class="insumo-row">
                <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Hco Equipo" onchange="toggleInsumoRow(this)" ${lockedAttr}> Hco Equipo</label>
                <input type="text" placeholder="ej: 10L" class="insumo-qty-input" style="display: none;" ${lockedAttr}>
              </div>
              <div class="insumo-row">
                <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Hco Direccion" onchange="toggleInsumoRow(this)" ${lockedAttr}> Hco Direccion</label>
                <input type="text" placeholder="ej: 1L" class="insumo-qty-input" style="display: none;" ${lockedAttr}>
              </div>
              <div class="insumo-row">
                <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Grasa Engrase x KG" onchange="toggleInsumoRow(this)" ${lockedAttr}> Grasa Engrase x KG</label>
                <input type="text" placeholder="ej: 2Kg" class="insumo-qty-input" style="display: none;" ${lockedAttr}>
              </div>
              <div class="insumo-row">
                <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Otros" onchange="toggleInsumoRow(this)" ${lockedAttr}> Otros</label>
                <input type="text" placeholder="ej: Filtro de aire" class="insumo-qty-input" style="display: none;" ${lockedAttr}>
              </div>
            </div>
            <button type="button" class="btn btn-secondary btn-xs btn-agregar-insumos" style="margin-top: 8px; display: flex; align-items: center; gap: 4px;" onclick="agregarCantidadesInsumos(this)" ${lockedAttr}>
              <span class="material-icons" style="font-size: 14px;">add_circle_outline</span> Agregar cantidades a la tarea
            </button>
            <input type="hidden" class="task-insumos" value="${taskData && taskData.insumos ? taskData.insumos : ''}">
          </div>

          <div class="timer-history-log" style="font-size: 11px; color: var(--text-muted); margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center;">
            ${renderTimerHistoryHtml(taskData ? taskData.timerHistory : [])}
          </div>
        </div>
      </div>
    `;

    // Append just before emptyState or at end
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = cardHtml;
    const cardElement = tempDiv.firstElementChild;
    if (taskData) {
      container.appendChild(cardElement);
    } else {
      container.prepend(cardElement);
    }

    // Pre-select insumos checkboxes and fill quantities if taskData.insumos exists
    if (taskData && taskData.insumos && typeof taskData.insumos === 'string' && taskData.insumos.trim()) {
      const items = taskData.insumos.split('|').map(s => s.trim()).filter(Boolean);
      items.forEach(item => {
        let name = item;
        let qty = '';
        if (item.includes(':')) {
          const parts = item.split(':');
          name = parts[0].trim();
          qty = parts.slice(1).join(':').trim();
        }

        const checkboxes = Array.from(cardElement.querySelectorAll('.insumo-check'));
        const targetCheckbox = checkboxes.find(chk => chk.value.trim().toLowerCase() === name.toLowerCase());
        if (targetCheckbox) {
          targetCheckbox.checked = true;
          if (typeof toggleInsumoRow === 'function') {
            toggleInsumoRow(targetCheckbox);
          }
          if (qty) {
            const row = targetCheckbox.closest('.insumo-row');
            if (row) {
              const qtyInput = row.querySelector('.insumo-qty-input');
              if (qtyInput) {
                qtyInput.value = qty;
              }
            }
          }
        }
      });
    }

    // Rebuild titles to ensure they match DOM order from top to bottom
    container.querySelectorAll('.task-item-card').forEach((card, idx) => {
      const titleEl = card.querySelector('.task-item-title');
      if (titleEl) {
        titleEl.textContent = `Tarea #${idx + 1}`;
      }
    });

    // Set up the initial options inside the Employee dropdown (handles initial filtering if Mecanica)
    const empSelect = cardElement.querySelector('.task-emp');
    if (taskData) {
      const ccSelect = cardElement.querySelector('.task-cc');
      ccSelect.value = taskData.centroCosto;
      
      // We filter first and then assign the value
      let filteredEmployees = cachedCatalogs.empleados || [];
      const cleanName = (str) => {
        if (typeof str !== 'string') return '';
        return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
      };

      // Detect sector by looking up the label of the centroCosto in the catalog
      const ccCatalogOpt = (cachedCatalogs.centrosCosto || []).find(c => c && c.value === taskData.centroCosto);
      const ccLabelUpper = ccCatalogOpt && ccCatalogOpt.label ? String(ccCatalogOpt.label).trim().toUpperCase() : String(taskData.centroCosto || '').toUpperCase();
      const isHerreriaCC = ccLabelUpper.includes('HERRER');
      const isMecanicaCC = ccLabelUpper.includes('MECAN') || taskData.centroCosto === '15';
      const isEdilicioCC = ccLabelUpper.includes('EDILIC') || taskData.centroCosto === '8';

      // Uses getSectorEmployees() (same as updateEmployeeDropdownForCard, the live onchange
      // filter for brand-new tasks) instead of the raw MECANICA_EMPLOYEES/HERRERIA_EMPLOYEES/
      // EDILICIO_EMPLOYEES constants - those don't include names added in Ajustes > Mapeo de
      // Empleados (currentEmployeeMappings), so a custom-mapped employee (e.g. "Aguilar
      // Sebastian") showed up fine when assigning a brand-new task but disappeared from the
      // dropdown when reopening an existing task to fix a wrong assignment.
      const buildFilteredEmployees = (sectorName) => {
        const names = getSectorEmployees(sectorName);
        const namesCleaned = new Set(names.map(name => cleanName(name)));
        const matched = (cachedCatalogs.empleados || []).filter(emp => {
          if (!emp || !emp.label) return false;
          const empCleaned = cleanName(emp.label);
          if (namesCleaned.has(empCleaned)) return true;
          for (const n of namesCleaned) {
            if (empCleaned.includes(n) || n.includes(empCleaned)) return true;
          }
          return false;
        });
        names.forEach(name => {
          const exists = matched.some(emp => emp && emp.label && cleanName(emp.label) === cleanName(name));
          if (!exists) matched.push({ value: name, label: name });
        });
        return matched;
      };

      if (isMecanicaCC) {
        filteredEmployees = buildFilteredEmployees('Taller');
      } else if (isHerreriaCC) {
        filteredEmployees = buildFilteredEmployees('Herrería');
      } else if (isEdilicioCC) {
        filteredEmployees = buildFilteredEmployees('Edilicio');
      }
      let empOptions = `<option value="">Seleccionar Empleado...</option>`;
      filteredEmployees.forEach(opt => {
        if (!opt) return;
        const optVal = String(opt.value || "");
        const optLabel = String(opt.label || opt.value || "");
        const targetEmp = String(taskData.empleado || "");
        const isSelected = optVal === targetEmp || 
                           optLabel === targetEmp || 
                           (typeof cleanName === 'function' && cleanName(optLabel) === cleanName(targetEmp));
        empOptions += `<option value="${optVal}" ${isSelected ? "selected" : ""}>${optLabel}</option>`;
      });
      empSelect.innerHTML = empOptions;

      const targetEmpStr = String(taskData.empleado || "");
      const matchedTaskEmp = filteredEmployees.find(opt => opt && (
        String(opt.value) === targetEmpStr || 
        String(opt.label) === targetEmpStr || 
        (typeof cleanName === 'function' && cleanName(opt.label) === cleanName(targetEmpStr))
      ));
      if (matchedTaskEmp) {
        empSelect.value = matchedTaskEmp.value;
      } else if (targetEmpStr.trim() !== '') {
        const customOpt = document.createElement('option');
        customOpt.value = targetEmpStr;
        customOpt.textContent = targetEmpStr;
        customOpt.selected = true;
        empSelect.appendChild(customOpt);
        empSelect.value = targetEmpStr;
      }
    } else {
      // Fresh task: defaults to MECANICA (value "15") so filter immediately
      updateEmployeeDropdownForCard(cardElement);
    }

    // Convert employee select to searchable select
    convertSelectToSearchable(empSelect);

    const statusSelect = cardElement.querySelector('.task-status');
    const timerBtn = cardElement.querySelector('.btn-timer-toggle');
    const isFinished = (taskData && taskData.status === 'Finalizada') || (statusSelect && statusSelect.value === 'Finalizada');

    // Auto-resume timer if running in database taskData (and task is not finished)
    if (taskData && taskData.timerStart && !isFinished) {
      localStorage.setItem(`timer_start_${taskId}`, taskData.timerStart);
    }

    // Auto-resume timer if it is running in localStorage (and task is not finished)
    const timerKey = `timer_start_${taskId}`;
    if (isFinished) {
      clearLocalStorageTimerKeys(taskId);
      if (activeIntervalTimers[taskId]) {
        clearInterval(activeIntervalTimers[taskId]);
        delete activeIntervalTimers[taskId];
      }
    } else {
      const runningStartTime = localStorage.getItem(timerKey);
      if (runningStartTime) {
        const startTime = parseInt(runningStartTime);
        startTimerInterval(taskId, startTime);

        // Update Button UI immediately to show running state
        if (timerBtn) {
          timerBtn.classList.add('running');
          timerBtn.querySelector('.material-icons').textContent = 'stop';
          timerBtn.querySelector('.btn-text').textContent = 'Detener';
        }
      }
    }
    
    if (statusSelect && timerBtn) {
      const handleStatusChange = () => {
        const modal = document.getElementById('new-order-modal');
        const isReadOnly = modal && modal.classList.contains('readonly-mode');

        if (statusSelect.value === 'Finalizada') {
          timerBtn.disabled = true;
        } else {
          timerBtn.disabled = isReadOnly;
        }
      };
      statusSelect.addEventListener('change', handleStatusChange);
      // Initial run
      handleStatusChange();
    }

    // Populate insumos checkboxes and inputs if taskData has insumos
    if (taskData && taskData.insumos) {
      const insumosStr = taskData.insumos;
      const parts = insumosStr.split('|');
      const insumoRows = cardElement.querySelectorAll('.insumo-row');
      
      parts.forEach(part => {
        const trimmed = part.trim();
        if (!trimmed) return;
        
        let insumoName = trimmed;
        let insumoQty = "";
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx !== -1) {
          insumoName = trimmed.substring(0, colonIdx).trim();
          insumoQty = trimmed.substring(colonIdx + 1).trim();
        }
        
        // Find matching row
        let foundRow = null;
        let otherRow = null;
        insumoRows.forEach(row => {
          const checkbox = row.querySelector('.insumo-check');
          if (checkbox) {
            if (checkbox.value === insumoName) {
              foundRow = row;
            } else if (checkbox.value === 'Otros') {
              otherRow = row;
            }
          }
        });
        
        if (foundRow) {
          const chk = foundRow.querySelector('.insumo-check');
          const qtyInp = foundRow.querySelector('.insumo-qty-input');
          if (chk) chk.checked = true;
          if (qtyInp) {
            qtyInp.value = insumoQty;
            qtyInp.style.display = 'block';
          }
        } else if (otherRow) {
          const chk = otherRow.querySelector('.insumo-check');
          const qtyInp = otherRow.querySelector('.insumo-qty-input');
          if (chk) chk.checked = true;
          if (qtyInp) {
            qtyInp.value = trimmed; 
            qtyInp.style.display = 'block';
          }
        }
      });
    }

    updateTaskCountBadge();
  } catch (err) {
    console.error("Error rendering task field:", err, taskData);
    editModalHasRenderingError = true;
    showToast("Error de renderizado al cargar una tarea. Por favor, recargue la página.", "danger");
  }
}

let _lockedTaskAlertShownAt = 0;
function showLockedTaskAlert() {
  // Debounce: clicking a disabled field can fire this repeatedly (overlay + child element).
  const now = Date.now();
  if (now - _lockedTaskAlertShownAt < 1500) return;
  _lockedTaskAlertShownAt = now;
  showToast('🔒 Esta tarea ya fue VERIFICADA y CERRADA en Taxes — no se puede modificar (ni cronómetro, ni descripción, ni horas). Si necesitás cargar más trabajo, agregá una NUEVA tarea para el mismo empleado y esta misma orden.', 'danger');
}

async function unlockTaskVerification(taskDbId, cardId) {
  if (!currentEditingOrderId || !taskDbId) {
    showToast('Guardá la orden primero antes de poder abrir el candado.', 'warning');
    return;
  }
  if (!confirm('¿Forzar que esta tarea se vuelva a controlar contra Taxes la próxima vez?')) return;
  try {
    const currentUsername = localStorage.getItem('currentUserUsername') || '';
    const res = await fetch(`/api/orders/${currentEditingOrderId}/tasks/${taskDbId}/unlock`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-user-username': currentUsername }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Candado abierto — se va a re-controlar en el próximo control.', 'success');
    fetchOrders();
  } catch (err) {
    showToast('Error al abrir el candado: ' + err.message, 'danger');
  }
}

let taskHistoryCache = [];

function switchHistorialSubTab(tab) {
  document.querySelectorAll('.historial-subview').forEach(el => el.style.display = 'none');
  document.querySelectorAll('[onclick^="switchHistorialSubTab"]').forEach(btn => btn.classList.remove('active'));
  const target = document.getElementById(`historial-subview-${tab}`);
  if (target) target.style.display = 'block';
  if (event && event.target) event.target.classList.add('active');
  if (tab === 'tareas') fetchTaskHistory();
}

async function fetchTaskHistory() {
  try {
    const res = await fetch('/api/tasks/history');
    if (!res.ok) throw new Error('Error al cargar historial de tareas');
    taskHistoryCache = await res.json();
    renderTaskHistory();
  } catch (err) {
    const container = document.getElementById('task-history-container');
    if (container) container.innerHTML = `<div class="empty-state"><p>Error: ${err.message}</p></div>`;
  }
}

let selectedTaskHistoryKeys = new Set();

function taskHistoryKey(orderId, taskId) { return `${orderId}::${taskId}`; }

function toggleTaskHistorySelection(orderId, taskId, checked) {
  const key = taskHistoryKey(orderId, taskId);
  if (checked) selectedTaskHistoryKeys.add(key); else selectedTaskHistoryKeys.delete(key);
  updateTaskHistoryBulkBar();
}

function toggleSelectAllTaskHistory(checked) {
  selectedTaskHistoryKeys.clear();
  if (checked) {
    taskHistoryCache.forEach(t => selectedTaskHistoryKeys.add(taskHistoryKey(t.orderId, t.taskId)));
  }
  renderTaskHistory();
  updateTaskHistoryBulkBar();
}

function updateTaskHistoryBulkBar() {
  const bar = document.getElementById('task-history-bulk-bar');
  const count = document.getElementById('task-history-bulk-count');
  if (!bar) return;
  const n = selectedTaskHistoryKeys.size;
  if (n > 0) {
    bar.classList.add('active');
  } else {
    bar.classList.remove('active');
  }
  if (count) count.textContent = `${n} seleccionada${n === 1 ? '' : 's'}`;
}

async function bulkCloseTaskHistoryLocks() {
  if (!confirm(`¿Cerrar el candado de ${selectedTaskHistoryKeys.size} tarea(s)?`)) return;
  for (const key of selectedTaskHistoryKeys) {
    const [orderId, taskId] = key.split('::');
    await fetch(`/api/orders/${orderId}/tasks/${taskId}/lock`, { method: 'PATCH' }).catch(() => {});
  }
  showToast('Candados cerrados', 'success');
  selectedTaskHistoryKeys.clear();
  await fetchTaskHistory();
}

async function bulkForceResyncTaskHistory() {
  if (!confirm(`¿Mandar ${selectedTaskHistoryKeys.size} orden(es) de vuelta a Órdenes para resincronizar?`)) return;
  const orderIds = new Set([...selectedTaskHistoryKeys].map(k => k.split('::')[0]));
  for (const orderId of orderIds) {
    await fetch(`/api/orders/${orderId}/force-resync`, { method: 'POST' }).catch(() => {});
  }
  showToast('Órdenes enviadas a resincronizar', 'success');
  selectedTaskHistoryKeys.clear();
  await fetchTaskHistory();
}

async function bulkDeleteTaskHistory() {
  if (!confirm(`¿Borrar ${selectedTaskHistoryKeys.size} tarea(s)? Esta acción no se puede deshacer.`)) return;
  for (const key of selectedTaskHistoryKeys) {
    const [orderId, taskId] = key.split('::');
    await fetch(`/api/orders/${orderId}/tasks/${taskId}`, { method: 'DELETE' }).catch(() => {});
  }
  showToast('Tareas borradas', 'success');
  selectedTaskHistoryKeys.clear();
  await fetchTaskHistory();
}

async function verifyTaskHistory(orderIds = null) {
  const btn = document.getElementById('btn-verify-task-history');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-icons" style="font-size:16px;">sync</span> Iniciando Control...';
  }

  try {
    let idsToVerify = orderIds;
    if (!idsToVerify || !Array.isArray(idsToVerify)) {
      const orderIdSet = new Set(taskHistoryCache.map(t => t.orderId));
      idsToVerify = Array.from(orderIdSet);
    }

    if (idsToVerify.length === 0) {
      showToast('No hay tareas pendientes de controlar en Taxes.', 'warning');
      return;
    }

    const res = await fetch('/api/tasks/verify-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds: idsToVerify })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al iniciar control');

    showToast(`✅ Control de tareas iniciado para ${data.queued || idsToVerify.length} orden(es). El agente las verificará en Taxes en breve.`, 'success');

    let polls = 0;
    const pollInterval = setInterval(() => {
      polls++;
      fetchTaskHistory();
      if (polls >= 12) clearInterval(pollInterval);
    }, 5000);

  } catch (err) {
    showToast('Error al iniciar control de tareas: ' + err.message, 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-icons" style="font-size:16px;">fact_check</span> Ejecutar Control de Tareas Ahora';
    }
  }
}

async function bulkVerifyTaskHistory() {
  if (selectedTaskHistoryKeys.size === 0) {
    showToast('Seleccioná al menos una tarea.', 'warning');
    return;
  }
  const orderIds = Array.from(new Set([...selectedTaskHistoryKeys].map(k => k.split('::')[0])));
  await verifyTaskHistory(orderIds);
  selectedTaskHistoryKeys.clear();
  updateTaskHistoryBulkBar();
}

async function closeTaskHistoryLock(orderId, taskId) {
  if (!confirm('¿Confirmar que esta tarea está bien en Taxes y cerrar el candado?')) return;
  try {
    const res = await fetch(`/api/orders/${orderId}/tasks/${taskId}/lock`, { method: 'PATCH' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Candado cerrado', 'success');
    await fetchTaskHistory();
  } catch (err) {
    showToast('Error: ' + err.message, 'danger');
  }
}

async function forceResyncFromHistory(orderId) {
  if (!confirm('¿Volver a sincronizar y controlar esta orden con Taxes?')) return;
  try {
    const res = await fetch(`/api/orders/${orderId}/force-resync`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Orden reencolada para sincronizar y controlar con Taxes', 'success');
    await fetchTaskHistory();
  } catch (err) {
    showToast('Error: ' + err.message, 'danger');
  }
}

function renderTaskHistory() {
  const container = document.getElementById('task-history-container');
  const badge = document.getElementById('task-history-count-badge');
  const query = (document.getElementById('task-history-search')?.value || '').toLowerCase().trim();
  if (!container) return;

  const filtered = taskHistoryCache.filter(t =>
    !query ||
    String(t.interno || '').toLowerCase().includes(query) ||
    String(t.rodado || '').toLowerCase().includes(query) ||
    String(t.empleado || '').toLowerCase().includes(query)
  );
  if (badge) badge.textContent = `${filtered.length} tareas`;

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state"><span class="material-icons">assignment_turned_in</span><p>No hay tareas finalizadas pendientes de verificar.</p></div>`;
    updateTaskHistoryBulkBar();
    return;
  }

  container.innerHTML = filtered.map(t => `
    <div class="card" style="padding:12px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center;">
        <div style="display:flex;align-items:center;">
          <input type="checkbox" ${selectedTaskHistoryKeys.has(`${t.orderId}::${t.taskId}`) ? 'checked' : ''} onchange="toggleTaskHistorySelection('${t.orderId}','${t.taskId}', this.checked)" style="width:16px;height:16px;cursor:pointer;margin-right:8px;">
          <strong>${t.rodado || '(sin rodado)'} — Interno ${t.interno || '-'}</strong>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="color:var(--text-muted);font-size:12px;">${t.fechaEntrega || ''} ${t.taxesOrderNumber ? '· OT ' + t.taxesOrderNumber : ''}</span>
          <button type="button" class="btn btn-secondary btn-xs" onclick="forceResyncFromHistory('${t.orderId}')" title="Mandar la orden de vuelta a Órdenes para resincronizar">
            <span class="material-icons" style="font-size:14px;">sync</span> Resincronizar
          </button>
          <span class="material-icons" style="cursor:pointer; font-size:18px; color:var(--text-muted);" title="Marcar como verificado manualmente (cierra el candado)" onclick="closeTaskHistoryLock('${t.orderId}','${t.taskId}')">lock_open</span>
        </div>
      </div>
      <div style="font-size:13px;margin-top:4px;">${t.empleado} · ${t.centroCosto} · ${t.horasEstimadas} hs</div>
      <div style="font-size:13px;color:var(--text-muted);margin-top:2px;">${t.descripcion}</div>
      ${t.insumos ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">Insumos: ${t.insumos}</div>` : ''}
    </div>
  `).join('');

  updateTaskHistoryBulkBar();
}

function toggleInsumoRow(checkbox) {
  const row = checkbox.closest('.insumo-row');
  if (!row) return;
  const input = row.querySelector('.insumo-qty-input');
  if (checkbox.checked) {
    row.classList.add('active');
    if (input) {
      input.style.display = 'block';
      input.focus();
    }
  } else {
    row.classList.remove('active');
    if (input) {
      input.style.display = 'none';
      input.value = '';
    }
  }
  if (typeof updateDiagInsumosBadge === 'function') {
    updateDiagInsumosBadge();
  }
}

function agregarCantidadesInsumos(btn) {
  const card = btn.closest('.task-item-card');
  if (!card) return;
  const checks = card.querySelectorAll('.insumo-check:checked');
  if (checks.length === 0) {
    showToast('Seleccioná al menos un insumo antes de agregar cantidades.', 'warning');
    return;
  }
  const lineas = [];
  for (const chk of checks) {
    const nombre = chk.value;
    const row = chk.closest('.insumo-row');
    const input = row ? row.querySelector('.insumo-qty-input') : null;
    const cantidad = input ? input.value.trim() : '';
    if (cantidad !== '') {
      lineas.push(`${nombre}: ${cantidad}`);
    } else {
      lineas.push(nombre); // fall back if empty
    }
  }
  if (lineas.length === 0) return;
  const descEl = card.querySelector('.task-desc');
  const insumoHidden = card.querySelector('.task-insumos');
  const resumen = 'Insumos: ' + lineas.join(' | ');
  if (descEl) {
    descEl.value = (descEl.value.trim() ? descEl.value.trim() + '\n' : '') + resumen;
  }
  if (insumoHidden) {
    insumoHidden.value = lineas.join(' | ');
  }
  
  // Uncheck all boxes and hide inputs after adding
  checks.forEach(c => {
    c.checked = false;
    toggleInsumoRow(c);
  });
  showToast('Insumos agregados a la tarea ✓', 'success');
}

async function handleObtenerNumeroOT(orderId, botonElemento) {
  if (botonElemento) {
    botonElemento.disabled = true;
    botonElemento.innerHTML = `<span class="material-icons spinner" style="font-size:14px;">autorenew</span> Sincronizando cabecera...`;
  }

  try {
    showToast("Generando N° de O.T. vacía en Taxes...", "info");
    const response = await fetch('/api/orders/create-header', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId })
    });
    
    const data = await response.json();
    if (data.status === 'success' || data.success) {
      const otNum = data.taxesOrderNumber || data.generatedNo;
      showToast(`✅ Cabecera O.T. #${otNum} creada exitosamente en Taxes`, "success");
      fetchOrders();
    } else {
      showToast(data.message || "No se pudo obtener el N° de O.T.", "danger");
      if (botonElemento) {
        botonElemento.disabled = false;
        botonElemento.innerHTML = `<span class="material-icons" style="font-size:14px;">bolt</span> Obtener N° O.T.`;
      }
    }
  } catch (error) {
    console.error(error);
    showToast(`Error al obtener O.T.: ${error.message}`, "danger");
    if (botonElemento) {
      botonElemento.disabled = false;
      botonElemento.innerHTML = `<span class="material-icons" style="font-size:14px;">bolt</span> Obtener N° O.T.`;
    }
  }
}

async function triggerExpressOtSync(orderId) {
  return handleObtenerNumeroOT(orderId, null);
}

async function triggerSingleTaskSync(orderId, taskIndex) {
  try {
    showToast(`Sincronizando tarea #${taskIndex + 1} en Taxes...`, "info");
    const response = await fetch(`/api/orders/${orderId}/tasks/${taskIndex}/sync`, { method: 'POST' });
    const data = await response.json();
    if (data.success) {
      showToast(`✅ Tarea #${taskIndex + 1} sincronizada con éxito en Taxes (✔)!`, "success");
      fetchOrders();
    } else {
      showToast(data.message || "Error al sincronizar tarea", "danger");
    }
  } catch (err) {
    showToast(`Error al sincronizar tarea: ${err.message}`, "danger");
  }
}

function removeTaskField(cardId) {
  const card = document.getElementById(cardId);
  if (card) {
    // If this card is an already-saved task (not a brand-new unsaved card), track its id so
    // submitWorkOrder() can tell the server to actually delete it — otherwise the server-side
    // merge preserves every existing task it doesn't hear otherwise about, and the "deleted"
    // task silently comes back on save.
    const isTempId = cardId.startsWith('task-card-');
    if (!isTempId) {
      deletedTaskIdsInModal.add(cardId);
    }

    card.remove();

    // Clean up timers from localStorage and interval registry
    clearLocalStorageTimerKeys(cardId);
    if (activeIntervalTimers[cardId]) {
      clearInterval(activeIntervalTimers[cardId]);
      delete activeIntervalTimers[cardId];
    }
    
    // Rename subsequent badges
    const container = document.getElementById('modal-tasks-list');
    container.querySelectorAll('.task-item-card').forEach((card, idx) => {
      card.querySelector('.task-item-title').textContent = `Tarea #${idx + 1}`;
    });

    updateTaskCountBadge();
  }
}

// 7. GET AND RENDER WORK ORDERS
let lastFetchedOrdersJson = '';

async function fetchOrders() {
  try {
    const res = await fetch(`/api/orders?_=${Date.now()}`);
    if (!res.ok) throw new Error("Error fetching orders");
    const jsonText = await res.text();

    if (jsonText === lastFetchedOrdersJson) {
      return; // Skip heavy DOM re-rendering if orders data hasn't changed
    }

    lastFetchedOrdersJson = jsonText;
    const data = JSON.parse(jsonText);
    
    // Clean up active client-side timers for tasks that finished on another device
    (data || []).forEach(order => {
      (order.tasks || []).forEach(t => {
        if (t && (t.status === 'Finalizada' || t.status === 'Completada' || !t.timerStarted)) {
          if (activeIntervalTimers && activeIntervalTimers[t.id]) {
            clearInterval(activeIntervalTimers[t.id]);
            delete activeIntervalTimers[t.id];
          }
          if (activeDashboardIntervals && activeDashboardIntervals[t.id]) {
            clearInterval(activeDashboardIntervals[t.id]);
            delete activeDashboardIntervals[t.id];
          }
        }
      });
    });

    // Preserve the local (optimistic) version of any task whose own pause/resume/finish save
    // is still in flight - otherwise this poll can land between that optimistic update and the
    // server actually persisting it, and momentarily overwrite it with the stale pre-save state.
    if (pendingOptimisticTaskIds.size > 0) {
      const localTasksById = new Map();
      (activeOrders || []).forEach(o => (o.tasks || []).forEach(t => { if (t && t.id) localTasksById.set(t.id, t); }));
      (data || []).forEach(order => {
        order.tasks = (order.tasks || []).map(t => {
          if (t && t.id && pendingOptimisticTaskIds.has(t.id) && localTasksById.has(t.id)) {
            return localTasksById.get(t.id);
          }
          return t;
        });
      });
    }

    activeOrders = data;
    await resolveDatabaseConflicts();
    renderOrders();
    updateStats();
  } catch (error) {
    console.error("Error polling orders:", error);
  }
}

// ---- HISTORIAL (ARCHIVED ORDERS) ----
let archivedOrders = [];

async function fetchArchivedOrders() {
  try {
    const res = await fetch(`/api/orders/archived?_=${Date.now()}`);
    if (!res.ok) throw new Error("Error fetching archived orders");
    archivedOrders = await res.json();
    renderHistoryOrders();
  } catch (error) {
    console.error("Error loading archived orders:", error);
  }
}

function renderHistoryOrders() {
  const container = document.getElementById('history-orders-container');
  const badge = document.getElementById('history-count-badge');
  if (!container) return;

  // Reset selection state
  selectedHistoryOrderIds.clear();
  updateHistoryBulkDeleteActionBar();

  const filteredHistory = getFilteredArchivedOrders();

  if (filteredHistory.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">inventory_2</span>
        <p>No hay órdenes archivadas en este sector.</p>
        <small style="color:var(--text-muted);">Cuando archives una orden de este sector aparecerá aquí.</small>
      </div>
    `;
    if (badge) badge.textContent = '';
    return;
  }

  // Sort newest first
  const sorted = [...filteredHistory].sort((a, b) => {
    const da = new Date(a.archivedAt || a.syncDate || a.createdAt).getTime();
    const db2 = new Date(b.archivedAt || b.syncDate || b.createdAt).getTime();
    return db2 - da;
  });

  container.innerHTML = sorted.map(o => createHistoryCardHtml(o)).join('');
  if (badge) badge.textContent = `${sorted.length} orden${sorted.length !== 1 ? 'es' : ''} en historial`;
}


function renderOrders() {
  const container = document.getElementById('orders-list-container');
  if (!container) return;

  const filteredActiveOrders = getFilteredActiveOrders();

  // Clean up selected IDs that are no longer local or error
  const syncableIds = new Set(filteredActiveOrders.filter(o => o.syncStatus === 'local' || o.syncStatus === 'error').map(o => o.id));
  for (const id of selectedOrderIds) {
    if (!syncableIds.has(id)) {
      selectedOrderIds.delete(id);
    }
  }
  updateBulkSyncActionBar();

  // Apply search filtering for all orders
  const query = document.getElementById('order-search').value.toLowerCase();
  const filtered = filteredActiveOrders.filter(o => 
    (o.rodado || '').toLowerCase().includes(query) || 
    (o.interno || '').toLowerCase().includes(query) || 
    (o.clasificacion || '').toLowerCase().includes(query)
  );

  // Render Orders Tab
  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">search_off</span>
        <p>No se encontraron órdenes.</p>
      </div>
    `;
  } else {
    container.innerHTML = filtered.map(order => createOrderCardHtml(order)).join('');
  }

  // Render the Operator/Tasks active dashboard on home page
  renderDashboard();
}

function createHistoryCardHtml(order) {
  const syncDate = order.syncDate ? new Date(order.syncDate).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Fecha desconocida';
  const fechaOnly = order.syncDate ? new Date(order.syncDate).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : (order.createdAt ? new Date(order.createdAt).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-');
  const isChecked = selectedHistoryOrderIds.has(String(order.id)) ? 'checked' : '';
  const canManageHistory = true;

  const tasks = (order.tasks || []).filter(Boolean);
  const tasksCount = tasks.length;

  const tasksTableHtml = tasks.length === 0 ? `
    <div style="padding:10px; color:var(--text-muted); font-size:12px; font-style:italic;">Sin tareas registradas en esta orden.</div>
  ` : `
    <div class="prev-table-container" style="margin-top:8px; margin-bottom:8px; border:1px solid #e2e8f0; border-radius:8px; overflow-x:auto; background:#fafafa;">
      <table class="prev-table" style="font-size:12px; width:100%; margin:0; border-collapse:collapse;">
        <thead style="background:#f1f5f9; color:#475569; border-bottom:1px solid #e2e8f0;">
          <tr>
            <th style="padding:6px 8px; font-size:11px; font-weight:700; text-align:left;">FECHA</th>
            <th style="padding:6px 8px; font-size:11px; font-weight:700; text-align:left;">C. COSTO</th>
            <th style="padding:6px 8px; font-size:11px; font-weight:700; text-align:left;">EMPLEADO</th>
            <th style="padding:6px 8px; font-size:11px; font-weight:700; text-align:left;">HORAS ESTIMADAS</th>
            <th style="padding:6px 8px; font-size:11px; font-weight:700; text-align:left;">DESCRIPCION</th>
            <th style="padding:6px 8px; font-size:11px; font-weight:700; text-align:center;">REALIZADA</th>
            <th style="padding:6px 8px; font-size:11px; font-weight:700; text-align:center;">CANDADO</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map(t => {
            const empOpt = (cachedCatalogs && cachedCatalogs.empleados) ? cachedCatalogs.empleados.find(e => e.value === t.empleado) : null;
            const empName = empOpt ? empOpt.label : (t.empleado || 'Sin asignar');
            
            const ccOpt = (cachedCatalogs && cachedCatalogs.centrosCosto) ? cachedCatalogs.centrosCosto.find(c => c.value === t.centroCosto) : null;
            const ccName = ccOpt ? ccOpt.label : (t.centroCosto || 'MECANICA');
            
            let displayHours = parseFloat(String(t.horasEstimadas || 0).replace(',', '.')) || 0;
            if (displayHours === 0 && Array.isArray(t.timerHistory) && t.timerHistory.length > 0) {
              const secs = calculateTotalElapsedSeconds(t.timerHistory, null);
              displayHours = Math.round((secs / 3600) * 100) / 100;
            }
            const horasStr = displayHours > 0 ? `${displayHours} hs` : '-';
            const isDone = t.status === 'Finalizada' || t.status === 'Sincronizada' || t.completed === true;
            const isLocked = t.verifiedLocked === true;
            const lockBadge = isLocked ? `
              <span class="badge" style="background:#16a34a; color:#ffffff; font-size:11px; font-weight:700; padding:2px 8px; border-radius:4px; display:inline-flex; align-items:center; gap:3px;" title="Candado Cerrado (Verificado)">
                <span class="material-icons" style="font-size:12px;">lock</span> Cerrado
              </span>
            ` : `
              <span class="badge" style="background:#ef4444; color:#ffffff; font-size:11px; font-weight:700; padding:2px 8px; border-radius:4px; display:inline-flex; align-items:center; gap:3px;" title="Candado Abierto (Pendiente de verificación)">
                <span class="material-icons" style="font-size:12px;">lock_open</span> Abierto
              </span>
            `;

            return `
              <tr style="border-bottom:1px solid #f1f5f9; background:#ffffff;">
                <td style="padding:6px 8px; color:var(--text-muted); font-size:11px;">${fechaOnly}</td>
                <td style="padding:6px 8px;"><span class="badge" style="background:#e2e8f0; color:#334155; font-size:11px; font-weight:600; padding:2px 6px; border-radius:4px;">${ccName}</span></td>
                <td style="padding:6px 8px;"><strong style="color:var(--primary); font-size:12px;">${empName}</strong></td>
                <td style="padding:6px 8px; font-weight:600; font-size:12px;">${horasStr}</td>
                <td style="padding:6px 8px; font-size:12px;">${t.descripcion || '-'}</td>
                <td style="padding:6px 8px; text-align:center;">
                  <span style="display:inline-flex; align-items:center; justify-content:center; padding:2px 8px; border-radius:4px; background:${isDone ? '#d1fae5' : '#fef3c7'}; color:${isDone ? '#047857' : '#b45309'}; font-weight:700; font-size:11px;" title="${isDone ? 'Realizada' : 'Pendiente'}">
                    ${isDone ? 'SI' : 'NO'}
                  </span>
                </td>
                <td style="padding:6px 8px; text-align:center;">
                  ${lockBadge}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  return `
    <div class="order-card" style="margin-bottom:14px; border:1px solid #e2e8f0; border-radius:10px; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
      <div class="order-card-header" style="padding:12px 14px; background:#f8fafc; border-bottom:1px solid #f1f5f9; border-radius:10px 10px 0 0;">
        <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; margin-right: 8px;">
          ${canManageHistory ? `<input type="checkbox" class="history-order-select-checkbox" data-id="${order.id}" onchange="onHistoryOrderSelectionChange(event)" ${isChecked} style="margin: 0; width: 18px; height: 18px; cursor: pointer;">` : ''}
          <div style="min-width: 0; flex: 1;">
            <div class="order-card-title" style="font-size:16px; font-weight:700; color:var(--primary);">${order.rodado}${order.area ? ` <span style="color:#7c3aed;">- ${order.area}</span>` : ''}</div>
            <div class="order-card-subtitle" style="font-size:13px; color:var(--text-muted); margin-top:2px;">Interno: <strong style="color:var(--text-color);">${order.interno}</strong> | Clasificación: <strong>${order.clasificacion || 'Preventivo'}</strong></div>
            ${order.incidente ? `
              <div style="font-size:12px; color:var(--text-muted); margin-top:4px; display:flex; align-items:flex-start; gap:4px;" title="Motivo con el que se creó esta orden">
                <span class="material-icons" style="font-size:14px; flex-shrink:0; margin-top:1px;">info</span>
                <span style="font-style:italic;">${escapeHtml(order.incidente)}</span>
              </div>
            ` : ''}
          </div>
        </div>
        ${(() => {
          if (order.syncStatus === 'pending') {
            return `
              <span class="badge-status pending" style="display: inline-flex; align-items: center; gap: 4px; padding:4px 10px; font-size:12px; font-weight:600; background:#fef3c7; color:#b45309; border:1px solid #fde68a;">
                <span class="material-icons spinner" style="font-size:14px;">autorenew</span>
                <span>Reconstruyendo / En Cola O.T.: ${order.taxesOrderNumber || ''}</span>
              </span>
            `;
          } else if (order.syncStatus === 'syncing') {
            return `
              <span class="badge-status syncing" style="display: inline-flex; align-items: center; gap: 4px; padding:4px 10px; font-size:12px; font-weight:600; background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd;">
                <span class="material-icons spinner" style="font-size:14px;">autorenew</span>
                <span>Reconstruyendo O.T.: ${order.taxesOrderNumber || ''}</span>
              </span>
            `;
          } else if (order.syncStatus === 'error') {
            return `
              <span class="badge-status error" style="display: inline-flex; align-items: center; gap: 4px; padding:4px 10px; font-size:12px; background:#fee2e2; color:#991b1b; border:1px solid #fca5a5;" title="${order.syncError || 'Error al resincronizar'}">
                <span class="material-icons" style="font-size:14px;">error</span>
                <span>Error al Reconstruir O.T.: ${order.taxesOrderNumber || ''}</span>
              </span>
            `;
          } else if (order.taxesOrderNumber) {
            return `
              <span class="badge-status success" style="display: inline-flex; align-items: center; gap: 4px; padding:4px 10px; font-size:13px; font-weight:600;">
                <span class="material-icons" style="font-size:16px;">check_circle</span>
                <span>Sincronizado O.T.: ${order.taxesOrderNumber}</span>
              </span>
            `;
          } else {
            return `
              <span class="badge-status warning" style="display: inline-flex; align-items: center; gap: 4px; background-color:#fff7ed; color:#c2410c; border:1px solid rgba(194,65,12,0.2); padding:4px 10px; font-size:12px;" title="Esta orden no tiene número de O.T. asignado en Taxes">
                <span class="material-icons" style="font-size:14px;">warning</span>
                <span>Sin O.T. Asignada</span>
              </span>
            `;
          }
        })()}
      </div>

      <div style="padding:10px 14px;">
        ${tasksTableHtml}
      </div>

      <div class="order-card-footer" style="padding:8px 14px 12px; border-top:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; background:#fafafa; border-radius:0 0 10px 10px;">
        <div class="tasks-summary" style="font-size:12px; color:var(--text-muted);">
          <span class="material-icons" style="font-size:15px; vertical-align:middle;">cloud_upload</span> ${syncDate} &nbsp;·&nbsp; <strong>${tasksCount} ${tasksCount === 1 ? 'Tarea' : 'Tareas'}</strong>
        </div>
        <div class="card-actions" style="display:flex; gap:6px;">
          <button class="icon-btn primary" onclick="viewOrder('${order.id}')" title="Ver Orden Completa">
            <span class="material-icons">visibility</span>
          </button>
          ${canManageHistory ? `
          <button class="icon-btn warning" onclick="editOrder('${order.id}')" title="Editar Orden">
            <span class="material-icons">edit</span>
          </button>
          <button class="icon-btn" onclick="unarchiveOrder('${order.id}')" title="Desarchivar (volver a Órdenes activas)" style="background:#f59e0b;color:#fff;border:none;">
            <span class="material-icons">unarchive</span>
          </button>
          <button class="icon-btn" onclick="resyncOrderFromHistory('${order.id}')" title="Resincronizar y Controlar con Taxes" style="background:linear-gradient(135deg,#0ea5e9,#0284c7);color:#fff;border:none;">
            <span class="material-icons">sync</span>
          </button>
          <button class="icon-btn danger" onclick="deleteOrder('${order.id}')" title="Eliminar definitivamente de la App">
            <span class="material-icons">delete_forever</span>
          </button>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

async function unarchiveOrder(orderId) {
  if (confirm("¿Desarchivar esta orden para poder editarla?\nVolverá al listado de pendientes con el lápiz de edición habilitado y podrás modificarla antes de volver a sincronizar.")) {
    try {
      const currentUsername = localStorage.getItem('currentUserUsername') || '';
      const res = await fetch(`/api/orders/${orderId}/unarchive`, {
        method: 'PATCH',
        headers: { 'x-user-username': currentUsername }
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || "Error al desarchivar orden", "danger");
        return;
      }
      showToast("Orden desarchivada ✓ — Lápiz habilitado para editar", "success");
      fetchOrders();
      // If historial view is currently open, refresh it too
      const historialView = document.getElementById('view-historial');
      if (historialView && historialView.classList.contains('active')) {
        fetchArchivedOrders();
      }
    } catch (error) {
      showToast("Error al desarchivar orden", "danger");
      console.error(error);
    }
  }
}

async function resyncOrderFromHistory(orderId) {
  if (!confirm('¿Reconstruir y resincronizar tareas de esta orden con Taxes?')) return;
  // Optimistically set status to pending in local memory for instant user feedback
  const target = archivedOrders.find(o => String(o.id) === String(orderId));
  if (target) {
    target.syncStatus = 'pending';
    renderHistoryOrders();
  }
  try {
    const res = await fetch(`/api/orders/${orderId}/force-resync`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Reconstrucción iniciada: La orden se está resincronizando en segundo plano', 'success');
    await fetchArchivedOrders();
  } catch (err) {
    if (target) {
      target.syncStatus = 'error';
      renderHistoryOrders();
    }
    showToast('Error: ' + err.message, 'danger');
  }
}

function updateStats() {
  const filtered = getFilteredActiveOrders();
  const total = filtered.length;
  const synced = filtered.filter(o => o.syncStatus === 'success').length;
  const pending = filtered.filter(o => o.syncStatus === 'pending' || o.syncStatus === 'syncing').length;

  const elTotal = document.getElementById('stat-total');
  const elSynced = document.getElementById('stat-synced');
  const elPending = document.getElementById('stat-pending');

  if (elTotal) elTotal.textContent = total;
  if (elSynced) elSynced.textContent = synced;
  if (elPending) elPending.textContent = pending;
}

function createOrderCardHtml(order) {
  const allCompleted = (order.tasks || []).length > 0 && (order.tasks || []).every(t => t.status === "Finalizada");
  const hasPendingTasks = !allCompleted;

  let statusBadge = '';
  if (order.taxesOrderNumber && String(order.taxesOrderNumber).trim() !== '') {
    // ALWAYS DISPLAY THE OT NUMBER BADGE ONCE ASSIGNED!
    const otNum = order.taxesOrderNumber;
    statusBadge = `
      <span class="badge-status success" style="display: inline-flex; align-items: center; gap: 4px;">
        <span class="material-icons">check_circle</span> 
        <span>Sincronizado O.T.: ${otNum}</span>
        <button onclick="event.stopPropagation(); retrySync('${order.id}')" title="Volver a Sincronizar con Taxes" style="background: none; border: none; padding: 2px; margin-left: 4px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: #065f46; outline: none;" onmouseover="this.style.color='#047857'" onmouseout="this.style.color='#065f46'">
          <span class="material-icons" style="font-size: 14px; font-weight: bold;">sync</span>
        </button>
      </span>
    `;
    if (order.syncStatus === 'error') {
      statusBadge += ` <span class="badge-status error" onclick="event.stopPropagation(); openErrorModal(null, '${order.id}')" title="Falló el último reintento. Clic para ver detalle."><span class="material-icons">error</span> Error</span>`;
    } else if (order.syncStatus === 'syncing') {
      statusBadge += ` <span class="badge-status syncing"><span class="material-icons spinner">autorenew</span> Sincronizando</span>`;
    } else if (order.syncStatus === 'pending') {
      statusBadge += ` <span class="badge-status pending" style="font-size:11px;"><span class="material-icons">hourglass_empty</span> Pendiente Tareas</span>`;
    }
  } else if (order.syncStatus === 'pending') {
    statusBadge = `<span class="badge-status pending"><span class="material-icons">hourglass_empty</span> Pendiente</span>`;
  } else if (order.syncStatus === 'syncing') {
    statusBadge = `<span class="badge-status syncing"><span class="material-icons spinner">autorenew</span> Sincronizando</span>`;
  } else if (order.syncStatus === 'error') {
    statusBadge = `<span class="badge-status error" onclick="event.stopPropagation(); openErrorModal(null, '${order.id}')"><span class="material-icons">error</span> Error</span>`;
  } else if (order.syncStatus === 'local') {
    if (allCompleted) {
      statusBadge = `<span class="badge-status success" style="background-color:#d1fae5; color:#065f46; border:1px solid rgba(6,95,70,0.2);"><span class="material-icons" style="font-size:12px;">check_circle</span> Completada</span>`;
    } else {
      statusBadge = `<span class="badge-status local" style="background-color:#e0f2fe; color:#0369a1; border:1px solid rgba(3,105,161,0.2);"><span class="material-icons" style="font-size:12px;">construction</span> En Curso</span>`;
    }
  }

  const isChecked = selectedOrderIds.has(order.id) ? 'checked' : '';
  const dateFormatted = order.fechaEntrega ? order.fechaEntrega.split('-').reverse().join('/') : '-';

  return `
    <div class="order-card">
      <div class="order-card-header">
        <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; margin-right: 8px;">
          ${(order.syncStatus === 'local' || order.syncStatus === 'error') ? (
            hasPendingTasks ? `
              <input type="checkbox" disabled title="Esta orden tiene tareas en proceso o incompletas" style="margin: 0; width: 18px; height: 18px; cursor: not-allowed; opacity: 0.5;">
            ` : `
              <input type="checkbox" class="order-select-checkbox" data-id="${order.id}" onchange="onOrderSelectionChange(event)" ${isChecked} style="margin: 0; width: 18px; height: 18px; cursor: pointer;">
            `
          ) : ''}
          <div style="min-width: 0; flex: 1;">
            <div class="order-card-title">${order.rodado}${order.area ? ` <span style="color:#7c3aed;font-weight:600;">- ${order.area}</span>` : ''}</div>
            <div class="order-card-subtitle" style="display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 4px;">
              <span>Interno: <strong>${(order.interno && order.interno !== '--') ? order.interno : '0KM'}</strong> | Clasificación: <strong>${order.clasificacion || 'Sin Clasificar'}</strong></span>
              ${(() => {
                const isOutOfService = order.estadoUnidad === 'fuera_de_servicio';
                const tooltip = isOutOfService ? 'Haga clic para cambiar a Operativo' : 'Haga clic para cambiar a Fuera de Servicio';
                
                const clickAction = `onclick="toggleOrderEstadoUnidad(event, '${order.id}')"`;
                
                return `
                  <div class="switch-container" style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; vertical-align: middle; margin-left: 8px;" ${clickAction} title="${tooltip}">
                    <span style="font-size: 11px; font-weight: 600; color: ${isOutOfService ? '#ef4444' : '#10b981'}; text-transform: uppercase;">
                      ${isOutOfService ? 'F. de Servicio' : 'Operativo'}
                    </span>
                    <span class="switch-pill" style="position: relative; display: inline-block; width: 32px; height: 18px; background-color: ${isOutOfService ? '#ef4444' : '#10b981'}; border-radius: 9px; transition: background-color 0.2s;">
                      <span class="switch-thumb" style="position: absolute; top: 2px; left: ${isOutOfService ? '16px' : '2px'}; width: 14px; height: 14px; background-color: white; border-radius: 50%; transition: left 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.2);"></span>
                    </span>
                  </div>
                `;
              })()}
            </div>
            ${order.incidente ? `
              <div style="font-size:12px; color:var(--text-muted); margin-top:4px; display:flex; align-items:flex-start; gap:4px;" title="Motivo con el que se creó esta orden">
                <span class="material-icons" style="font-size:14px; flex-shrink:0; margin-top:1px;">info</span>
                <span style="font-style:italic;">${escapeHtml(order.incidente)}</span>
              </div>
            ` : ''}
          </div>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0;">
          ${statusBadge}
          ${getVerificationBadgeHtml(order)}
        </div>
      </div>

      <div class="order-card-footer">
        <div class="tasks-summary" onclick="toggleTaskEmployees(event, '${order.id}')" style="cursor:pointer; display:flex; align-items:center; gap:6px; flex:1;" title="Ver tareas y personal asignado">
          <span class="material-icons">format_list_bulleted</span>
          <span>${(order.tasks || []).filter(t => t !== null && t !== undefined).length} Tareas asignadas</span>
          <span class="material-icons" style="font-size:14px; color:var(--text-muted);">expand_more</span>
          ${(() => {
            const vTasks = (order.tasks || []).filter(t => t !== null && t !== undefined);
            const sCount = vTasks.filter(t => t && t.synced === true).length;
            if (sCount > 0) {
              return `
                <span style="margin-left:auto; background:#d1fae5; color:#065f46; border:1px solid #a7f3d0; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:3px;">
                  <span class="material-icons" style="font-size:13px;">check_circle</span> ${sCount}/${vTasks.length} Sincronizadas
                </span>
              `;
            }
            return '';
          })()}
        </div>
        <div class="task-employees-detail" id="task-emp-${order.id}" style="display:none; width:100%; margin-top:6px; padding:6px 8px; background:var(--bg-secondary); border-radius:6px; font-size:12px;"></div>
        <div class="card-actions" style="margin-top:6px;">
          ${!order.taxesOrderNumber ? `
            <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); handleObtenerNumeroOT('${order.id}', this)" style="padding:3px 8px; font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:3px; background:linear-gradient(135deg,#059669,#047857); border:none; color:#fff; border-radius:6px; cursor:pointer;" title="Obtener N° de O.T. Express en Taxes">
              <span class="material-icons" style="font-size:14px;">bolt</span> Obtener N° O.T.
            </button>
          ` : ''}
          <button class="icon-btn primary" onclick="viewOrder('${order.id}')" title="Ver Orden (Solo Lectura)">
            <span class="material-icons">visibility</span>
          </button>
          ${(order.syncStatus !== 'pending' && order.syncStatus !== 'syncing') ? `
            <button class="icon-btn warning" onclick="editOrder('${order.id}')" title="Editar Orden">
              <span class="material-icons">edit</span>
            </button>
          ` : ''}
          ${(order.syncStatus === 'local' || order.syncStatus === 'error') ? `
            <button class="icon-btn success" onclick="retrySync('${order.id}')" title="Subir a Taxes">
              <span class="material-icons">cloud_upload</span>
            </button>
          ` : ''}
          ${(() => {
            if (order.syncStatus === 'success') {
              return `
                <button class="icon-btn" onclick="archiveOrder('${order.id}')" title="Archivar (pasa al Historial)" style="background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;border:none;">
                  <span class="material-icons">archive</span>
                </button>
              `;
            } else {
              return `
                <button class="icon-btn danger" onclick="deleteOrder('${order.id}')" title="Eliminar Localmente">
                  <span class="material-icons">delete</span>
                </button>
              `;
            }
          })()}
        </div>
      </div>
    </div>
  `;
}

function toggleTaskEmployees(event, orderId) {
  event.stopPropagation();
  const detailEl = document.getElementById(`task-emp-${orderId}`);
  if (!detailEl) return;

  if (detailEl.style.display !== 'none') {
    detailEl.style.display = 'none';
    return;
  }

  const order = activeOrders.find(o => o.id === orderId);
  const validTasks = order && order.tasks ? order.tasks.filter(t => t !== null && t !== undefined) : [];
  if (!order || validTasks.length === 0) {
    detailEl.innerHTML = '<span style="color:var(--text-muted);">Sin tareas asignadas</span>';
    detailEl.style.display = 'block';
    return;
  }

  let html = '';
  validTasks.forEach((t, idx) => {
    const empOpt = (cachedCatalogs && cachedCatalogs.empleados)
      ? cachedCatalogs.empleados.find(e => e.value === t.empleado)
      : null;
    const empName = empOpt ? empOpt.label : (t.empleado || 'Sin asignar');
    const isSynced = !!t.synced;
    const statusIcon = isSynced ? '✔' : (t.status === 'Finalizada' ? '✅' : (t.timerStart > 0 ? '⚡' : '⏳'));
    const desc = t.descripcion ? t.descripcion.split('\n')[0].substring(0, 40) : 'Sin descripción';

    html += `<div style="display:flex; align-items:center; justify-content:space-between; gap:6px; padding:4px 0; border-bottom:1px solid var(--border-color);">
      <div style="display:flex; align-items:center; gap:6px; overflow:hidden;">
        <span style="font-size:13px; font-weight:bold; color:${isSynced ? '#059669' : '#6b7280'};">${statusIcon}</span>
        <strong style="font-size:12px;">${empName}</strong>
        <span style="color:var(--text-muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">— ${desc}</span>
      </div>
      <div style="flex-shrink:0;">
        ${isSynced ? `
          <span style="background:#d1fae5; color:#065f46; border:1px solid #a7f3d0; padding:1px 6px; border-radius:10px; font-size:10px; font-weight:700; display:inline-flex; align-items:center; gap:2px;">
            <span class="material-icons" style="font-size:11px;">check_circle</span> Sincronizada
          </span>
        ` : (order.taxesOrderNumber ? `
          <button type="button" class="btn btn-sm btn-primary" onclick="event.stopPropagation(); triggerSingleTaskSync('${order.id}', ${idx})" style="padding:1px 6px; font-size:10px; font-weight:600; display:inline-flex; align-items:center; gap:2px; background:linear-gradient(135deg,#0284c7,#0369a1); border:none; color:#fff; border-radius:4px; cursor:pointer;" title="Sincronizar esta tarea a Taxes">
            <span class="material-icons" style="font-size:11px;">bolt</span> Sincronizar Tarea
          </button>
        ` : `
          <span style="color:var(--text-muted); font-size:10px; font-style:italic;">Pendiente O.T.</span>
        `)}
      </div>
    </div>`;
  });

  detailEl.innerHTML = html;
  detailEl.style.display = 'block';
}

function createQueueCardHtml(order) {
  const allCompleted = (order.tasks || []).length > 0 && (order.tasks || []).every(t => t.status === "Finalizada");
  const hasPendingTasks = !allCompleted;

  let statusColor = 'pending';
  let desc = 'En cola de espera';
  let actionBtn = '';

  if (order.syncStatus === 'local') {
    statusColor = 'secondary';
    desc = allCompleted ? 'Lista para subir a Taxes' : 'En Taller (tareas pendientes)';
    actionBtn = `
      <div style="display:flex; gap: 8px;">
        <button class="btn btn-warning btn-sm" onclick="editOrder('${order.id}')" style="display:flex; align-items:center; gap:4px;">
          <span class="material-icons" style="font-size:16px;">edit</span> Editar
        </button>
        <button class="btn btn-success btn-sm" onclick="retrySync('${order.id}')" style="display:flex; align-items:center; gap:4px; background-color: var(--success); color: white; border-color: var(--success);">
          <span class="material-icons" style="font-size:16px;">cloud_upload</span> Subir
        </button>
      </div>
    `;
  } else if (order.syncStatus === 'syncing') {
    statusColor = 'syncing';
    desc = 'Sincronizando activamente con la web de Taxes...';
  } else if (order.syncStatus === 'error') {
    statusColor = 'error';
    desc = `Fallo: ${order.syncError.substring(0, 70)}${order.syncError.length > 70 ? '...' : ''}`;
    actionBtn = `
      <div style="display:flex; gap: 8px;">
        <button class="btn btn-warning btn-sm" onclick="editOrder('${order.id}')" style="display:flex; align-items:center; gap:4px;">
          <span class="material-icons" style="font-size:16px;">edit</span> Editar
        </button>
        <button class="btn btn-success btn-sm" onclick="retrySync('${order.id}')" style="display:flex; align-items:center; gap:4px; background-color: var(--success); color: white; border-color: var(--success);">
          <span class="material-icons" style="font-size:16px;">cloud_upload</span> Subir
        </button>
      </div>
    `;
  }

  return `
    <div class="order-card">
      <div class="order-card-header">
        <div style="min-width: 0; flex: 1; margin-right: 8px;">
          <div class="order-card-title">OT #${order.interno} - ${order.rodado}</div>
          <div class="order-card-subtitle" style="color:var(--text-muted); font-size:11px;">Creada: ${new Date(order.createdAt).toLocaleString()}</div>
        </div>
      </div>
      <div style="font-size: 13px; margin: 4px 0; display: flex; align-items: center; gap: 6px;">
        <span class="material-icons" style="font-size:16px; color: var(--${statusColor === 'pending' ? 'secondary' : statusColor})">
          ${statusColor === 'pending' ? 'schedule' : statusColor === 'syncing' ? 'loop' : 'warning'}
        </span>
        <span style="font-weight:600; color: var(--${statusColor === 'pending' ? 'secondary' : statusColor})">${desc}</span>
      </div>
      <div style="display:flex; justify-content: flex-end; margin-top:6px;">
        ${actionBtn}
      </div>
    </div>
  `;
}

function filterOrders() {
  renderOrders();
}

function filterHistory() {
  renderOrders();
}

// Looks up an order by id in either the active or the archived (Historial) list.
function findAnyOrderById(orderId) {
  if (!orderId) return null;
  const inActive = Array.isArray(activeOrders) ? activeOrders.find(o => o.id === orderId) : null;
  if (inActive) return inActive;
  return (typeof archivedOrders !== 'undefined' && Array.isArray(archivedOrders)) ? archivedOrders.find(o => o.id === orderId) : null;
}

let isSubmittingWorkOrder = false;
async function submitWorkOrder() {
  if (isSubmittingWorkOrder) return;
  isSubmittingWorkOrder = true;

  const submitBtn = document.querySelector('#modal-new-order button[type="submit"]') || document.querySelector('#modal-new-order .btn-primary');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const editingOrder = currentEditingOrderId ? findAnyOrderById(currentEditingOrderId) : null;
    const rodadoEl = document.getElementById('form-rodado');
    const responsableEl = document.getElementById('form-responsable');
    const internoEl = document.getElementById('form-interno');
    const clasificacionEl = document.getElementById('form-clasificacion');
    const fechaEl = document.getElementById('form-fecha');
    const horaEl = document.getElementById('form-hora');
    const incidenteEl = document.getElementById('form-incidente');

    if (!rodadoEl || !clasificacionEl) {
      showToast("Error en el formulario. Por favor recargue la página.", "danger");
      return;
    }

    // Auto-set current date and time on submission ONLY if empty (allows selecting past dates like yesterday)
    if (!currentEditingOrderId && fechaEl && !fechaEl.value) {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      fechaEl.value = `${yyyy}-${mm}-${dd}`;
      
      if (horaEl) {
        const hh = String(today.getHours()).padStart(2, '0');
        const min = String(today.getMinutes()).padStart(2, '0');
        horaEl.value = `${hh}:${min}`;
      }
    }
   
    const userSector = getSectorByUsername(localStorage.getItem('currentUserUsername'));
    const formClasif = clasificacionEl ? clasificacionEl.value : '';
    const isHerreria = (userSector === 'Herrería' || currentSelectedSector === 'Herrería' || formClasif === 'Herrería');
    const isEdilicioForm = (userSector === 'Edilicio' || currentSelectedSector === 'Edilicio');
    const rodadoVal = rodadoEl ? rodadoEl.value : '';
    const rodadoLabel = (rodadoEl && rodadoEl.options && rodadoEl.selectedIndex >= 0) ? (rodadoEl.options[rodadoEl.selectedIndex].text || rodadoVal) : rodadoVal;

    let areaVal = "";
    if (isEdilicioForm) {
      const areaEl = document.getElementById('form-area-edilicio');
      areaVal = areaEl ? areaEl.value.trim() : "";
      if (!areaVal || areaVal === '__new__') {
        showToast("Por favor, selecciona el Área/Sector.", "danger");
        return;
      }
    }

    const internoTextEl = document.getElementById('form-interno-text');
    let internoVal = "";
    if (isEdilicioForm) {
      // Edilicio's Rodado catalog is the building/property list itself (label = its interno) -
      // there's no separate real "unit interno" to type, so the Área/Sector dropdown now sits
      // where that text box used to be and this is derived straight from the chosen Rodado.
      internoVal = rodadoLabel;
    } else if (isHerreria) {
      internoVal = internoTextEl ? internoTextEl.value.trim() : "";
    } else {
      internoVal = internoEl ? internoEl.value.trim() : "";
      if (!internoVal && internoEl && internoEl.closest) {
        const wrapper = internoEl.closest('.searchable-select-container');
        const searchInput = wrapper ? wrapper.querySelector('.searchable-select-search-input') : null;
        if (searchInput && searchInput.value.trim()) {
          internoVal = searchInput.value.trim();
        }
      }
    }

    // Manual validations for touch optimization
    if (!rodadoVal) return showToast("Por favor, selecciona un Rodado.", "danger");
    if (!internoVal) return showToast("Por favor, selecciona el Interno de Unidad.", "danger");
    if (!clasificacionEl.value) return showToast("Por favor, selecciona una Clasificación.", "danger");
   
    // Collect tasks safely
    const tasks = [];
    const container = document.getElementById('modal-tasks-list');
    const taskCards = container ? container.querySelectorAll('.task-item-card') : [];
   
    if (taskCards.length === 0) {
      return showToast("Por favor, agrega al menos una tarea a la orden.", "danger");
    }

    let tasksValid = true;
    taskCards.forEach(card => {
      const ccEl = card.querySelector('.task-cc');
      const empEl = card.querySelector('.task-emp');
      const hoursEl = card.querySelector('.task-hours');
      const statusEl = card.querySelector('.task-status');
      const descEl = card.querySelector('.task-desc');
      const insumosEl = card.querySelector('.task-insumos');

      const cc = ccEl ? ccEl.value : '';
      const emp = empEl ? empEl.value : '';
      const hoursRaw = hoursEl ? hoursEl.value : '0.01';
      const status = statusEl ? statusEl.value : 'Pendiente';
      const desc = descEl ? descEl.value : '';
      const insumos = insumosEl ? insumosEl.value.trim() : '';

      if (!cc || !emp) {
        tasksValid = false;
        return;
      }

      // Preserve task ID if we are editing
      const isTempId = card.id.startsWith('task-card-');
      const taskId = isTempId ? null : card.id;

      // Collect timer state
      const timerKey = `timer_start_${card.id}`;
      const timerStartVal = localStorage.getItem(timerKey) ? parseInt(localStorage.getItem(timerKey)) : null;
      let timerHistoryVal = [];
      try {
        timerHistoryVal = JSON.parse(card.dataset.timerHistory || '[]');
      } catch (e) {}

      const parsedHours = parseFloat(String(hoursRaw).replace(',', '.')) || 0;
      if (parsedHours > 0 && Array.isArray(timerHistoryVal) && timerHistoryVal.length > 0) {
        const currentTimerSecs = calculateTotalElapsedSeconds(timerHistoryVal, null);
        const currentTimerHrs = Math.round((currentTimerSecs / 3600) * 100) / 100;
        if (Math.abs(currentTimerHrs - parsedHours) > 0.05) {
          timerHistoryVal = [
            { type: 'Inicio', timestamp: Date.now() - Math.round(parsedHours * 3600 * 1000) },
            { type: 'Fin', timestamp: Date.now() }
          ];
        }
      }

      let existingTaskObj = null;
      if (editingOrder && Array.isArray(editingOrder.tasks)) {
        existingTaskObj = editingOrder.tasks.find(et => et && et.id === taskId);
      }

      let finalInsumosVal = insumos;
      if (!finalInsumosVal && existingTaskObj && existingTaskObj.insumos) {
        finalInsumosVal = existingTaskObj.insumos;
      }

      let finalDiagVal = (existingTaskObj && existingTaskObj.diagnostico) ? existingTaskObj.diagnostico : '';
      let finalDescVal = desc;
      if ((!finalDescVal || finalDescVal.trim() === '') && existingTaskObj && existingTaskObj.descripcion) {
        finalDescVal = existingTaskObj.descripcion;
      }

      const dateEl = card.querySelector('.task-date');
      const taskDateVal = dateEl && dateEl.value ? dateEl.value : new Date().toISOString().split('T')[0];

      tasks.push({
        id: taskId,
        date: taskDateVal,
        centroCosto: cc,
        empleado: emp,
        horasEstimadas: parsedHours,
        status: status,
        descripcion: finalDescVal,
        insumos: finalInsumosVal,
        diagnostico: finalDiagVal,
        timerStart: timerStartVal,
        timerStarted: card.dataset.timerStarted === 'true',
        timerHistory: timerHistoryVal,
        synced: existingTaskObj ? existingTaskObj.synced : false
      });
    });
   
    if (!tasksValid) {
      return showToast("Completa el Centro de Costo y Operario de todas las tareas.", "danger");
    }

    // Block submission if there was a rendering error in the modal
    if (window.editModalHasRenderingError) {
      return showToast("No se puede guardar porque ocurrió un error al cargar las tareas. Por favor recargue la página.", "danger");
    }

    // Double check: if we are editing an order that originally had tasks, but now we collect 0 tasks
    if (editingOrder) {
      if (Array.isArray(editingOrder.tasks) && editingOrder.tasks.length > 0 && tasks.length === 0) {
        const confirmDelete = confirm("ATENCIÓN: La orden original tenía tareas, pero ahora se guardará con 0 tareas (se borrarán permanentemente). ¿Está seguro de que desea continuar?");
        if (!confirmDelete) {
          return;
        }
      }
    }
   
    const payload = {
      rodado: rodadoLabel,
      // The select's own value is a numeric catalog id (e.g. "507"), not a name - send the
      // option's visible label text, which is what syncWorker.js actually matches against
      // Taxes' Responsable field.
      responsable: (responsableEl && responsableEl.value && responsableEl.selectedIndex >= 0)
        ? responsableEl.options[responsableEl.selectedIndex].textContent.trim()
        : "AUTO",
      interno: internoVal,
      clasificacion: clasificacionEl.value,
      fechaEntrega: fechaEl ? fechaEl.value : '',
      horario: horaEl ? horaEl.value : '',
      incidente: incidenteEl ? incidenteEl.value : '',
      tasks: tasks,
      deletedTaskIds: Array.from(deletedTaskIdsInModal),
      estadoUnidad: editingOrder ? (editingOrder.estadoUnidad || 'fuera_de_servicio') : 'fuera_de_servicio',
      combustibleReset: currentCombustibleReset,
      // Al editar una orden que ya estaba en Historial (archivada), no forzar su regreso a Activas:
      // solo las ediciones desde la vista Activa deben garantizar archived:false.
      archived: editingOrder ? !!editingOrder.archived : false,
      syncStatus: 'pending',
      // The active sector TAB, not who's logged in - a Pañol/Admin account creating an order
      // on behalf of Edilicio/Herrería must have it land under that sector, not under "Admin"
      // (which used to make it invisible to Edilicio/Herrería users, since the server otherwise
      // only had the creator's own login-derived sector to go on).
      sector: currentSelectedSector,
      area: isEdilicioForm ? areaVal : (editingOrder ? editingOrder.area : null)
    };
   
    const url = currentEditingOrderId ? `/api/orders/${currentEditingOrderId}` : '/api/orders';
    const method = currentEditingOrderId ? 'PUT' : 'POST';
   
    const res = await fetch(url, {
      method: method,
      headers: { 
        'Content-Type': 'application/json',
        'x-user-username': localStorage.getItem('currentUserUsername') || ''
      },
      body: JSON.stringify(payload)
    });
   
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || (currentEditingOrderId ? "Error al actualizar la orden" : "Error al crear la orden"));
    }
    
    // Clean up task timers from localStorage for finished tasks
    taskCards.forEach(card => {
      const statusEl = card.querySelector('.task-status');
      if (statusEl && statusEl.value === 'Finalizada') {
        clearLocalStorageTimerKeys(card.id);
        if (activeIntervalTimers[card.id]) {
          clearInterval(activeIntervalTimers[card.id]);
          delete activeIntervalTimers[card.id];
        }
      }
    });
    
    const msg = currentEditingOrderId ? "Orden de Trabajo actualizada y encolada" : "Orden de Trabajo guardada y encolada para Taxes";
    showToast(msg, "success");
    closeNewOrderModal();
    await fetchOrders();
    switchView('home');
  } catch (error) {
    const prefixMsg = currentEditingOrderId ? "Fallo al actualizar la orden" : "Fallo al crear la orden";
    showToast(`${prefixMsg}: ${error.message}`, "danger");
    console.error(error);
  } finally {
    isSubmittingWorkOrder = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}

window.submitWorkOrder = submitWorkOrder;
window.updateHoursReadable = updateHoursReadable;

// 9. SYNC ACTIONS (RETRY & DELETE)
async function retrySync(orderId) {
  try {
    const currentUsername = localStorage.getItem('currentUserUsername') || '';
    const res = await fetch(`/api/orders/retry/${orderId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-username': currentUsername
      }
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Fallo al encolar reintento");
    }
    
    showToast("Reintento encolado", "warning");
    fetchOrders();
  } catch (error) {
    showToast(error.message, "danger");
    console.error(error);
  }
}

async function retryOrderFromModal() {
  if (currentRetryOrderId) {
    await retrySync(currentRetryOrderId);
    closeErrorModal();
  }
}

async function deleteOrder(orderId) {
  if (confirm("¿Confirmar BORRADO DEFINITIVO? La orden se eliminará de la app permanentemente.\n(Ya está guardada en Taxes, no se borrará del portal.)")) {
    try {
      const currentUsername = localStorage.getItem('currentUserUsername') || '';
      const res = await fetch(`/api/orders/${orderId}`, {
        method: 'DELETE',
        headers: { 'x-user-username': currentUsername }
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || "Error al eliminar orden", "danger");
        return;
      }
      showToast("Orden eliminada definitivamente", "success");
      fetchOrders();
    } catch (error) {
      showToast("Error al eliminar orden", "danger");
      console.error(error);
    }
  }
}

async function archiveOrder(orderId) {
  if (confirm("¿Archivar esta orden?\nPasará al Historial y podrás borrarla definitivamente desde ahí.\n(Ya está guardada en Taxes.)")) {
    try {
      const currentUsername = localStorage.getItem('currentUserUsername') || '';
      const res = await fetch(`/api/orders/${orderId}/archive`, {
        method: 'PATCH',
        headers: { 'x-user-username': currentUsername }
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || "Error al archivar orden", "danger");
        return;
      }
      showToast("Orden archivada ✓ — la encontrás en Historial", "success");
      fetchOrders();
      // If historial view is currently open, refresh it too
      const historialView = document.getElementById('view-historial');
      if (historialView && historialView.classList.contains('active')) {
        fetchArchivedOrders();
      }
    } catch (error) {
      showToast("Error al archivar orden", "danger");
      console.error(error);
    }
  }
}



async function cleanupSyncedOrders(type = 'finished') {
  let confirmMsg = "¿Estás seguro de limpiar de la app todas las órdenes finalizadas que estén operativas? (No se borrarán del portal de Taxes)";
  if (type === 'controlled') {
    confirmMsg = "¿Estás seguro de limpiar de la app todas las órdenes ya sincronizadas y controladas? (No se borrarán del portal de Taxes)";
  } else if (type === 'all-synced') {
    confirmMsg = "¿Estás seguro de limpiar de la app todas las órdenes sincronizadas en Taxes (hayan sido controladas o no)? (No se borrarán del portal de Taxes)";
  }

  if (confirm(confirmMsg)) {
    try {
      const currentUsername = localStorage.getItem('currentUserUsername') || '';
      const res = await fetch('/api/orders/cleanup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-username': currentUsername
        },
        body: JSON.stringify({
          sector: currentSelectedSector,
          type: type
        })
      });
      if (!res.ok) {
        let errMsg = "Error del servidor";
        try {
          const errData = await res.json();
          if (errData && errData.error) {
            errMsg = errData.error;
          }
        } catch (_) {}
        throw new Error(errMsg);
      }
      const data = await res.json();
      
      if (data.count > 0) {
        showToast(`Se limpiaron ${data.count} órdenes de la app`, "success");
        fetchOrders();
      } else {
        showToast("No hay órdenes que coincidan con la condición para limpiar", "info");
      }
    } catch (error) {
      showToast("Error al limpiar órdenes: " + error.message, "danger");
      console.error(error);
      if (error.message.includes("Session expired") || error.message.includes("invalid user")) {
        localStorage.removeItem('currentUserUsername');
        localStorage.removeItem('currentUserPassword');
        checkUserSession();
      }
    }
  }
}

async function runCleanupOption(option) {
  await cleanupSyncedOrders(option);
}

async function toggleOrderEstadoUnidad(event, orderId) {
  if (event) {
    event.stopPropagation(); // Avoid triggering card details click
  }
  const order = activeOrders.find(o => o.id === orderId);
  if (!order) return;

  const tasks = order.tasks || [];
  const hasActiveOrPausedTimer = tasks.some(t => t.status !== 'Finalizada' && (t.timerStarted || t.timerStart || t.status === 'En Proceso'));
  if (hasActiveOrPausedTimer) {
    showToast("No se puede marcar como Operativo mientras haya tareas activas o en proceso", "warning");
    return;
  }

  const currentStatus = order.estadoUnidad || 'operativo';
  const newStatus = currentStatus === 'operativo' ? 'fuera_de_servicio' : 'operativo';
  
  // Update locally first for immediate visual response
  order.estadoUnidad = newStatus;
  renderOrders();

  try {
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    });
    if (!res.ok) throw new Error("Failed to update status");
    showToast(`Unidad marcada como ${newStatus === 'operativo' ? 'Operativa' : 'Fuera de Servicio'}`, "success");

    if (newStatus === 'operativo') {
      showToast("Sincronizando tareas en Taxes al pasar a Operativo...", "info");
      try {
        const syncRes = await fetch('/api/orders/finalize-tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId })
        });
        const syncData = await syncRes.json();
        if (syncData.status === 'success' || syncData.success) {
          showToast("✅ Tareas inyectadas con éxito en Taxes al pasar a Operativo", "success");
        } else {
          showToast(syncData.message || "Error al inyectar tareas en Taxes", "warning");
        }
      } catch (syncErr) {
        console.error('[toggleOrderEstadoUnidad] Error al inyectar tareas:', syncErr);
      }
      fetchOrders();
    }
  } catch (error) {
    console.error(error);
    showToast("Error al actualizar estado de la unidad", "danger");
    // revert
    order.estadoUnidad = currentStatus;
    renderOrders();
  }
}

// 10. TOAST SYSTEM
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'info';
  if (type === 'success') icon = 'check_circle';
  if (type === 'danger') icon = 'error';
  if (type === 'warning') icon = 'sync';

  toast.innerHTML = `
    <span class="material-icons">${icon}</span>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  // Auto-dismiss after 3.5s
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(16px)';
    toast.style.transition = 'all 0.3s ease-out';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// 11. SEARCHABLE SELECTS & STOPWATCH SYSTEM
let activeIntervalTimers = {};

// --- HELPER FUNCTIONS FOR MECHANIC CONFLICT CHECKING ---
async function resolveDatabaseConflicts() {
  if (!activeOrders || !Array.isArray(activeOrders)) return;
  const runningByEmployee = {};

  activeOrders.forEach(order => {
    if (!order) return;
    (order.tasks || []).forEach(task => {
      // Skip tasks with no real id - a task without one is itself already broken data (from
      // some earlier bug), and resending it in the PUT below would make the server mint it a
      // brand-new id EVERY time this runs (every 2s poll), duplicating it forever instead of
      // ever actually fixing it.
      if (!task || !task.id) return;
      // Trust the server's own signal (timerStarted/timerStart), same as renderDashboard() and
      // getActiveRunningTasks() - a stale local timestamp left over on THIS device (e.g. from a
      // task whose real id was never resolved locally) used to make this function "detect" a
      // conflict that didn't actually exist server-side, pause it again, and PUT the same stale
      // task back - which is exactly how a null/broken-id task got re-duplicated every poll.
      const isRunning = task.timerStarted === true || task.timerStarted === 'true' || (task.timerStart !== null && task.timerStart > 0);
      if (isRunning && task.status !== 'Finalizada' && task.empleado) {
        if (!runningByEmployee[task.empleado]) {
          runningByEmployee[task.empleado] = [];
        }
        const localStart = localStorage.getItem(`timer_start_${task.id}`);
        runningByEmployee[task.empleado].push({
          order: order,
          task: task,
          timerStart: (localStart && parseInt(localStart) > 0) ? parseInt(localStart) : task.timerStart
        });
      }
    });
  });

  for (const empleado in runningByEmployee) {
    const tasks = runningByEmployee[empleado];
    if (tasks.length > 1) {
      // Sort by timerStart descending (newest first)
      tasks.sort((a, b) => b.timerStart - a.timerStart);

      const newestTask = tasks[0];
      const olderTasks = tasks.slice(1);

      console.warn(`Conflict auto-resolution: Mechanic ${empleado} had multiple active timers. Keeping newest task ${newestTask.task.id} running, pausing older ones.`);

      for (const tInfo of olderTasks) {
        const order = tInfo.order;
        const task = tInfo.task;
        const startVal = tInfo.timerStart;

        // Calculate elapsed time and update hours
        const elapsedMs = Date.now() - startVal;
        const elapsedMinutes = Math.round(elapsedMs / (1000 * 60));
        const currentHours = parseFloat(String(task.horasEstimadas).replace(',', '.')) || 0;
        const currentMinutes = hmmToMinutes(currentHours);
        const newHours = minutesToHmm(currentMinutes + elapsedMinutes);

        // Clean up local storage and update database task
        clearLocalStorageTimerKeys(task.id);

        // Idempotency guard: if a previous run (or another device) already closed this
        // segment, don't pile on another duplicate 'Pausó' entry — just make sure the
        // running flags are cleared below.
        const lastEvent = Array.isArray(task.timerHistory) && task.timerHistory.length > 0
          ? task.timerHistory[task.timerHistory.length - 1] : null;
        const lastType = lastEvent ? String(lastEvent.type || lastEvent.event || '').trim().toLowerCase() : '';
        if (!(lastType.startsWith('paus') || lastType.startsWith('fin'))) {
          addTimerEventToTask(task, 'Pausó');
        }
        task.timerStart = null;
        task.timerStarted = false; // Without this, renderDashboard() sees timerStarted still true
                                    // and "revives" a fresh phantom timer on the next render, which
                                    // this same function then re-pauses forever, spamming duplicate
                                    // 'Pausó' entries every poll cycle.
        task.horasEstimadas = newHours;

        // Drop any task with no real id before resending - the server mints a brand-new id for
        // whatever arrives without one, so including a broken/unsaved task here would duplicate
        // it (its properly-saved existing copy on the server is untouched either way, since it's
        // simply absent from this PUT's task list, not marked deleted).
        const updatedTasks = order.tasks.filter(t => t && t.id).map(t => {
          if (t.id === task.id) {
            return {
              ...t,
              timerStart: null,
              timerStarted: false,
              horasEstimadas: newHours,
              timerHistory: task.timerHistory || []
            };
          }
          return t;
        });

        try {
          await fetch(`/api/orders/${order.id}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'x-user-username': localStorage.getItem('currentUserUsername') || ''
            },
            body: JSON.stringify({
              ...order,
              tasks: updatedTasks
            })
          });
        } catch (e) {
          console.error("Error auto-resolving conflict in DB:", e);
        }
      }
    }
  }
}

function getActiveRunningTasks() {
  const running = [];
  
  // 1. Check activeOrders (synced with server)
  activeOrders.forEach(order => {
    (order.tasks || []).forEach(task => {
      // If the task is currently open in the modal, skip it here so the modal's live version takes precedence
      if (document.getElementById(task.id)) return;

      // Trust the server's own signal (timerStarted/timerStart) for whether this task is
      // actually running, same as renderDashboard() - a stale local timestamp left over after
      // the server paused this task from a DIFFERENT device must not make it look like the
      // employee is still busy with it here.
      const isServerRunning = task.timerStarted === true || task.timerStarted === 'true' || (task.timerStart !== null && task.timerStart > 0);
      if (isServerRunning && task.status !== 'Finalizada') {
        const localStart = localStorage.getItem(`timer_start_${task.id}`);
        running.push({
          source: 'order',
          orderId: order.id,
          orderInterno: order.interno,
          orderRodado: order.rodado,
          taskId: task.id,
          empleado: task.empleado,
          timerStart: (localStart && parseInt(localStart) > 0) ? parseInt(localStart) : task.timerStart
        });
      }
    });
  });

  // 2. Check current open modal tasks (which might not be saved on server yet)
  const modalContainer = document.getElementById('modal-tasks-list');
  if (modalContainer) {
    const taskCards = modalContainer.querySelectorAll('.task-item-card');
    taskCards.forEach(card => {
      const taskId = card.id;
      // Skip if we already added it from activeOrders (redundant safety check, but good)
      if (running.some(r => r.taskId === taskId)) return;

      const localStart = localStorage.getItem(`timer_start_${taskId}`);
      if (localStart) {
        const empSelect = card.querySelector('.task-emp');
        const statusSelect = card.querySelector('.task-status');
        
        if (empSelect && empSelect.value && statusSelect && statusSelect.value !== 'Finalizada') {
          const rodadoEl = document.getElementById('form-rodado');
          const rodadoText = rodadoEl && rodadoEl.selectedIndex >= 0 ? rodadoEl.options[rodadoEl.selectedIndex].text : '';
          const internoVal = document.getElementById('form-interno') ? document.getElementById('form-interno').value : '';

          running.push({
            source: 'modal',
            orderId: currentEditingOrderId,
            orderInterno: internoVal,
            orderRodado: rodadoText,
            taskId: taskId,
            empleado: empSelect.value,
            timerStart: parseInt(localStart)
          });
        }
      }
    });
  }

  return running;
}

function getConflictForEmployee(employeeVal, currentTaskId) {
  if (!employeeVal) return null;
  const running = getActiveRunningTasks();
  return running.find(r => r.empleado === employeeVal && r.taskId !== currentTaskId) || null;
}

async function pauseTask(taskInfo) {
  const taskId = taskInfo.taskId;
  const card = document.getElementById(taskId);
  if (card) {
    // Stop the timer in the modal UI
    await toggleTaskTimer(taskId);
    
    // If it's a saved order, we also want to sync the paused state to the server immediately
    if (taskInfo.source === 'order' && taskInfo.orderId) {
      const order = activeOrders.find(o => o.id === taskInfo.orderId);
      if (order) {
        const hoursInput = card.querySelector('.task-hours');
        const updatedHours = hoursInput ? parseFloat(String(hoursInput.value).replace(',', '.')) : 0;
        
        // Drop any task with no real id before resending - see resolveDatabaseConflicts() for
        // why (the server mints a brand-new id for it every time, duplicating it forever).
        const tasks = order.tasks.filter(t => t && t.id).map(t => {
          if (t.id === taskId) {
            const history = JSON.parse(card.dataset.timerHistory || '[]');
            return {
              ...t,
              timerStart: null,
              horasEstimadas: updatedHours,
              timerStarted: card.dataset.timerStarted === 'true',
              timerHistory: history
            };
          }
          return t;
        });

        try {
          await fetch(`/api/orders/${taskInfo.orderId}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'x-user-username': localStorage.getItem('currentUserUsername') || ''
            },
            body: JSON.stringify({
              ...order,
              tasks: tasks
            })
          });
        } catch (e) {
          console.error("Error updating paused task in DB:", e);
        }
      }
    }
  } else {
    // If it's not in the modal DOM (e.g. it's in another order on the dashboard)
    if (taskInfo.source === 'order' && taskInfo.orderId) {
      await toggleDashboardTaskTimer(taskInfo.orderId, taskId);
    }
  }
}

async function toggleTaskTimer(taskId) {
  const display = document.getElementById(`timer-display-${taskId}`);
  const btn = document.getElementById(`timer-btn-${taskId}`);
  if (!display || !btn) return;

  const timerKey = `timer_start_${taskId}`;
  const isRunning = localStorage.getItem(timerKey) !== null;

  if (!isRunning) {
    // Start stopwatch. First, check if an employee is selected
    const card = document.getElementById(taskId) || btn.closest('.task-item-card');
    const empSelect = card ? card.querySelector('.task-emp') : null;
    const employeeVal = empSelect ? empSelect.value : '';

    if (!employeeVal) {
      showToast("Por favor, selecciona un operario antes de iniciar el cronómetro.", "danger");
      return;
    }

    // Check for conflict
    const conflict = getConflictForEmployee(employeeVal, taskId);
    if (conflict) {
      const empOpt = cachedCatalogs.empleados.find(e => e.value === employeeVal);
      const empName = empOpt ? empOpt.label : "El operario";
      const rodadoInfo = conflict.orderRodado || `Interno ${conflict.orderInterno}`;
      const confirmMsg = `El mecánico ${empName} ya está trabajando en otra tarea activa para el rodado: ${rodadoInfo}.\n\n¿Desea pausar esa tarea automáticamente para iniciar esta?`;
      
      if (confirm(confirmMsg)) {
        await pauseTask(conflict);
      } else {
        return; // User cancelled
      }
    }

    // Clear initial estimate hours on first start of timer
    if (card && card.dataset.timerStarted !== 'true') {
      const hoursInput = card.querySelector('.task-hours');
      if (hoursInput) {
        hoursInput.value = '0.00';
        updateHoursReadable(hoursInput);
      }
      card.dataset.timerStarted = 'true';
      addTaskTimerEvent(card, 'Inició');
    } else if (card) {
      addTaskTimerEvent(card, 'Reanudó');
    }

    const startTime = Date.now();
    localStorage.setItem(timerKey, startTime);
    startTimerInterval(taskId, startTime);

    // Update Button UI
    btn.classList.add('running');
    btn.querySelector('.material-icons').textContent = 'stop';
    btn.querySelector('.btn-text').textContent = 'Detener';
    showToast("Cronómetro iniciado", "info");

    const internoEl = document.getElementById('form-interno');
    const ccEl = card ? card.querySelector('.task-cc') : null;
    const descEl = card ? card.querySelector('.task-desc') : null;
    syncTaskStartToParteTaller(
      internoEl ? internoEl.value : '',
      ccEl ? ccEl.value : '',
      currentSelectedSector,
      descEl ? descEl.value : ''
    );
  } else {
    // Stop stopwatch
    const startTime = parseInt(localStorage.getItem(timerKey));
    clearLocalStorageTimerKeys(taskId);

    // Clear interval
    if (activeIntervalTimers[taskId]) {
      clearInterval(activeIntervalTimers[taskId]);
      delete activeIntervalTimers[taskId];
    }

    // Calculate elapsed minutes
    const elapsedMs = Date.now() - startTime;
    const elapsedMinutes = Math.round(elapsedMs / (1000 * 60));
    const addedHoursHmm = minutesToHmm(elapsedMinutes);

    // Find and update hours input in this task card
    const card = document.getElementById(taskId) || btn.closest('.task-item-card');
    let totalHours = addedHoursHmm;
    if (card) {
      addTaskTimerEvent(card, 'Pausó');
      const history = JSON.parse(card.dataset.timerHistory || '[]');
      const totalMinutes = Math.round(calculateTotalElapsedSeconds(history, null) / 60);
      totalHours = minutesToHmm(totalMinutes);
      const hoursInput = card.querySelector('.task-hours');
      if (hoursInput) {
        hoursInput.value = totalHours.toFixed(2);
        updateHoursReadable(hoursInput);
      }
    }

    // Reset Button UI
    btn.classList.remove('running');
    btn.querySelector('.material-icons').textContent = 'play_arrow';
    btn.querySelector('.btn-text').textContent = 'Iniciar';
    display.textContent = '00:00:00';
    showToast(`Tiempo sumado: +${formatDecimalHours(addedHoursHmm)}. Total: ${formatDecimalHours(totalHours)}`, "success");
  }
}

function hmmToMinutes(hmmVal) {
  const h = Math.floor(hmmVal);
  const m = Math.round((hmmVal - h) * 100);
  return h * 60 + m;
}

function minutesToHmm(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  const val = h + m / 100;
  return parseFloat(val.toFixed(2));
}

function calculateTotalElapsedSeconds(timerHistory, timerStart) {
  const now = Date.now();
  
  if (timerStart !== null && timerStart !== undefined && parseInt(timerStart) > 0) {
    const startMs = parseInt(timerStart);
    let historyMs = 0;
    
    if (Array.isArray(timerHistory) && timerHistory.length > 0) {
      const sorted = [...timerHistory].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      let segStart = null;
      sorted.forEach(ev => {
        const type = String(ev.type || ev.event || '').trim().toLowerCase();
        if ((type.startsWith('inici') || type.startsWith('reanud')) && ev.timestamp < startMs) {
          segStart = ev.timestamp;
        } else if ((type.startsWith('paus') || type.startsWith('fin')) && segStart !== null && ev.timestamp <= startMs) {
          historyMs += (ev.timestamp - segStart);
          segStart = null;
        }
      });
    }
    
    const activeMs = Math.max(0, now - startMs);
    const totalMs = historyMs + Math.min(activeMs, 43200000);
    return Math.max(0, Math.floor(totalMs / 1000));
  }

  let totalMs = 0;
  if (Array.isArray(timerHistory) && timerHistory.length > 0) {
    const sorted = [...timerHistory].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    let currentStart = null;
    sorted.forEach(event => {
      const type = String(event.type || event.event || '').trim().toLowerCase();
      if (type.startsWith('inici') || type.startsWith('reanud')) {
        currentStart = event.timestamp;
      } else if (type.startsWith('paus') || type.startsWith('fin')) {
        if (currentStart !== null) {
          totalMs += (event.timestamp - currentStart);
          currentStart = null;
        }
      }
    });
    if (currentStart !== null) {
      totalMs += (now - currentStart);
    }
  }
  return Math.max(0, Math.floor(totalMs / 1000));
}

function formatDecimalHours(hmmVal) {
  const totalMinutes = hmmToMinutes(hmmVal);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, '0')}min`;
}

function updateHoursReadable(inputEl) {
  const readableEl = inputEl.parentElement.querySelector('.hours-readable');
  if (!readableEl) return;
  const val = parseFloat(String(inputEl.value).replace(',', '.')) || 0;
  readableEl.textContent = val > 0 ? formatDecimalHours(val) : '';
}

function clearLocalStorageTimerKeys(taskId) {
  localStorage.removeItem(`timer_start_${taskId}`);
  localStorage.removeItem(`warned_8h_${taskId}`);
  localStorage.removeItem(`authorized_12h_${taskId}`);

  const taskKeyPattern = `_${taskId}_`;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.includes(taskKeyPattern) || key.endsWith(`_${taskId}`))) {
      localStorage.removeItem(key);
      i--;
    }
  }
}

function startTimerInterval(taskId, startTime) {
  const display = document.getElementById(`timer-display-${taskId}`);
  if (!display) return;

  if (activeIntervalTimers[taskId]) {
    clearInterval(activeIntervalTimers[taskId]);
  }

  const card = document.getElementById(taskId);
  const history = card ? JSON.parse(card.dataset.timerHistory || '[]') : [];

  function update() {
    const totalSeconds = calculateTotalElapsedSeconds(history, startTime);
    const hh = Math.floor(totalSeconds / 3600);
    const mm = Math.floor((totalSeconds % 3600) / 60);
    const ss = totalSeconds % 60;
    display.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    checkTimerThresholds(taskId, startTime);
    renderEmployeeHoursSummary();
  }

  update();
  activeIntervalTimers[taskId] = setInterval(update, 1000);
}

function convertSelectToSearchable(selectEl) {
  if (!selectEl) return;

  // Ensure we do not double wrap
  let wrapper = selectEl.closest('.searchable-select-container');
  let dropdownPanel, listContainer, trigger, labelSpan, searchInput, countSpan;

  if (wrapper) {
    dropdownPanel = wrapper.querySelector('.searchable-select-dropdown');
    listContainer = wrapper.querySelector('.searchable-select-options-list');
    trigger = wrapper.querySelector('.searchable-select-trigger');
    labelSpan = trigger.querySelector('.trigger-label');
    searchInput = dropdownPanel.querySelector('.searchable-select-search-input');
    countSpan = dropdownPanel.querySelector('.searchable-select-options-count');
  } else {
    // Wrap
    wrapper = document.createElement('div');
    wrapper.className = 'searchable-select-container';
    wrapper.style.width = '100%';
    wrapper.style.maxWidth = '100%';
    wrapper.style.boxSizing = 'border-box';
    wrapper.style.position = 'relative';
    selectEl.parentNode.insertBefore(wrapper, selectEl);
    wrapper.appendChild(selectEl);

    // Hide original select visually but keep for HTML5 validation/submits
    selectEl.style.position = 'absolute';
    selectEl.style.opacity = '0';
    selectEl.style.pointerEvents = 'none';
    selectEl.style.width = '0';
    selectEl.style.height = '0';

    // Create trigger
    trigger = document.createElement('div');
    trigger.className = 'searchable-select-trigger';
    trigger.style.display = 'flex';
    trigger.style.justifyContent = 'space-between';
    trigger.style.alignItems = 'center';
    trigger.style.width = '100%';
    trigger.style.maxWidth = '100%';
    trigger.style.boxSizing = 'border-box';

    trigger.style.overflow = 'hidden';

    labelSpan = document.createElement('span');
    labelSpan.className = 'trigger-label';
    labelSpan.style.display = 'block';
    labelSpan.style.flex = '1';
    labelSpan.style.minWidth = '0';
    labelSpan.style.overflow = 'hidden';
    labelSpan.style.textOverflow = 'ellipsis';
    labelSpan.style.whiteSpace = 'nowrap';
    labelSpan.style.marginRight = '8px';
    labelSpan.textContent = 'Seleccionar...';

    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'material-icons';
    arrowSpan.textContent = 'arrow_drop_down';
    arrowSpan.style.flexShrink = '0';

    trigger.appendChild(labelSpan);
    trigger.appendChild(arrowSpan);
    wrapper.appendChild(trigger);

    // Create dropdown panel
    dropdownPanel = document.createElement('div');
    dropdownPanel.className = 'searchable-select-dropdown';

    const searchBox = document.createElement('div');
    searchBox.className = 'searchable-select-search-box';
    const searchIcon = document.createElement('span');
    searchIcon.className = 'material-icons';
    searchIcon.textContent = 'search';
    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'searchable-select-search-input';
    searchInput.placeholder = 'Buscar...';
    searchBox.appendChild(searchIcon);
    searchBox.appendChild(searchInput);
    dropdownPanel.appendChild(searchBox);

    countSpan = document.createElement('div');
    countSpan.className = 'searchable-select-options-count';
    dropdownPanel.appendChild(countSpan);

    listContainer = document.createElement('ul');
    listContainer.className = 'searchable-select-options-list';
    dropdownPanel.appendChild(listContainer);

    wrapper.appendChild(dropdownPanel);

    // Toggle dropdown visibility
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.searchable-select-dropdown.open').forEach(p => {
        if (p !== dropdownPanel) {
          p.classList.remove('open');
          p.previousElementSibling.classList.remove('active');
        }
      });
      const isOpen = dropdownPanel.classList.contains('open');
      dropdownPanel.classList.toggle('open', !isOpen);
      trigger.classList.toggle('active', !isOpen);
      if (!isOpen) {
        rebuildList(); // Always rebuild from underlying <select> to prevent stale lists
        searchInput.value = '';
        searchInput.focus();
        filterOptions('');
        selectEl.dataset.prevVal = selectEl.value; // Store previous value before change
      }
    });

    // Close when clicking elsewhere
    document.addEventListener('click', (e) => {
      if (!wrapper.contains(e.target)) {
        dropdownPanel.classList.remove('open');
        trigger.classList.remove('active');
      }
    });

    // Filter input event
    searchInput.addEventListener('input', () => {
      filterOptions(searchInput.value);
    });

    searchInput.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  function rebuildList() {
    listContainer.innerHTML = '';
    const options = Array.from(selectEl.options);
    
    // Update options count
    const totalCount = options.length - (options[0] && options[0].value === '' ? 1 : 0);
    countSpan.textContent = `${totalCount} de ${totalCount} opciones`;

    const currentVal = String(selectEl.value || '').trim();
    let hasSelected = false;

    options.forEach(opt => {
      const optVal = String(opt.value || '').trim();
      const isSelected = currentVal !== '' ? (optVal === currentVal) : (opt.selected || optVal === '');

      if (opt.value === '' && opt.text.includes('Seleccionar')) {
        if (isSelected && currentVal === '') {
          labelSpan.textContent = opt.text;
          hasSelected = true;
        }
        return;
      }

      const li = document.createElement('li');
      li.className = 'searchable-select-option';
      if (isSelected && (currentVal !== '' || !hasSelected)) {
        li.classList.add('selected');
        labelSpan.textContent = opt.text;
        hasSelected = true;
      }
      li.textContent = opt.text;
      li.dataset.value = opt.value;

      li.addEventListener('click', (e) => {
        e.stopPropagation();
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));

        labelSpan.textContent = opt.text;
        dropdownPanel.classList.remove('open');
        trigger.classList.remove('active');

        listContainer.querySelectorAll('.searchable-select-option').forEach(el => el.classList.remove('selected'));
        li.classList.add('selected');
      });

      listContainer.appendChild(li);
    });

    if (!hasSelected && currentVal === '') {
      const placeholderOpt = options.find(o => o.value === '');
      labelSpan.textContent = placeholderOpt ? placeholderOpt.text : 'Seleccionar...';
    }

    if (listContainer.children.length === 0) {
      const li = document.createElement('li');
      li.className = 'searchable-select-option no-results';
      li.textContent = 'No hay opciones disponibles';
      listContainer.appendChild(li);
    }
  }

  // Auto rebuild when underlying select value changes
  selectEl.addEventListener('change', () => {
    rebuildList();
  });

  function filterOptions(query) {
    const term = query.toLowerCase().trim();
    const items = Array.from(listContainer.querySelectorAll('.searchable-select-option:not(.no-results):not(.searchable-select-custom-item)'));
    let matchCount = 0;

    items.forEach(item => {
      const text = item.textContent.toLowerCase();
      const isMatch = text.includes(term);
      item.style.display = isMatch ? 'block' : 'none';
      if (isMatch) matchCount++;

      // Exact match highlighting
      let isExact = false;
      if (term) {
        const textClean = text.trim();
        if (textClean === term) {
          isExact = true;
        } else {
          // Check for "interno [term]" pattern in the option text
          const match = textClean.match(/interno\s+(\S+)/);
          if (match && match[1] === term) {
            isExact = true;
          }
        }
      }

      if (isExact) {
        item.classList.add('exact-match-highlight');
      } else {
        item.classList.remove('exact-match-highlight');
      }
    });

    let noResultsMsg = listContainer.querySelector('.no-results');
    if (matchCount === 0 && items.length > 0) {
      if (!noResultsMsg) {
        noResultsMsg = document.createElement('li');
        noResultsMsg.className = 'searchable-select-option no-results';
        noResultsMsg.textContent = 'Sin resultados';
        listContainer.appendChild(noResultsMsg);
      }
    } else if (noResultsMsg) {
      noResultsMsg.remove();
    }

    // Clean up any old custom item
    const oldCustomItem = listContainer.querySelector('.searchable-select-custom-item');
    if (oldCustomItem) oldCustomItem.remove();

    if (term) {
      // Check if term already matches an option text exactly
      const options = Array.from(selectEl.options);
      const exactExists = options.some(opt => opt.text.toLowerCase().trim() === term);

      if (!exactExists) {
        const li = document.createElement('li');
        li.className = 'searchable-select-option searchable-select-custom-item';
        li.style.borderTop = '1px dashed var(--border-color)';
        li.style.marginTop = '4px';
        li.style.color = 'var(--primary)';
        li.style.fontWeight = 'bold';
        li.style.display = 'block'; // ensure visible
        li.innerHTML = `<span class="material-icons" style="font-size:14px; vertical-align:middle; margin-right:4px;">add_circle</span> Usar: "${query}"`;
        
        li.addEventListener('click', (e) => {
          e.stopPropagation();
          const newOpt = document.createElement('option');
          newOpt.value = query;
          newOpt.textContent = query;
          selectEl.appendChild(newOpt);

          selectEl.value = query;
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));

          labelSpan.textContent = query;
          dropdownPanel.classList.remove('open');
          trigger.classList.remove('active');

          rebuildList();
        });
        
        listContainer.appendChild(li);
        
        // If there was a "Sin resultados" message, remove it since we now have the "Usar" custom item
        const noResultsMsg = listContainer.querySelector('.no-results');
        if (noResultsMsg) noResultsMsg.remove();
      }
    }

    countSpan.textContent = `${matchCount} de ${items.length} opciones`;
  }

  rebuildList();
  selectEl.rebuildSearchable = rebuildList;
}

// --- OPERATOR & ACTIVE TAREAS DASHBOARD ---
let activeDashboardIntervals = {};

function isItemMatchingCurrentPtSector(item) {
  const currentPtSector = (currentSelectedSector === 'Herrería') ? 'herreria' : 'taller';
  if (!item || !item.sector) return true;
  return item.sector === currentPtSector;
}

function updateDashboardStats() {
  const activeLocalOrders = getFilteredActiveOrders();

  const totalTallerEl = document.getElementById('stat-total-taller');
  const subTallerEl = document.getElementById('stat-sub-taller');
  const activeOrdersEl = document.getElementById('stat-active-orders');
  const subActiveEl = document.getElementById('stat-sub-active');
  const overduePrevEl = document.getElementById('stat-overdue-prev');
  const subPrevEl = document.getElementById('stat-sub-prev');
  const syncRateEl = document.getElementById('stat-sync-rate');

  let fueraDeServicioNum = 0;
  let enReparacionNum = 0;

  if (window._ptDisplayState) {
    const ds = window._ptDisplayState;
    fueraDeServicioNum = (ds.fuera_de_servicio || []).filter(isItemMatchingCurrentPtSector).length;
    enReparacionNum = (ds.reparacion || []).filter(isItemMatchingCurrentPtSector).length;
  } else {
    const ptOutCountEl = document.getElementById('pt-out-count');
    const ptRepCountEl = document.getElementById('pt-rep-count');
    const outText = ptOutCountEl ? ptOutCountEl.textContent.trim() : '';
    const repText = ptRepCountEl ? ptRepCountEl.textContent.trim() : '';
    if (outText && parseInt(outText) > 0) fueraDeServicioNum = parseInt(outText);
    if (repText && parseInt(repText) > 0) enReparacionNum = parseInt(repText);
  }

  // Fallback: If numbers evaluate to 0 but activeLocalOrders has items, use activeLocalOrders count so it NEVER falsely displays 0!
  if (fueraDeServicioNum === 0 && activeLocalOrders.length > 0) {
    fueraDeServicioNum = activeLocalOrders.length;
  }
  if (enReparacionNum === 0 && activeLocalOrders.length > 0) {
    enReparacionNum = activeLocalOrders.length;
  }

  if (totalTallerEl) totalTallerEl.textContent = fueraDeServicioNum;
  
  let workingOrdersCount = 0;
  activeLocalOrders.forEach(o => {
    const isWorking = (o.tasks || []).some(t => t.timerStart !== null && t.timerStart > 0);
    if (isWorking) workingOrdersCount++;
  });

  let preventiveAlertCount = 0;
  if (prevCombustibleData && Array.isArray(prevCombustibleData) && prevCombustibleData.length > 0) {
    preventiveAlertCount = prevCombustibleData.filter(item => {
      const a5 = String(item.alerta5k || '').toLowerCase();
      const a10 = String(item.alerta10k || '').toLowerCase();
      return ['realizar', 'urgente', 'service'].some(w => a5.includes(w) || a10.includes(w));
    }).length;
  } else if (prevFlotaData && Array.isArray(prevFlotaData) && prevFlotaData.length > 0) {
    preventiveAlertCount = prevFlotaData.filter(item => {
      const alerta = String(item.alerta || '').toLowerCase();
      return alerta.includes('realizar') || alerta.includes('urgente') || alerta.includes('service');
    }).length;
  } else {
    preventiveAlertCount = activeLocalOrders.filter(o => o.clasificacion === 'Preventivo').length;
  }
  
  if (subTallerEl) subTallerEl.textContent = `${workingOrdersCount} trabajando`;
  if (activeOrdersEl) activeOrdersEl.textContent = enReparacionNum;
  if (subActiveEl) subActiveEl.textContent = `${workingOrdersCount} unidades trabajando`;
  if (overduePrevEl) overduePrevEl.textContent = preventiveAlertCount;
  if (subPrevEl) subPrevEl.textContent = `${preventiveAlertCount} este mes`;
  
  if (syncRateEl) {
    const syncedCount = activeLocalOrders.filter(o => o.taxesOrderNumber).length;
    const rate = activeLocalOrders.length > 0 ? Math.round((syncedCount / activeLocalOrders.length) * 100) : 100;
    syncRateEl.textContent = `${rate}%`;
  }
}

function renderDashboard() {
  try {
    const gridWorking = document.getElementById('grid-working');
    const gridPaused = document.getElementById('grid-paused');

    if (!gridWorking || !gridPaused) return;

    // IMPORTANT: Clear ALL existing dashboard timer intervals before re-rendering
    // This prevents ghost intervals from keeping dead timers alive after pause/finish
    for (const key in activeDashboardIntervals) {
      clearInterval(activeDashboardIntervals[key]);
      delete activeDashboardIntervals[key];
    }

    // Active tasks from all orders (including local, error, pending, syncing, success)
    const activeLocalOrders = getOrdersForDashboard();

    // Update Stats Dashboard Cards dynamically
    updateDashboardStats();
    
    const workingTasks = [];
    const pausedTasks = [];

    const workingEmployeeLabels = new Set();
    const pausedEmployeeLabels = new Set();
    const seenTaskKeys = new Set();

    activeLocalOrders.forEach(order => {
      (order.tasks || []).forEach(task => {
        if (task && task.status !== 'Finalizada') {
          const empOpt = (cachedCatalogs && cachedCatalogs.empleados)
            ? cachedCatalogs.empleados.find(e => e.value === task.empleado)
            : null;
          const empLabel = (empOpt ? empOpt.label : task.empleado) || 'Desconocido';

          const cleanDesc = (task.descripcion || '').trim().toLowerCase();
          const cleanEmp = String(empLabel).trim().toLowerCase();

          // Route this task's card to a sector's board strictly by the TASK's own centro de
          // costo. Some orders (e.g. the generic "REPARACIONES INTERNAS" bucket) are genuinely
          // shared: several people from different sectors each log their own task under the
          // very same OT/order, so the order's overall clasificacion/sector must not decide
          // where an individual task's card ends up - only that task's own centro de costo does.
          const orderFallbackSector = isHerreriaOrder(order) ? 'Herrería' : (isEdilicioOrder(order) ? 'Edilicio' : 'Taller');
          const taskSector = getTaskCentroCostoSector(task.centroCosto, orderFallbackSector);
          if ((currentSelectedSector || 'Taller') !== taskSector) {
            return; // Esta tarea pertenece al tablero de otro sector
          }

          const taskUniqueKey = `${order.interno || ''}_${cleanEmp}_${cleanDesc}`;

          if (seenTaskKeys.has(taskUniqueKey)) {
            return; // Skip duplicate task cards
          }

          const timerKey = `timer_start_${task.id}`;
          const localTimerStart = localStorage.getItem(timerKey);

          // The server is the single source of truth across devices - whether the timer is
          // running is decided by the server's own task.timerStarted/task.timerStart, never by
          // this device's localStorage alone. localStorage only remembers the precise start
          // timestamp for THIS device's live countdown. Without this guard, a task the server
          // paused from a DIFFERENT device (e.g. its own auto-pause-on-conflict) kept showing
          // as running here forever - even after a refresh - because the stale local timestamp
          // never got cleared and this used to fall back to it whenever the server's timerStart
          // was null, regardless of what task.timerStarted actually said.
          const isTimerRunning = task.timerStarted === true || task.timerStarted === 'true' || (task.timerStart !== null && task.timerStart > 0);

          let resolvedTimerStart = null;
          if (isTimerRunning) {
            if (task.timerStart !== null && task.timerStart > 0) {
              resolvedTimerStart = task.timerStart;
              localStorage.setItem(timerKey, String(task.timerStart));
            } else if (localTimerStart !== null && parseInt(localTimerStart) > 0) {
              resolvedTimerStart = parseInt(localTimerStart);
            } else {
              resolvedTimerStart = Date.now();
              localStorage.setItem(timerKey, String(resolvedTimerStart));
            }
          } else if (localTimerStart !== null) {
            // Server says this task is NOT running - drop the stale local timestamp so a
            // refresh actually fixes the mismatch instead of perpetuating it.
            clearLocalStorageTimerKeys(task.id);
          }

          // Label the card with the order's own clasificacion, except when the order carries a
          // sector-wide "Herrería"/"Edilicio" tag but this particular task's centro de costo
          // says Taller - then showing the order's tag would misidentify this task's own sector.
          const orderClsLower = String(order.clasificacion || '').toLowerCase();
          const orderClsIsSectorLabel = orderClsLower.includes('herrer') || orderClsLower.includes('edil');
          const displayClasificacion = (orderClsIsSectorLabel && taskSector === 'Taller')
            ? 'Taller'
            : (order.clasificacion || '');

          const taskInfo = {
            orderId: order.id,
            interno: order.interno || '',
            rodado: order.rodado || '',
            clasificacion: displayClasificacion,
            taskId: task.id,
            empleadoValue: task.empleado || '',
            empleadoLabel: empLabel,
            centroCosto: task.centroCosto || '',
            horasEstimadas: parseFloat(String(task.horasEstimadas).replace(',', '.')) || 0,
            descripcion: task.descripcion || '(Sin descripción)',
            timerStart: isTimerRunning ? resolvedTimerStart : null,
            isTimerRunning: isTimerRunning,
            timerHistory: task.timerHistory || [],
            taxesOrderNumber: order.taxesOrderNumber || null
          };

          seenTaskKeys.add(taskUniqueKey);

          const hasPauseHistory = Array.isArray(task.timerHistory) && task.timerHistory.some(h => {
            const tStr = String(h.type || h.action || h.event || '').toLowerCase();
            return tStr.includes('paus') || tStr.includes('pause');
          });

          if (isTimerRunning) {
            workingTasks.push(taskInfo);
            workingEmployeeLabels.add(String(empLabel).toLowerCase().trim());
          } else if (hasPauseHistory) {
            pausedTasks.push(taskInfo);
            pausedEmployeeLabels.add(String(empLabel).toLowerCase().trim());
          }
        }
      });
    });

    // Render count badges
    const countWorkingEl = document.getElementById('count-working');
    if (countWorkingEl) countWorkingEl.textContent = workingTasks.length;
    
    const countPausedEl = document.getElementById('count-paused');
    if (countPausedEl) countPausedEl.textContent = pausedTasks.length;

    // 1. Render working grid
    if (workingTasks.length === 0) {
      gridWorking.innerHTML = `<div class="empty-dashboard-state">No hay operarios trabajando actualmente.</div>`;
    } else {
      gridWorking.innerHTML = workingTasks.map((t, idx) => {
        const elapsedSeconds = calculateTotalElapsedSeconds(t.timerHistory, t.timerStart);
        const hh = Math.floor(elapsedSeconds / 3600);
        const mm = Math.floor((elapsedSeconds % 3600) / 60);
        const ss = elapsedSeconds % 60;
        const displayTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
        const startLabel = getTimelineFullHistoryLabel(t.timerHistory, t.timerStart);
        const isLast = idx === workingTasks.length - 1;

        return `
          <div class="timeline-item working">
            <div class="timeline-track">
              <div class="timeline-time">${startLabel}</div>
              <span class="timeline-dot"><span class="material-icons">play_arrow</span></span>
              ${isLast ? '' : '<span class="timeline-line"></span>'}
            </div>
            <div class="dashboard-card working" id="dash-card-${t.taskId}">
              <button type="button" class="dashboard-card-add-task-btn" onclick="editOrder('${t.orderId}')" title="Agregar tarea a esta orden">
                <span class="material-icons" style="font-size:18px;">add</span>
              </button>
              <div class="timeline-top-row">
                <span class="interno-chip working">
                  <span class="interno-chip-label">INTERNO</span>
                  <span class="interno-chip-number">${t.interno}</span>
                </span>
                <div class="timeline-top-right">
                  ${t.clasificacion ? `<span class="badge-tag">${t.clasificacion}</span>` : ''}
                  ${t.taxesOrderNumber ? `<span class="badge-status success" style="padding: 2px 6px; font-size: 11px; font-weight: 700;">OT Taxes: #${t.taxesOrderNumber}</span>` : `<span class="badge-status warning" style="padding: 2px 6px; font-size: 11px;">OT Pendiente Taxes (Interno #${t.interno})</span>`}
                </div>
              </div>
              <div class="dashboard-card-title" title="${t.empleadoLabel}">${t.empleadoLabel}</div>
              <div class="dashboard-card-desc">${t.descripcion}</div>
              <div style="font-size: 11px; font-weight: 700; color: #38bdf8; margin-top: 3px; display: inline-flex; align-items: center; gap: 4px; background: rgba(56, 189, 248, 0.12); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.3);">
                <span class="material-icons" style="font-size: 13px; color: #38bdf8;">timer</span>
                <span>Tiempo Estimado: ${getEstimatedTaskHoursMax(t.descripcion, t.empleadoLabel)}</span>
              </div>
              <div class="dashboard-card-timer" id="dash-timer-${t.taskId}">${displayTime}</div>
              <div class="dashboard-card-actions">
                <button type="button" class="btn btn-warning btn-xs" onclick="toggleDashboardTaskTimer('${t.orderId}', '${t.taskId}')">
                  <span class="material-icons" style="font-size:14px;">pause</span> Pausar
                </button>
                <button type="button" class="btn btn-primary btn-xs" onclick="markDashboardTaskFinished('${t.orderId}', '${t.taskId}')" style="background-color: var(--success); color: white; border-color: var(--success);">
                  <span class="material-icons" style="font-size:14px;">check</span> Fin
                </button>
              </div>
            </div>
          </div>
        `;
      }).join('');

      workingTasks.forEach(t => {
        startDashboardTimerUpdate(t.taskId, t.timerStart);
      });
    }

    // 2. Render paused grid
    if (pausedTasks.length === 0) {
      gridPaused.innerHTML = `<div class="empty-dashboard-state">No hay tareas en pausa.</div>`;
    } else {
      gridPaused.innerHTML = pausedTasks.map((t, idx) => {
        let displayHours = parseFloat(String(t.horasEstimadas || 0).replace(',', '.')) || 0;
        if (Array.isArray(t.timerHistory) && t.timerHistory.length > 0) {
          const totalSeconds = calculateTotalElapsedSeconds(t.timerHistory, null);
          displayHours = minutesToHmm(Math.round(totalSeconds / 60));
        }
        const startLabel = getTimelineFullHistoryLabel(t.timerHistory, t.timerStart);
        const isLast = idx === pausedTasks.length - 1;
        return `
          <div class="timeline-item paused">
            <div class="timeline-track">
              <div class="timeline-time">${startLabel}</div>
              <span class="timeline-dot"><span class="material-icons">pause</span></span>
              ${isLast ? '' : '<span class="timeline-line"></span>'}
            </div>
            <div class="dashboard-card paused">
              <button type="button" class="dashboard-card-add-task-btn" onclick="editOrder('${t.orderId}')" title="Agregar tarea a esta orden">
                <span class="material-icons" style="font-size:18px;">add</span>
              </button>
              <div class="timeline-top-row">
                <span class="interno-chip paused">
                  <span class="interno-chip-label">INTERNO</span>
                  <span class="interno-chip-number">${t.interno}</span>
                </span>
                <div class="timeline-top-right">
                  ${t.clasificacion ? `<span class="badge-tag">${t.clasificacion}</span>` : ''}
                  ${t.taxesOrderNumber ? `<span class="badge-status success" style="padding: 2px 6px; font-size: 11px; font-weight: 700;">OT Taxes: #${t.taxesOrderNumber}</span>` : `<span class="badge-status warning" style="padding: 2px 6px; font-size: 11px;">OT Pendiente Taxes (Interno #${t.interno})</span>`}
                </div>
              </div>
              <div class="dashboard-card-title" title="${t.empleadoLabel}">${t.empleadoLabel}</div>
              <div class="dashboard-card-desc">${t.descripcion}</div>
              <div style="font-size: 11px; font-weight: 700; color: #38bdf8; margin-top: 3px; display: inline-flex; align-items: center; gap: 4px; background: rgba(56, 189, 248, 0.12); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.3);">
                <span class="material-icons" style="font-size: 13px; color: #38bdf8;">timer</span>
                <span>Tiempo Estimado: ${getEstimatedTaskHoursMax(t.descripcion, t.empleadoLabel)}</span>
              </div>
              <div class="dashboard-card-timer" style="display:flex; align-items:center; gap:6px;">
                <input
                  type="number"
                  id="dash-hours-input-${t.taskId}"
                  value="${displayHours.toFixed(2)}"
                  step="0.05"
                  min="0"
                  style="width:80px; font-size:16px; font-weight:700; text-align:center; border:1.5px solid var(--primary); border-radius:6px; padding:2px 4px; background:var(--card-bg); color:var(--text); outline:none;"
                  title="Podés escribir las horas manualmente (ej: 1.30 = 1h 30min)"
                />
                <span style="font-size:13px; color:var(--text-muted);">hrs</span>
                <button type="button" onclick="saveDashboardTaskHours('${t.orderId}','${t.taskId}')" title="Guardar horas" style="background:var(--primary);color:#fff;border:none;border-radius:6px;padding:3px 7px;cursor:pointer;font-size:13px;">
                  <span class="material-icons" style="font-size:15px;vertical-align:middle;">save</span>
                </button>
              </div>
              <div class="dashboard-card-actions">
                <button type="button" class="btn btn-primary btn-xs" onclick="toggleDashboardTaskTimer('${t.orderId}', '${t.taskId}')" style="background-color: var(--success); color: white; border-color: var(--success);">
                  <span class="material-icons" style="font-size:14px;">play_arrow</span> Reanudar
                </button>
                <button type="button" class="btn btn-primary btn-xs" onclick="markDashboardTaskFinished('${t.orderId}', '${t.taskId}')" style="background-color: var(--success); color: white; border-color: var(--success);">
                  <span class="material-icons" style="font-size:14px;">check</span> Fin
                </button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    renderEmployeeHoursSummary();
  } catch (err) {
    console.error("Error rendering dashboard:", err);
  }
}

function startDashboardTimerUpdate(taskId, startTime) {
  const display = document.getElementById(`dash-timer-${taskId}`);
  if (!display) return;

  if (activeDashboardIntervals[taskId]) {
    clearInterval(activeDashboardIntervals[taskId]);
  }

  let history = [];
  activeOrders.forEach(order => {
    (order.tasks || []).forEach(task => {
      if (task.id === taskId) {
        history = task.timerHistory || [];
      }
    });
  });

  function update() {
    const totalSeconds = calculateTotalElapsedSeconds(history, startTime);
    const hh = Math.floor(totalSeconds / 3600);
    const mm = Math.floor((totalSeconds % 3600) / 60);
    const ss = totalSeconds % 60;
    const el = document.getElementById(`dash-timer-${taskId}`);
    if (el) {
      el.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
      checkTimerThresholds(taskId, startTime);
      renderEmployeeHoursSummary();
    } else {
      clearInterval(activeDashboardIntervals[taskId]);
      delete activeDashboardIntervals[taskId];
    }
  }

  update();
  activeDashboardIntervals[taskId] = setInterval(update, 1000);
}

function addTimerEventToTask(task, type) {
  if (!task.timerHistory) {
    task.timerHistory = [];
  }
  const now = new Date();
  const formatted = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  task.timerHistory.push({ type, formatted, timestamp: Date.now() });
}

// Fire-and-forget: the moment a mechanic starts (or resumes) working on a truck, push that
// unit into the Parte Taller Google Sheet's "Reparacion" list - today the app only computes
// this live (in adjustPtStateLists) for its own screen, so the sheet itself never learns a
// unit is being worked on unless someone manually adds it there.
async function syncTaskStartToParteTaller(internoRaw, centroCosto, orderSector, descripcion) {
  try {
    const sector = getTaskCentroCostoSector(centroCosto, orderSector);
    if (sector !== 'Taller') return; // Herrería/Edilicio track their own live state, not this sheet

    const internoVal = String(internoRaw || '').trim();
    if (!internoVal) return;

    const stateRes = await fetch('/api/parte-taller/estado');
    const stateData = await stateRes.json();
    const state = stateData.state || stateData;
    const cleanDesc = String(descripcion || '').trim().toUpperCase();
    if (!cleanDesc) return;

    // Don't re-push the same task description every time it's paused/resumed - the sheet
    // side just appends new lines onto whatever's already there for this interno.
    const alreadyThere = ['reparacion', 'fuera_de_servicio'].some(listName => {
      const unit = (state[listName] || []).find(u => String(u.interno).trim().toUpperCase() === internoVal.toUpperCase());
      if (!unit) return false;
      const items = Array.isArray(unit.novedad_items) ? unit.novedad_items.map(x => String(x.texto || '').trim().toUpperCase()) : [];
      return items.includes(cleanDesc) || String(unit.novedad || '').toUpperCase().includes(cleanDesc);
    });
    if (alreadyThere) return;

    // Send the canonical display name (e.g. "Rodriguez Nicolas") the sheet's Responsable
    // dropdown actually accepts - not the raw login username, and not the order's raw
    // "Apellido, Nombre" text either (a Data Validation dropdown set to reject invalid input
    // silently discards a non-matching write, leaving the old value in place with no error).
    const responsableName = normalizeToCanonicalSupervisor(resolveCurrentSupervisor()) || '';
    await fetch('/api/parte-taller/novedad', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accion: 'actualizar_estado_flota',
        interno: internoVal,
        estado: 'reparacion',
        motivo: descripcion || 'Tarea sin descripción',
        responsable: responsableName,
        sector: 'taller'
      })
    });
    if (typeof fetchParteTallerEstado === 'function') fetchParteTallerEstado();
  } catch (e) {
    console.error('Error sincronizando inicio de tarea a Parte Taller:', e);
  }
}

async function toggleDashboardTaskTimer(orderId, taskId) {
  let order = activeOrders.find(o => o.id === orderId);
  if (!order) return;

  // Find the actual task object inside order.tasks (by reference)
  let task = order.tasks.find(t => t.id === taskId);
  if (!task) return;

  // Shield this task from the background poll (fetchOrders) until this save round-trips -
  // otherwise a poll landing mid-save can momentarily restore the pre-pause/pre-resume state.
  pendingOptimisticTaskIds.add(taskId);

  const timerKey = `timer_start_${taskId}`;
  const localStart = localStorage.getItem(timerKey);
  const isRunning = (task.timerStart !== null && task.timerStart > 0) || (localStart !== null && parseInt(localStart) > 0);

  // Snapshot so we can roll back this task's optimistic changes if the server rejects
  // the save (e.g. another device already started a timer for this same employee).
  const preSnapshot = {
    timerStart: task.timerStart,
    timerStarted: task.timerStarted,
    horasEstimadas: task.horasEstimadas,
    timerHistory: JSON.parse(JSON.stringify(task.timerHistory || [])),
    localStart: localStart
  };
  const wasStarting = !isRunning;

  if (!isRunning) {
    // --- START TIMER ---
    const employeeVal = task.empleado;
    if (employeeVal) {
      const conflict = getConflictForEmployee(employeeVal, taskId);
      if (conflict) {
        const empOpt = cachedCatalogs.empleados.find(e => e.value === employeeVal);
        const empName = empOpt ? empOpt.label : "El operario";
        const rodadoInfo = conflict.orderRodado || `Interno ${conflict.orderInterno}`;
        const confirmMsg = `El mecánico ${empName} ya está trabajando en otra tarea activa para el rodado: ${rodadoInfo}.\n\n¿Desea pausar esa tarea automáticamente para iniciar esta?`;
        
        if (confirm(confirmMsg)) {
          await pauseTask(conflict);
          // The background poll (fetchOrders) can replace `activeOrders` wholesale while we
          // awaited pauseTask()'s own save - re-resolve so we mutate the CURRENT task object,
          // not a detached one that a fresh render will never see.
          order = activeOrders.find(o => o.id === orderId);
          task = order ? order.tasks.find(t => t.id === taskId) : null;
          if (!order || !task) {
            showToast("La tarea ya no está disponible, reintentá.", "danger");
            return;
          }
        } else {
          return;
        }
      }
    }

    const isStarted = task.timerStarted === true || task.timerStarted === 'true' || (Array.isArray(task.timerHistory) && task.timerHistory.length > 0);
    if (!isStarted) {
      task.horasEstimadas = 0;
      task.timerStarted = true;
      addTimerEventToTask(task, 'Inició');
    } else {
      task.timerStarted = true;
      addTimerEventToTask(task, 'Reanudó');
    }

    task.timerStart = Date.now();
    localStorage.setItem(timerKey, task.timerStart);
    showToast("Cronómetro iniciado", "info");
    syncTaskStartToParteTaller(order.interno, task.centroCosto, order.sector, task.descripcion);
  } else {
    // --- PAUSE TIMER ---
    const startTime = (task.timerStart !== null && task.timerStart > 0) ? task.timerStart : (localStart ? parseInt(localStart) : Date.now());
    const elapsedMs = Date.now() - startTime;
    const elapsedMinutes = Math.round(elapsedMs / (1000 * 60));
    const addedHoursHmm = minutesToHmm(elapsedMinutes);

    task.timerStart = null;
    task.timerStarted = false;
    addTimerEventToTask(task, 'Pausó');

    const totalMinutes = Math.round(calculateTotalElapsedSeconds(task.timerHistory, null) / 60);
    task.horasEstimadas = minutesToHmm(totalMinutes);

    clearLocalStorageTimerKeys(taskId);

    // Kill the dashboard interval for this task immediately
    if (activeDashboardIntervals[taskId]) {
      clearInterval(activeDashboardIntervals[taskId]);
      delete activeDashboardIntervals[taskId];
    }

    showToast(`Tiempo sumado: +${formatDecimalHours(addedHoursHmm)}.`, "success");
  }

  // OPTIMISTIC UPDATE: re-render dashboard immediately with in-memory changes
  // so the user sees the timer stop/start without waiting for the server
  renderDashboard();

  // Then persist to server in background
  try {
    const currentUsername = localStorage.getItem('currentUserUsername') || 'paniol@contenedoreshugo.com.ar';
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json',
        'x-user-username': currentUsername
      },
      body: JSON.stringify({
        rodado: order.rodado,
        responsable: order.responsable,
        fechaEntrega: order.fechaEntrega,
        horario: order.horario,
        interno: order.interno,
        clasificacion: order.clasificacion,
        incidente: order.incidente,
        // Drop any task with no real id before resending - see resolveDatabaseConflicts() for
        // why (the server mints a brand-new id for it every time, duplicating it forever).
        tasks: (order.tasks || []).filter(t => t && t.id)
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Error al comunicarse con el servidor");
    }
    fetchOrders();
  } catch (error) {
    // Roll back the optimistic timer start so the UI doesn't keep showing a timer
    // running that the server refused to save (e.g. employee conflict on another device).
    if (wasStarting) {
      task.timerStart = preSnapshot.timerStart;
      task.timerStarted = preSnapshot.timerStarted;
      task.horasEstimadas = preSnapshot.horasEstimadas;
      task.timerHistory = preSnapshot.timerHistory;
      if (preSnapshot.localStart === null) {
        clearLocalStorageTimerKeys(taskId);
      } else {
        localStorage.setItem(timerKey, preSnapshot.localStart);
      }
      if (activeDashboardIntervals[taskId]) {
        clearInterval(activeDashboardIntervals[taskId]);
        delete activeDashboardIntervals[taskId];
      }
      renderDashboard();
    }
    showToast(`Error al guardar el cronómetro: ${error.message}`, "danger");
    console.error(error);
  } finally {
    pendingOptimisticTaskIds.delete(taskId);
  }
}

async function saveDashboardTaskHours(orderId, taskId) {
  const input = document.getElementById(`dash-hours-input-${taskId}`);
  if (!input) return;
  const rawVal = String(input.value).replace(',', '.');
  const newHours = parseFloat(rawVal);
  if (isNaN(newHours) || newHours < 0) {
    showToast('Ingresá un valor válido (ej: 1.30 para 1h 30min)', 'warning');
    return;
  }

  const order = activeOrders.find(o => o.id === orderId);
  if (!order) return;
  const task = (order.tasks || []).find(t => t.id === taskId);
  if (!task) return;

  // Update local state
  task.horasEstimadas = newHours;

  // Persist to server
  try {
    const currentUsername = localStorage.getItem('currentUserUsername') || '';
    const res = await fetch(`/api/orders/${orderId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-user-username': currentUsername },
      body: JSON.stringify({ horasEstimadas: newHours })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast(`Horas guardadas: ${newHours.toFixed(2)} hs`, 'success');
  } catch (err) {
    showToast('Error al guardar horas: ' + err.message, 'danger');
  }
}

async function markDashboardTaskFinished(orderId, taskId) {
  let order = activeOrders.find(o => o.id === orderId);
  if (!order) return;

  if (!confirm("¿Estás seguro de marcar esta tarea como FINALIZADA?")) return;

  // Find the actual task object inside order.tasks (by reference)
  let task = order.tasks.find(t => t.id === taskId);
  if (!task) return;

  const empOpt = cachedCatalogs.empleados.find(e => e.value === task.empleado);
  const empName = empOpt ? empOpt.label : task.empleado || '';

  const ccOpt = cachedCatalogs.centrosCosto.find(c => c.value === task.centroCosto);
  const ccName = ccOpt ? ccOpt.label : task.centroCosto || '';

  const taskInfo = {
    interno: order.interno,
    rodado: order.rodado,
    empleado: empName,
    centroCosto: ccName,
    descripcion: task.descripcion,
    insumos: task.insumos || '',
    estadoUnidad: order.estadoUnidad || 'operativo'
  };

  // Prompt for optional diagnosis and insumos
  const result = await promptDiagnosis(taskInfo);

  // The background poll (fetchOrders) can replace `activeOrders` wholesale while the diagnosis
  // dialog was open (it has no timeout - the user can take as long as they want) - re-resolve
  // so the mutations below land on the CURRENT task object, not a detached one that a fresh
  // render will never see (which looked like "finalizing paused it instead").
  order = activeOrders.find(o => o.id === orderId);
  task = order ? order.tasks.find(t => t.id === taskId) : null;
  if (!order || !task) {
    showToast("La tarea ya no está disponible, reintentá.", "danger");
    return;
  }

  if (result) {
    let additions = [];
    if (result.diagnosis) additions.push('Diagnóstico: ' + result.diagnosis);
    if (result.insumos) additions.push('Insumos: ' + result.insumos);
    if (additions.length > 0) {
      const prefix = task.descripcion ? ' - ' : '';
      task.descripcion = (task.descripcion || '').trim() + prefix + additions.join(' - ');
    }
    if (result.insumos) {
      task.insumos = result.insumos;
    }
  }

  // Shield this task from the background poll until this save round-trips (see
  // toggleDashboardTaskTimer for why).
  pendingOptimisticTaskIds.add(taskId);

  task.timerStart = null;
  // Also clear timerStarted - leaving it true (its value while running) made this task look
  // like an active timer to the employee-conflict check on every later save (server-side
  // autoPauseConflictingTimers, client-side getConflictForEmployee), forever after it finished.
  task.timerStarted = false;
  clearLocalStorageTimerKeys(taskId);

  addTimerEventToTask(task, 'Fin');

  const totalMinutes = Math.round(calculateTotalElapsedSeconds(task.timerHistory, null) / 60);
  task.horasEstimadas = minutesToHmm(totalMinutes);

  task.status = "Finalizada";

  // Kill the dashboard interval for this task immediately
  if (activeDashboardIntervals[taskId]) {
    clearInterval(activeDashboardIntervals[taskId]);
    delete activeDashboardIntervals[taskId];
  }

  // OPTIMISTIC UPDATE: re-render dashboard immediately so user sees the task disappear
  renderDashboard();
  renderOrders(); // Re-render order list to update unit status badges
  showToast("Tarea finalizada", "success");

  const allCompleted = (order.tasks || []).filter(t => t !== null && t !== undefined).every(t => t.status === "Finalizada");

  // Then persist to server in background
  try {
    const currentUsername = localStorage.getItem('currentUserUsername') || 'paniol@contenedoreshugo.com.ar';
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json',
        'x-user-username': currentUsername
      },
      body: JSON.stringify({
        rodado: order.rodado,
        responsable: order.responsable,
        fechaEntrega: order.fechaEntrega,
        horario: order.horario,
        interno: order.interno,
        clasificacion: order.clasificacion,
        incidente: order.incidente,
        // Drop any task with no real id before resending - see resolveDatabaseConflicts() for
        // why (the server mints a brand-new id for it every time, duplicating it forever).
        tasks: (order.tasks || []).filter(t => t && t.id),
        estadoUnidad: order.estadoUnidad || 'operativo'
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Error al comunicarse con el servidor");
    }
    fetchOrders();

    const stillHasPendingTasks = (order.tasks || []).some(t => t.id !== taskId && t.status !== 'Finalizada');
    if (!stillHasPendingTasks) {
      openUnitStatusModal(order.interno, orderId);
    }

    if (allCompleted) {
      showToast("¡Todas las tareas finalizadas! Puedes subir la orden a Taxes manualmente desde el listado de órdenes.", "success");
    }
  } catch (error) {
    showToast(`Error al finalizar la tarea: ${error.message}`, "danger");
    console.error(error);
  } finally {
    pendingOptimisticTaskIds.delete(taskId);
  }
}

// --- ACTIVE MECHANICS MANAGEMENT ---

async function fetchActiveMechanics() {
  try {
    const res = await fetch(`/api/active-mechanics?_=${Date.now()}`);
    if (res.ok) {
      activeMechanicsList = await res.json();
      // If we are currently on home view, render it
      const activeTab = document.querySelector('.nav-item.active');
      if (activeTab && activeTab.id === 'nav-home') {
        renderDashboard();
      }
    }
  } catch (error) {
    console.error("Error fetching active mechanics:", error);
  }
}

// --- INSUMOS RETIRADOS (aprobación de supervisor por turno) ---

let cachedInsumosPendientes = [];
let cachedInsumosTurno = '-';

async function fetchAndRenderInsumosPendientes() {
  try {
    const res = await fetch(`/api/insumos/pendientes?_=${Date.now()}`);
    if (!res.ok) return;
    const data = await res.json();
    cachedInsumosPendientes = Array.isArray(data.items) ? data.items : [];
    cachedInsumosTurno = data.turno || '-';
    renderInsumosPendientesPreview();
  } catch (error) {
    console.error("Error fetching insumos pendientes:", error);
  }
}

function renderInsumosPendientesPreview() {
  const preview = document.getElementById('insumos-pendientes-preview');
  const countEl = document.getElementById('count-insumos-pendientes');
  const turnoLabelEl = document.getElementById('insumos-turno-label');
  if (!preview) return;

  if (countEl) countEl.textContent = cachedInsumosPendientes.length;
  if (turnoLabelEl) turnoLabelEl.textContent = cachedInsumosTurno;

  if (cachedInsumosPendientes.length === 0) {
    preview.innerHTML = '<div class="empty-dashboard-state">No hay insumos pendientes de aprobación en este turno.</div>';
    return;
  }

  preview.innerHTML = cachedInsumosPendientes.slice(0, 4).map(item => `
    <div class="free-employee-tag" style="width: 100%; justify-content: space-between; text-align: left;">
      <span><strong>${escapeHtml(item.interno)}</strong> - ${escapeHtml(item.material)}</span>
      <span>Cant: ${escapeHtml(item.cantidad)} · ${escapeHtml(item.operario)}</span>
    </div>
  `).join('');
}

function openInsumosApprovalModal() {
  const modal = document.getElementById('insumos-approval-modal');
  if (modal) modal.classList.add('open');
  renderInsumosApprovalModalTable();
  fetchAndRenderInsumosPendientes().then(renderInsumosApprovalModalTable);
}

async function refreshInsumosApprovalModal() {
  const tbody = document.getElementById('insumos-modal-tbody');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px; color:var(--text-muted);">Actualizando...</td></tr>';
  }
  await fetchAndRenderInsumosPendientes();
  renderInsumosApprovalModalTable();
}

function closeInsumosApprovalModal() {
  const modal = document.getElementById('insumos-approval-modal');
  if (modal) modal.classList.remove('open');
}

function renderInsumosApprovalModalTable() {
  const tbody = document.getElementById('insumos-modal-tbody');
  const turnoLabelEl = document.getElementById('insumos-modal-turno-label');
  if (!tbody) return;
  if (turnoLabelEl) turnoLabelEl.textContent = cachedInsumosTurno;

  if (cachedInsumosPendientes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px; color:var(--text-muted);">No hay insumos pendientes de aprobación en este turno.</td></tr>';
    return;
  }

  tbody.innerHTML = cachedInsumosPendientes.map(item => `
    <tr>
      <td style="padding: 8px;">${escapeHtml(item.otTaxes)}</td>
      <td style="padding: 8px;">${escapeHtml(item.interno)}</td>
      <td style="padding: 8px;">${escapeHtml(item.material)}</td>
      <td style="padding: 8px;">${escapeHtml(item.cantidad)}</td>
      <td style="padding: 8px;">${escapeHtml(item.operario)}</td>
      <td style="padding: 8px;">${escapeHtml(item.turno)}</td>
      <td style="padding: 8px; white-space: nowrap;">
        <button class="btn btn-xs" style="background: var(--success); color: white; border-color: var(--success);" onclick="resolveInsumoPendiente('${item.idEgreso}', 'aprobado')">Aprobar</button>
        <button class="btn btn-xs" style="background: var(--danger); color: white; border-color: var(--danger);" onclick="resolveInsumoPendiente('${item.idEgreso}', 'rechazado')">Rechazar</button>
      </td>
    </tr>
  `).join('');
}

async function resolveInsumoPendiente(idEgreso, estado) {
  try {
    const res = await fetch(`/api/insumos/${encodeURIComponent(idEgreso)}/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-username': localStorage.getItem('currentUserUsername') || ''
      },
      body: JSON.stringify({ estado })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Error al resolver el insumo");
    }
    cachedInsumosPendientes = cachedInsumosPendientes.filter(i => i.idEgreso !== idEgreso);
    renderInsumosApprovalModalTable();
    renderInsumosPendientesPreview();
    showToast(estado === 'aprobado' ? "Insumo aprobado" : "Insumo rechazado", "success");
  } catch (error) {
    showToast(error.message || "Error al resolver el insumo", "danger");
  }
}

let customAddedMechanicsList = [];

function openActiveMechanicsModal() {
  const container = document.getElementById('active-mechanics-checklist-container');
  if (!container) return;

  const currentUser = localStorage.getItem('currentUserUsername');
  const userSector = getSectorByUsername(currentUser);
  let baseList = userSector === 'Herrería' ? getSectorEmployees('Herrería') : getSectorEmployees('Taller');

  if (Array.isArray(activeMechanicsList)) {
    activeMechanicsList.forEach(m => {
      if (m && !baseList.includes(m)) baseList.push(m);
    });
  }
  if (Array.isArray(customAddedMechanicsList)) {
    customAddedMechanicsList.forEach(m => {
      if (m && !baseList.includes(m)) baseList.push(m);
    });
  }

  renderActiveMechanicsChecklist(baseList);

  const searchInput = document.getElementById('filter-mechanics-search');
  if (searchInput) searchInput.value = '';

  document.getElementById('active-mechanics-modal').classList.add('open');
}

function renderActiveMechanicsChecklist(list) {
  const container = document.getElementById('active-mechanics-checklist-container');
  if (!container) return;

  if (!list || list.length === 0) {
    container.innerHTML = `<div class="empty-dashboard-state" style="padding:10px;">No hay empleados en la lista.</div>`;
    return;
  }

  container.innerHTML = list.map((name) => {
    const isChecked = activeMechanicsList.includes(name);
    const safeName = name.replace(/'/g, "\\'");
    return `
      <div class="mechanic-check-row" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-bottom: 1px solid var(--border-color); background: var(--card-bg); border-radius: 6px; margin-bottom: 4px;" data-mechanic-name="${name.toLowerCase()}">
        <label style="display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 500; cursor: pointer; flex: 1; margin: 0; user-select: none;">
          <input type="checkbox" name="active_mechanic" value="${name}" ${isChecked ? 'checked' : ''} style="width: 17px; height: 17px;">
          <span>${name}</span>
        </label>
        <button type="button" class="btn btn-secondary btn-xs" onclick="removeMechanicFromModal('${safeName}')" title="Sacar empleado" style="padding: 2px 6px; font-size: 11px; color: var(--danger); border-color: var(--danger);">
          <span class="material-icons" style="font-size: 14px;">delete</span> Sacar
        </button>
      </div>
    `;
  }).join('');
}

function filterActiveMechanicsModal(query) {
  const term = String(query || '').toLowerCase().trim();
  const rows = document.querySelectorAll('.mechanic-check-row');
  rows.forEach(row => {
    const name = row.getAttribute('data-mechanic-name') || '';
    row.style.display = name.includes(term) ? 'flex' : 'none';
  });
}

function addNewCustomMechanicFromModal() {
  const input = document.getElementById('new-custom-mechanic-name');
  if (!input) return;
  const name = input.value.trim();
  if (!name) {
    showToast("Ingresá el nombre del empleado", "warning");
    return;
  }

  if (!customAddedMechanicsList.includes(name)) {
    customAddedMechanicsList.push(name);
  }
  if (!activeMechanicsList.includes(name)) {
    activeMechanicsList.push(name);
  }

  input.value = '';
  showToast(`Empleado "${name}" colocado en la lista`, "success");
  openActiveMechanicsModal();
}

function removeMechanicFromModal(name) {
  if (confirm(`¿Sacar a "${name}" de la lista del turno?`)) {
    activeMechanicsList = activeMechanicsList.filter(m => m !== name);
    customAddedMechanicsList = customAddedMechanicsList.filter(m => m !== name);
    const row = document.querySelector(`.mechanic-check-row[data-mechanic-name="${name.toLowerCase()}"]`);
    if (row) row.remove();
    showToast(`Empleado "${name}" sacado de la lista`, "info");
  }
}

function closeActiveMechanicsModal() {
  document.getElementById('active-mechanics-modal').classList.remove('open');
}

function toggleAllActiveMechanics(isChecked) {
  const checkboxes = document.querySelectorAll('input[name="active_mechanic"]');
  checkboxes.forEach(cb => cb.checked = isChecked);
}

async function saveActiveMechanicsList() {
  const checkboxes = document.querySelectorAll('input[name="active_mechanic"]:checked');
  const selectedList = Array.from(checkboxes).map(cb => cb.value);

  try {
    const res = await fetch('/api/active-mechanics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list: selectedList })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Error al comunicarse con el servidor");
    }

    const data = await res.json();
    activeMechanicsList = data.list;
    showToast("Lista de mecánicos activos actualizada", "success");
    closeActiveMechanicsModal();
    renderDashboard();
  } catch (error) {
    console.error(error);
    showToast(`Error al guardar la lista de mecánicos activos: ${error.message}`, "danger");
  }
}

// ==========================================
// CARGA MASIVA (BULK ORDERS) FUNCTIONS
// ==========================================

function renderBulkVehicleSelector() {
  const container = document.getElementById('bulk-vehicle-list');
  if (!container) return;

  if (!cachedCatalogs.rodados || cachedCatalogs.rodados.length === 0) {
    container.innerHTML = `<div class="text-muted" style="padding: 10px; text-align: center;">No hay vehículos cargados en el catálogo.</div>`;
    return;
  }

  let html = '';
  cachedCatalogs.rodados.forEach(rodado => {
    const label = rodado.label || '';
    const value = rodado.value || '';
    const interno = rodado.interno || '';
    const patente = rodado.patente || '';
    const modelo = rodado.modelo || '';
    const equipo = rodado.equipo || '';

    html += `
      <div class="bulk-vehicle-item" id="bulk-item-${value}" onclick="toggleBulkItemClick('${value}')">
        <input type="checkbox" id="bulk-chk-${value}" value="${value}" onclick="event.stopPropagation(); handleBulkItemCheckChange();">
        <div class="bulk-vehicle-info">
          <span class="bulk-vehicle-name">${label}</span>
          <span class="bulk-vehicle-subtext">Interno: ${interno} | Patente: ${patente} | ${modelo} ${equipo}</span>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  
  // Update selected count
  handleBulkItemCheckChange();
}

function toggleBulkItemClick(value) {
  const chk = document.getElementById(`bulk-chk-${value}`);
  if (chk) {
    chk.checked = !chk.checked;
    const itemCard = document.getElementById(`bulk-item-${value}`);
    if (itemCard) {
      if (chk.checked) {
        itemCard.classList.add('selected');
      } else {
        itemCard.classList.remove('selected');
      }
    }
    handleBulkItemCheckChange();
  }
}

function handleBulkItemCheckChange() {
  const checkboxes = document.querySelectorAll('#bulk-vehicle-list input[type="checkbox"]');
  let selectedCount = 0;
  checkboxes.forEach(chk => {
    const itemCard = document.getElementById(`bulk-item-${chk.value}`);
    if (itemCard) {
      if (chk.checked) {
        itemCard.classList.add('selected');
        selectedCount++;
      } else {
        itemCard.classList.remove('selected');
      }
    }
  });

  const badge = document.getElementById('bulk-selected-count');
  if (badge) {
    badge.textContent = `${selectedCount} seleccionado${selectedCount === 1 ? '' : 's'}`;
  }

  // Render visual badges of selected vehicles
  renderSelectedVehicleBadges();

  // Update dynamic insumos grid
  updateBulkInsumosGrid();

  updateBulkSummary();
}

function renderSelectedVehicleBadges() {
  const container = document.getElementById('bulk-selected-badges');
  const wrapper = document.getElementById('bulk-selected-badges-container');
  if (!container || !wrapper) return;

  const checkboxes = document.querySelectorAll('#bulk-vehicle-list input[type="checkbox"]:checked');
  if (checkboxes.length === 0) {
    wrapper.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  wrapper.style.display = 'block';

  const selectedVehicles = [];
  checkboxes.forEach(chk => {
    const rodado = cachedCatalogs.rodados.find(r => r.value === chk.value);
    if (rodado) {
      selectedVehicles.push(rodado);
    }
  });

  // Sort selected vehicles numerically by internal number
  selectedVehicles.sort((a, b) => {
    const intA = parseInt(a.interno) || 0;
    const intB = parseInt(b.interno) || 0;
    return intA - intB;
  });

  let html = '';
  selectedVehicles.forEach(rodado => {
    html += `
      <span class="bulk-selected-badge" onclick="toggleBulkItemClick('${rodado.value}')" title="Haga clic para deseleccionar">
        ${rodado.interno || rodado.label}
      </span>
    `;
  });

  container.innerHTML = html;
}

function toggleAllBulkVehicles(selectAll) {
  const visibleItems = document.querySelectorAll('#bulk-vehicle-list .bulk-vehicle-item');
  visibleItems.forEach(item => {
    if (item.style.display !== 'none') {
      const chk = item.querySelector('input[type="checkbox"]');
      if (chk) {
        chk.checked = selectAll;
        if (selectAll) {
          item.classList.add('selected');
        } else {
          item.classList.remove('selected');
        }
      }
    }
  });
  handleBulkItemCheckChange();
}

function filterBulkVehicles(isFinished = false) {
  const searchInput = document.getElementById('bulk-vehicle-search');
  if (!searchInput) return;

  const query = searchInput.value;
  const items = document.querySelectorAll('#bulk-vehicle-list .bulk-vehicle-item');

  if (!query.trim()) {
    items.forEach(item => {
      item.style.display = 'flex';
    });
    return;
  }

  // Check if query ends with a separator (comma, dot, space, semicolon, newline)
  const endsWithSeparator = /[,\.\s;\n\r]$/.test(query);

  // Split query by commas, dots, semicolons, spaces or line breaks
  const rawParts = query.split(/[,\.\s;\n\r]+/);
  const parts = rawParts.map(p => p.trim().toLowerCase()).filter(p => p.length > 0);

  // Define which parts are fully finished/entered (e.g. followed by a separator or Enter/Blur pressed)
  const finishedParts = parts.filter((p, index) => {
    if (index < parts.length - 1) return true;
    return endsWithSeparator || isFinished;
  });

  const isMultiple = parts.length > 1;
  let checkedAny = false;

  items.forEach(item => {
    const checkbox = item.querySelector('input[type="checkbox"]');
    const value = checkbox ? checkbox.value : '';
    const rodado = cachedCatalogs.rodados.find(r => r.value === value);

    if (!rodado) {
      item.style.display = 'none';
      return;
    }

    const label = (rodado.label || '').toLowerCase();
    const interno = String(rodado.interno || '').toLowerCase().trim();
    const patente = (rodado.patente || '').toLowerCase();

    let isMatched = false;

    if (isMultiple) {
      // If multiple parts, match exactly by internal number
      isMatched = parts.includes(interno);
    } else {
      // Standard search for single term
      const singlePart = parts[0] || '';
      isMatched = interno.includes(singlePart) || label.includes(singlePart) || patente.includes(singlePart);
    }

    // Auto-check based on finished parts only. Never auto-uncheck — preserve manual selections.
    if (checkbox) {
      const isPartFinished = finishedParts.includes(interno);
      if (isPartFinished && !checkbox.checked) {
        checkbox.checked = true;
        item.classList.add('selected');
        checkedAny = true;
      }
    }

    if (isMatched) {
      item.style.display = 'flex';
    } else {
      item.style.display = 'none';
    }
  });

  if (checkedAny) {
    handleBulkItemCheckChange();
  }
}

function formatMinutesToHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  const val = h + m / 100;
  return val.toFixed(2);
}

function updateBulkSummary() {
  const startTimeVal = document.getElementById('bulk-time-start').value;
  const endTimeVal = document.getElementById('bulk-time-end').value;

  const checkboxes = document.querySelectorAll('#bulk-vehicle-list input[type="checkbox"]:checked');
  const numVehicles = checkboxes.length;

  const vehicleSummary = document.getElementById('bulk-summary-total-vehicles');
  if (vehicleSummary) {
    vehicleSummary.textContent = numVehicles;
  }

  const totalHoursEl = document.getElementById('bulk-summary-total-hours');
  const timePerVehicleEl = document.getElementById('bulk-summary-time-per-vehicle');
  const hoursPerVehicleEl = document.getElementById('bulk-summary-hours-per-vehicle');

  if (!startTimeVal || !endTimeVal) {
    if (totalHoursEl) totalHoursEl.textContent = "0h 00m";
    if (timePerVehicleEl) timePerVehicleEl.textContent = "0 min";
    if (hoursPerVehicleEl) hoursPerVehicleEl.textContent = "0.00 hs";
    return;
  }

  const [startH, startM] = startTimeVal.split(':').map(Number);
  const [endH, endM] = endTimeVal.split(':').map(Number);

  let startMinutes = startH * 60 + startM;
  let endMinutes = endH * 60 + endM;

  if (endMinutes < startMinutes) {
    // Crossed midnight, add 24 hours
    endMinutes += 24 * 60;
  }

  const diffMinutes = endMinutes - startMinutes;
  const totalHours = Math.floor(diffMinutes / 60);
  const remainingMinutes = diffMinutes % 60;

  if (totalHoursEl) {
    totalHoursEl.textContent = `${totalHours}h ${String(remainingMinutes).padStart(2, '0')}m`;
  }

  if (numVehicles > 0) {
    const minutesPerVehicle = diffMinutes / numVehicles;
    const hoursPerVehicleFormatted = formatMinutesToHMM(minutesPerVehicle);

    let minText = '';
    if (minutesPerVehicle < 1) {
      minText = `${minutesPerVehicle.toFixed(2)} min`;
    } else {
      minText = `${minutesPerVehicle.toFixed(1)} min`;
    }

    if (timePerVehicleEl) timePerVehicleEl.textContent = minText;
    if (hoursPerVehicleEl) hoursPerVehicleEl.textContent = `${hoursPerVehicleFormatted} hs`;
  } else {
    if (timePerVehicleEl) timePerVehicleEl.textContent = "0 min";
    if (hoursPerVehicleEl) hoursPerVehicleEl.textContent = "0.00 hs";
  }
}

let bulkTaskIndexCount = 0;

function addBulkTaskField(initialData = null) {
  const container = document.getElementById('bulk-tasks-container');
  if (!container) return;

  const taskIndex = container.querySelectorAll('.bulk-task-item-card').length;
  const taskId = `bulk-task-card-${Date.now()}-${bulkTaskIndexCount++}`;

  const currentUser = localStorage.getItem('currentUserUsername');
  const userSector = getSectorByUsername(currentUser);
  let defaultCcVal = "15"; // default to MECANICA
  if (userSector === 'Herrería') {
    const herrOpt = cachedCatalogs.centrosCosto.find(opt => opt.value === "16" || opt.value === "HERRERIA" || opt.label.toLowerCase().includes("herrer"));
    if (herrOpt) {
      defaultCcVal = herrOpt.value;
    }
  }

  // Build select option strings
  let ccOptions = `<option value="">Seleccionar Centro Costo...</option>`;
  cachedCatalogs.centrosCosto.forEach(opt => {
    const isSelected = initialData ? (opt.value === initialData.centroCosto) : (opt.value === defaultCcVal);
    ccOptions += `<option value="${opt.value}" ${isSelected ? "selected" : ""}>${opt.label}</option>`;
  });

  const cardHtml = `
    <div class="bulk-task-item-card" id="${taskId}" style="border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; margin-bottom: 12px; background: var(--card-bg); position: relative;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <span style="font-weight: 600; font-size: 13px; color: var(--text-muted);">Tarea #${taskIndex + 1}</span>
        <button type="button" class="btn btn-danger btn-xs" onclick="removeBulkTaskField('${taskId}')" style="display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border-radius: 50%;">
          <span class="material-icons" style="font-size: 16px;">delete</span>
        </button>
      </div>

      <div class="form-group" style="margin-bottom: 8px;">
        <label style="font-size: 12px; font-weight: 500; margin-bottom: 4px; display: block;">Centro de Costo *</label>
        <select class="bulk-task-cc" required onchange="updateBulkEmployeeDropdownForCard(this.closest('.bulk-task-item-card'))" style="width: 100%;">
          ${ccOptions}
        </select>
      </div>

      <div class="form-group" style="margin-bottom: 8px;">
        <label style="font-size: 12px; font-weight: 500; margin-bottom: 4px; display: block;">Empleado Asignado *</label>
        <select class="bulk-task-emp" required style="width: 100%;">
          <option value="">Seleccionar Empleado...</option>
        </select>
      </div>

      <div class="form-group" style="margin-bottom: 0;">
        <label style="font-size: 12px; font-weight: 500; margin-bottom: 4px; display: block;">Descripción de la Tarea *</label>
        <textarea class="bulk-task-desc" placeholder="Ej: Control de agua y aceite" required style="width: 100%; resize: vertical; font-family: monospace;" rows="4" oninput="updateBulkInsumosGrid()"></textarea>
      </div>
    </div>
  `;

  container.insertAdjacentHTML('beforeend', cardHtml);

  const cardElement = document.getElementById(taskId);
  updateBulkEmployeeDropdownForCard(cardElement, initialData ? initialData.empleado : null);
}

function removeBulkTaskField(taskId) {
  const card = document.getElementById(taskId);
  if (card) {
    card.remove();
    // Renumber remaining tasks
    const container = document.getElementById('bulk-tasks-container');
    if (container) {
      container.querySelectorAll('.bulk-task-item-card').forEach((item, index) => {
        const titleSpan = item.querySelector('span');
        if (titleSpan) titleSpan.textContent = `Tarea #${index + 1}`;
      });
    }
    updateBulkInsumosGrid();
  }
}

function updateBulkEmployeeDropdownForCard(card, defaultValue = null) {
  try {
    const ccSelect = card.querySelector('.bulk-task-cc');
    const empSelect = card.querySelector('.bulk-task-emp');
    if (!ccSelect || !empSelect) return;

    const selectedCc = ccSelect.value;
    const currentValue = defaultValue || empSelect.value;

    const currentUser = localStorage.getItem('currentUserUsername');
    const userSector = getSectorByUsername(currentUser);

    let filteredEmployees = cachedCatalogs.empleados || [];

    // Detect sector by label text of the selected CC option (robust, not hardcoded)
    const selectedOption = ccSelect.options[ccSelect.selectedIndex];
    const selectedLabel = selectedOption ? selectedOption.textContent.trim().toUpperCase() : '';
    const isHerreriaCC = selectedLabel.includes('HERRER') || selectedCc === "HERRERIA" || selectedCc === "16" || userSector === 'Herrería';
    const isMecanicaCC = selectedLabel.includes('MECAN') || selectedCc === "15" || selectedCc === "MECANICA";
    const isEdilicioCC = selectedLabel.includes('EDILIC') || selectedCc === "EDILICIO" || selectedCc === "8" || userSector === 'Edilicio';

    const cleanName = (str) => {
      if (typeof str !== 'string') return '';
      return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
    };

    if (isHerreriaCC) {
      // Herrería filter
      const herreriaNames = getSectorEmployees('Herrería');
      const herreriaNamesCleaned = new Set(herreriaNames.map(name => cleanName(name)));
      
      let matchedEmployees = (cachedCatalogs.empleados || []).filter(emp => {
        if (!emp || !emp.label) return false;
        const empCleaned = cleanName(emp.label);
        if (herreriaNamesCleaned.has(empCleaned)) return true;
        for (const hName of herreriaNamesCleaned) {
          if (empCleaned.includes(hName) || hName.includes(empCleaned)) {
            return true;
          }
        }
        return false;
      });

      herreriaNames.forEach(name => {
        const exists = matchedEmployees.some(emp => emp && emp.label && cleanName(emp.label) === cleanName(name));
        if (!exists) {
          matchedEmployees.push({ value: name, label: name });
        }
      });

      filteredEmployees = matchedEmployees.length >= 1 ? matchedEmployees : (cachedCatalogs.empleados || []);

    } else if (isMecanicaCC) { // MECANICA
      const mecanicaNames = getSectorEmployees('Taller');
      const mecanicaNamesCleaned = new Set(mecanicaNames.map(name => cleanName(name)));
      let matchedEmployees = (cachedCatalogs.empleados || []).filter(emp => {
        if (!emp || !emp.label) return false;
        const empCleaned = cleanName(emp.label);
        if (mecanicaNamesCleaned.has(empCleaned)) return true;
        for (const mName of mecanicaNamesCleaned) {
          if (empCleaned.includes(mName) || mName.includes(empCleaned)) {
            return true;
          }
        }
        return false;
      });

      mecanicaNames.forEach(name => {
        const exists = matchedEmployees.some(emp => emp && emp.label && cleanName(emp.label) === cleanName(name));
        if (!exists) {
          matchedEmployees.push({ value: name, label: name });
        }
      });

      filteredEmployees = matchedEmployees.length >= 1 ? matchedEmployees : (cachedCatalogs.empleados || []);
    } else if (isEdilicioCC) {
      const edilicioNames = getSectorEmployees('Edilicio');
      const edilicioNamesCleaned = new Set(edilicioNames.map(name => cleanName(name)));
      let matchedEmployees = (cachedCatalogs.empleados || []).filter(emp => {
        if (!emp || !emp.label) return false;
        const empCleaned = cleanName(emp.label);
        return edilicioNamesCleaned.has(empCleaned);
      });

      edilicioNames.forEach(name => {
        const exists = matchedEmployees.some(emp => emp && emp.label && cleanName(emp.label) === cleanName(name));
        if (!exists) {
          matchedEmployees.push({ value: name, label: name });
        }
      });

      filteredEmployees = matchedEmployees.length >= 1 ? matchedEmployees : (cachedCatalogs.empleados || []);
    }

    // Populate options
    let empOptions = `<option value="">Seleccionar Empleado...</option>`;
    filteredEmployees.forEach(opt => {
      if (!opt) return;
      const optVal = opt.value || "";
      const optLabel = opt.label || opt.value || "";
      const isSelected = optVal === currentValue;
      empOptions += `<option value="${optVal}" ${isSelected ? "selected" : ""}>${optLabel}</option>`;
    });
    empSelect.innerHTML = empOptions;

    if (empSelect.rebuildSearchable) {
      empSelect.rebuildSearchable();
    }
  } catch (err) {
    console.error("Error updating bulk employee dropdown:", err);
  }
}

async function submitBulkOrders() {
  const timeStartEl = document.getElementById('bulk-time-start');
  const timeEndEl = document.getElementById('bulk-time-end');
  const clasificacionEl = document.getElementById('bulk-clasificacion');
  const incidenteEl = document.getElementById('bulk-incidente');

  // Diagnostic logging
  console.log('[Bulk] submitBulkOrders iniciado');
  console.log('[Bulk] Catálogo rodados:', cachedCatalogs.rodados.length, 'items');
  
  const selectedChks = document.querySelectorAll('#bulk-vehicle-list input[type="checkbox"]:checked');
  console.log('[Bulk] Vehículos seleccionados:', selectedChks.length);
  console.log('[Bulk] Clasificación:', clasificacionEl?.value);
  console.log('[Bulk] Hora inicio:', timeStartEl?.value, '| Hora fin:', timeEndEl?.value);
  
  if (selectedChks.length === 0) {
    return showToast("Selecciona al menos un vehículo.", "danger");
  }

  if (!clasificacionEl.value) {
    return showToast("Selecciona una Clasificación para las órdenes.", "danger");
  }

  const taskCards = document.querySelectorAll('#bulk-tasks-container .bulk-task-item-card');
  if (taskCards.length === 0) {
    return showToast("Agrega al menos una tarea a realizar.", "danger");
  }

  if (!timeStartEl.value || !timeEndEl.value) {
    return showToast("Ingresa las horas de inicio y fin.", "danger");
  }

  const [startH, startM] = timeStartEl.value.split(':').map(Number);
  const [endH, endM] = timeEndEl.value.split(':').map(Number);
  let startMinutes = startH * 60 + startM;
  let endMinutes = endH * 60 + endM;
  if (endMinutes < startMinutes) {
    endMinutes += 24 * 60;
  }
  const totalMinutes = endMinutes - startMinutes;
  const minutesPerVehicle = totalMinutes / selectedChks.length;
  const hoursPerVehicleFormatted = formatMinutesToHMM(minutesPerVehicle);

  // Validate tasks first
  const tasksPayload = [];
  for (let tIdx = 0; tIdx < taskCards.length; tIdx++) {
    const card = taskCards[tIdx];
    const ccSelect = card.querySelector('.bulk-task-cc');
    const empSelect = card.querySelector('.bulk-task-emp');
    const descInput = card.querySelector('.bulk-task-desc');

    if (!ccSelect.value) {
      return showToast(`Selecciona Centro de Costo en Tarea #${tIdx + 1}.`, "danger");
    }
    if (!empSelect.value) {
      return showToast(`Selecciona Operario en Tarea #${tIdx + 1}.`, "danger");
    }
    if (!descInput.value.trim()) {
      return showToast(`Ingresa descripción en Tarea #${tIdx + 1}.`, "danger");
    }

    tasksPayload.push({
      centroCosto: ccSelect.value,
      empleado: empSelect.value,
      horasEstimadas: hoursPerVehicleFormatted,
      descripcion: descInput.value.trim(),
      status: "Finalizada",
      timerStart: null
    });
  }

  const confirmMsg = `¿Estás seguro de generar ${selectedChks.length} órdenes de trabajo?\nDuración por unidad: ${hoursPerVehicleFormatted} horas.`;
  if (!confirm(confirmMsg)) return;

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const fechaEntrega = `${yyyy}-${mm}-${dd}`;
  
  const hh = String(today.getHours()).padStart(2, '0');
  const min = String(today.getMinutes()).padStart(2, '0');
  const horario = `${hh}:${min}`;

  showToast(`Iniciando creación de ${selectedChks.length} órdenes...`, "warning");

  const ordersList = [];

  for (let i = 0; i < selectedChks.length; i++) {
    const chk = selectedChks[i];
    const rodadoId = String(chk.value);
    // Compare as strings to avoid type mismatch ("1" vs 1)
    const rodadoOpt = cachedCatalogs.rodados.find(r => String(r.value) === rodadoId);
    if (!rodadoOpt) {
      console.warn(`[Bulk] No se encontró rodado con value="${rodadoId}" en catálogo.`);
      continue;
    }

    const interno = String(rodadoOpt.interno || '').trim();
    
    // Read insumos for this specific vehicle
    const row = document.getElementById(`bulk-row-${interno}`);
    const insumosParts = [];
    if (row) {
      const inputs = row.querySelectorAll('.bulk-insumo-val');
      inputs.forEach(input => {
        const insumoType = input.dataset.insumo;
        const val = input.value.trim();
        if (val) {
          if (insumoType === 'refrigerante') insumosParts.push(`Refrigerante: ${val}L`);
          else if (insumoType === 'aceite_motor') insumosParts.push(`Aceite Motor: ${val}L`);
          else if (insumoType === 'grasa_caja') insumosParts.push(`Grasa Caja: ${val}L`);
          else if (insumoType === 'grasa_diferencial') insumosParts.push(`Grasa Diferencial: ${val}L`);
          else if (insumoType === 'hco_direccion') insumosParts.push(`Hco Dirección: ${val}L`);
          else if (insumoType === 'otros') insumosParts.push(`Otros: ${val}`);
        }
      });
    }

    // Clone tasksPayload so we can modify description independently for each vehicle
    const vehicleTasks = tasksPayload.map((t, idx) => {
      let desc = t.descripcion;
      // Append insumos only to the first task
      if (idx === 0 && insumosParts.length > 0) {
        desc += `\n[Insumos: ${insumosParts.join(', ')}]`;
      }
      return {
        ...t,
        descripcion: desc
      };
    });

    ordersList.push({
      rodado: rodadoOpt.label,
      responsable: "AUTO",
      interno: rodadoOpt.interno || "",
      clasificacion: clasificacionEl.value,
      fechaEntrega: fechaEntrega,
      horario: horario,
      incidente: incidenteEl.value.trim(),
      tasks: vehicleTasks,
      estadoUnidad: "operativo"
    });
  }

  if (ordersList.length === 0) {
    return showToast("No se pudo preparar ninguna orden. Verifique que los vehículos estén en el catálogo.", "danger");
  }

  try {
    const currentUsername = localStorage.getItem('currentUserUsername') || '';
    const res = await fetch('/api/orders/bulk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-username': currentUsername
      },
      body: JSON.stringify({ orders: ordersList })
    });

    if (res.ok) {
      showToast(`Éxito: Se crearon ${ordersList.length} órdenes correctamente.`, "success");
      toggleAllBulkVehicles(false);
      document.getElementById('bulk-incidente').value = '';
      
      // Clear tasks and add one default
      const container = document.getElementById('bulk-tasks-container');
      if (container) {
        container.innerHTML = '';
        activePreventivoTypes = new Set();
        syncPreventivoButtons();
        addBulkTaskField();
      }
      fetchOrders();
      switchView('orders');
    } else {
      let errMsg = "Error al crear órdenes";
      try {
        const errData = await res.json();
        if (errData && errData.error) errMsg = errData.error;
      } catch (_) {}
      showToast(errMsg, "danger");
    }
  } catch (e) {
    showToast("Error de conexión al enviar órdenes", "danger");
    console.error("Error creating bulk orders", e);
  }
}

// --- GOMERIA (CAMBIO DE CUBIERTAS) ---
// Digitizes the paper "Planilla Rodados" tire-change log: for one or several internos, log
// which tire (N° Fuego/Tipo/Marca/Medida/Estado) came out and which went in, then generate one
// order per interno with a task carrying that formatted description - same order/task pipeline
// as everything else in the app (syncs to Taxes normally), no separate data store for now.

// Gomería tasks always sit on Centro de Costo "Mecánica" (15) - same name-matching approach
// updateEmployeeDropdownForCard already uses to filter Mecánica-only employees for a task,
// simplified here since there's no Herrería/Edilicio branch to consider.
function getGomeriaMecanicaEmployees() {
  const cleanName = (str) => {
    if (typeof str !== 'string') return '';
    return str.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
  };
  const mecanicaNames = getSectorEmployees('Taller');
  const mecanicaNamesCleaned = new Set(mecanicaNames.map(cleanName));
  const matched = (cachedCatalogs.empleados || []).filter(emp => {
    if (!emp || !emp.label) return false;
    const empCleaned = cleanName(emp.label);
    if (mecanicaNamesCleaned.has(empCleaned)) return true;
    for (const mName of mecanicaNamesCleaned) {
      if (empCleaned.includes(mName) || mName.includes(empCleaned)) return true;
    }
    return false;
  });
  mecanicaNames.forEach(name => {
    const exists = matched.some(emp => emp && emp.label && cleanName(emp.label) === cleanName(name));
    if (!exists) matched.push({ value: name, label: name });
  });
  return matched;
}

function addGomeriaInternoBlock() {
  const container = document.getElementById('gomeria-internos-container');
  if (!container) return;
  const internoOptionsHtml = (cachedInternoOptions || [])
    .map(opt => `<option value="${opt.value}">${opt.label}</option>`).join('');

  const block = document.createElement('div');
  block.className = 'form-section-card gomeria-interno-block';
  block.innerHTML = `
    <div class="card-title-header split">
      <div class="flex-align">
        <span class="material-icons">local_shipping</span>
        <h3>Interno</h3>
      </div>
      <button type="button" class="btn btn-link btn-xs" onclick="removeGomeriaInternoBlock(this)" style="color:var(--danger);" title="Quitar este interno">
        <span class="material-icons" style="font-size:18px;">delete</span>
      </button>
    </div>
    <div style="display:grid; grid-template-columns: 2fr 1fr; gap:12px;">
      <div class="form-group">
        <label>Interno *</label>
        <select class="gomeria-interno-select" style="width:100%;">
          <option value="">Seleccionar Interno...</option>
          ${internoOptionsHtml}
        </select>
      </div>
      <div class="form-group">
        <label>Clasificación *</label>
        <select class="gomeria-clasificacion-select" style="width:100%;">
          <option value="Correctivo">Correctivo</option>
          <option value="Auxilio">Auxilio</option>
        </select>
      </div>
    </div>
    <div style="display:grid; grid-template-columns: 2fr 1fr; gap:12px;">
      <div class="form-group">
        <label>Empleado *</label>
        <select class="gomeria-empleado-select" style="width:100%;">
          <option value="">Seleccionar Empleado...</option>
          ${getGomeriaMecanicaEmployees().map(e => `<option value="${e.value}">${e.label}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Tiempo (horas)</label>
        <input type="number" step="0.1" min="0" class="gomeria-horas-input" placeholder="ej: 0.5" style="width:100%;">
      </div>
    </div>
    <div class="gomeria-tire-rows-container"></div>
    <button type="button" class="btn btn-secondary btn-xs" onclick="addGomeriaTireRow(this)" style="margin-top:10px; display:flex; align-items:center; gap:4px;">
      <span class="material-icons" style="font-size:14px;">add</span> Agregar Cubierta Cambiada
    </button>
  `;
  container.appendChild(block);
  addGomeriaTireRow(block.querySelector('.btn-secondary'));
  const internoSelectEl = block.querySelector('.gomeria-interno-select');
  if (internoSelectEl && typeof convertSelectToSearchable === 'function') {
    convertSelectToSearchable(internoSelectEl);
  }
  const empleadoSelectEl = block.querySelector('.gomeria-empleado-select');
  if (empleadoSelectEl && typeof convertSelectToSearchable === 'function') {
    convertSelectToSearchable(empleadoSelectEl);
  }
}

function removeGomeriaInternoBlock(btn) {
  const block = btn.closest('.gomeria-interno-block');
  if (block) block.remove();
}

function addGomeriaTireRow(btn) {
  const block = btn.closest('.gomeria-interno-block');
  const rowsContainer = block ? block.querySelector('.gomeria-tire-rows-container') : null;
  if (!rowsContainer) return;

  const row = document.createElement('div');
  row.className = 'gomeria-tire-row';
  row.style.cssText = 'border:1px solid var(--border-color); border-radius:8px; padding:12px; margin-top:10px; position:relative;';
  row.innerHTML = `
    <button type="button" onclick="removeGomeriaTireRow(this)" style="position:absolute; top:6px; right:6px; border:none; background:none; color:var(--danger); cursor:pointer; padding:2px;" title="Quitar esta cubierta">
      <span class="material-icons" style="font-size:16px;">close</span>
    </button>
    <div class="form-group" style="margin-bottom:10px;">
      <label style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; display:block; margin-bottom:6px;">Eje / Posición</label>
      <select class="gomeria-posicion-select" style="width:100%; margin-bottom:6px;" onchange="ptGomeriaUpdatePosicionBadge(this)">
        <option value="" data-group="">Seleccionar posición...</option>
        <optgroup label="Eje Delantero">
          <option value="Delantero izquierdo" data-group="delantero" style="background-color:#dcfce7; color:#166534;">Delantero izquierdo</option>
          <option value="Delantero derecho" data-group="delantero" style="background-color:#dcfce7; color:#166534;">Delantero derecho</option>
        </optgroup>
        <optgroup label="Eje Trasero (Tracción - Diferencial)">
          <option value="Trasero izquierdo exterior" data-group="trasero" style="background-color:#dbeafe; color:#1e40af;">Trasero izquierdo exterior</option>
          <option value="Trasero izquierdo interior" data-group="trasero" style="background-color:#dbeafe; color:#1e40af;">Trasero izquierdo interior</option>
          <option value="Trasero derecho exterior" data-group="trasero" style="background-color:#dbeafe; color:#1e40af;">Trasero derecho exterior</option>
          <option value="Trasero derecho interior" data-group="trasero" style="background-color:#dbeafe; color:#1e40af;">Trasero derecho interior</option>
        </optgroup>
        <optgroup label="Eje Fijo / Flotante">
          <option value="Eje fijo/flotante izquierdo exterior" data-group="fijoflotante" style="background-color:#ede9fe; color:#5b21b6;">Eje fijo/flotante izquierdo exterior</option>
          <option value="Eje fijo/flotante izquierdo interior" data-group="fijoflotante" style="background-color:#ede9fe; color:#5b21b6;">Eje fijo/flotante izquierdo interior</option>
          <option value="Eje fijo/flotante derecho exterior" data-group="fijoflotante" style="background-color:#ede9fe; color:#5b21b6;">Eje fijo/flotante derecho exterior</option>
          <option value="Eje fijo/flotante derecho interior" data-group="fijoflotante" style="background-color:#ede9fe; color:#5b21b6;">Eje fijo/flotante derecho interior</option>
        </optgroup>
        <option value="Auxilio / Repuesto" data-group="otro">Auxilio / Repuesto</option>
        <option value="__otro__" data-group="otro">Otro (escribir)</option>
      </select>
      <span class="gomeria-posicion-badge" style="display:none; font-size:12px; font-weight:700; padding:4px 12px; border-radius:999px;"></span>
      <input type="text" class="gomeria-posicion-otro" placeholder="Escribir posición" style="width:100%; margin-top:6px; display:none;">
    </div>
    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
      <div>
        <label style="font-size:11px; font-weight:700; color:var(--danger); text-transform:uppercase; display:block; margin-bottom:6px;">Se sacó</label>
        <input type="text" class="gomeria-salida-fuego" placeholder="N° Fuego" style="width:100%; margin-bottom:6px;">
        <input type="text" class="gomeria-salida-tipo" placeholder="Tipo (ej: Lineal)" style="width:100%; margin-bottom:6px;">
        <input type="text" class="gomeria-salida-marca" placeholder="Marca" style="width:100%; margin-bottom:6px;">
        <input type="text" class="gomeria-salida-medida" placeholder="Medida (ej: 275)" style="width:100%; margin-bottom:6px;">
        <input type="text" class="gomeria-salida-estado" placeholder="Estado (pinchada, liza...)" style="width:100%;">
      </div>
      <div>
        <label style="font-size:11px; font-weight:700; color:var(--success); text-transform:uppercase; display:block; margin-bottom:6px;">Se colocó</label>
        <input type="text" class="gomeria-entrada-fuego" placeholder="N° Fuego" style="width:100%; margin-bottom:6px;">
        <input type="text" class="gomeria-entrada-tipo" placeholder="Tipo (ej: Lineal)" style="width:100%; margin-bottom:6px;">
        <input type="text" class="gomeria-entrada-marca" placeholder="Marca" style="width:100%; margin-bottom:6px;">
        <input type="text" class="gomeria-entrada-medida" placeholder="Medida (ej: 275)" style="width:100%; margin-bottom:6px;">
        <input type="text" class="gomeria-entrada-estado" placeholder="Estado (recapada nueva...)" style="width:100%;">
      </div>
    </div>
  `;
  rowsContainer.appendChild(row);
}

function removeGomeriaTireRow(btn) {
  const row = btn.closest('.gomeria-tire-row');
  if (!row) return;
  const rowsContainer = row.parentElement;
  if (rowsContainer.querySelectorAll('.gomeria-tire-row').length <= 1) {
    showToast('Cada interno necesita al menos una cubierta cargada.', 'warning');
    return;
  }
  row.remove();
}

// Native <option> elements can't reliably be colored (especially on mobile, where the OS
// renders its own picker UI and ignores most CSS) - a small colored dot next to the select,
// driven by each option's own data-group, is what actually renders the axle color reliably.
// Matches the same colors set inline on each <option> above - those only actually render on
// desktop browsers (Chrome/Firefox partly honor styled options), never on mobile, where the OS
// draws its own picker UI and ignores them entirely. This badge is the one indicator that's
// guaranteed to show the axle color everywhere, including on a phone.
const GOMERIA_POSICION_GROUP_COLORS = {
  delantero: { bg: '#dcfce7', text: '#166534' },
  trasero: { bg: '#dbeafe', text: '#1e40af' },
  fijoflotante: { bg: '#ede9fe', text: '#5b21b6' },
  otro: { bg: 'var(--secondary-light)', text: 'var(--text-muted)' },
  '': { bg: 'var(--secondary-light)', text: 'var(--text-muted)' }
};

function ptGomeriaUpdatePosicionBadge(selectEl) {
  const wrapper = selectEl.closest('.form-group');
  const badge = wrapper ? wrapper.querySelector('.gomeria-posicion-badge') : null;
  const otroInput = wrapper ? wrapper.querySelector('.gomeria-posicion-otro') : null;
  const selectedOption = selectEl.selectedOptions && selectEl.selectedOptions[0];
  const group = selectedOption ? (selectedOption.dataset.group || '') : '';
  if (badge) {
    if (selectEl.value) {
      const colors = GOMERIA_POSICION_GROUP_COLORS[group] || GOMERIA_POSICION_GROUP_COLORS[''];
      badge.style.background = colors.bg;
      badge.style.color = colors.text;
      badge.textContent = selectedOption ? selectedOption.textContent : '';
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
  if (otroInput) otroInput.style.display = (selectEl.value === '__otro__') ? 'block' : 'none';
}

// Builds the task description text for one interno block, one line per tire changed, matching
// the paper form's own wording ("se sacó ... = se colocó = ...").
function buildGomeriaDescription(block) {
  const rows = Array.from(block.querySelectorAll('.gomeria-tire-row'));
  const field = (row, cls) => {
    const el = row.querySelector(`.${cls}`);
    return el ? el.value.trim() : '';
  };
  const lines = rows.map((row, idx) => {
    const posSelect = row.querySelector('.gomeria-posicion-select');
    const posOtro = row.querySelector('.gomeria-posicion-otro');
    const posicion = (posSelect && posSelect.value === '__otro__')
      ? (posOtro ? posOtro.value.trim() : '')
      : (posSelect ? posSelect.value : '');
    const sFuego = field(row, 'gomeria-salida-fuego');
    const sTipo = field(row, 'gomeria-salida-tipo');
    const sMarca = field(row, 'gomeria-salida-marca');
    const sMedida = field(row, 'gomeria-salida-medida');
    const sEstado = field(row, 'gomeria-salida-estado');
    const eFuego = field(row, 'gomeria-entrada-fuego');
    const eTipo = field(row, 'gomeria-entrada-tipo');
    const eMarca = field(row, 'gomeria-entrada-marca');
    const eMedida = field(row, 'gomeria-entrada-medida');
    const eEstado = field(row, 'gomeria-entrada-estado');
    if (!sFuego && !eFuego) return null;
    const prefix = rows.length > 1 ? `Cambio cubierta ${idx + 1}` : 'Cambio cubierta';
    const posSuffix = posicion ? ` (${posicion})` : '';
    return `${prefix}${posSuffix}: se sacó N° Fuego ${sFuego || '-'} - Tipo ${sTipo || '-'} - Marca ${sMarca || '-'} - Medida ${sMedida || '-'} - Estado ${sEstado || '-'} = se colocó = N° Fuego ${eFuego || '-'} - Tipo ${eTipo || '-'} - Marca ${eMarca || '-'} - Medida ${eMedida || '-'} - Estado ${eEstado || '-'}`;
  }).filter(Boolean);
  return lines.join('\n');
}

async function submitGomeriaOrders() {
  const blocks = Array.from(document.querySelectorAll('.gomeria-interno-block'));
  if (blocks.length === 0) {
    showToast('Agregá al menos un interno.', 'danger');
    return;
  }

  const ordersPayload = [];
  for (const block of blocks) {
    const selectEl = block.querySelector('.gomeria-interno-select');
    const interno = selectEl ? selectEl.value.trim() : '';
    if (!interno) {
      showToast('Todos los internos agregados deben estar seleccionados.', 'danger');
      return;
    }
    const descripcion = buildGomeriaDescription(block);
    if (!descripcion) {
      showToast(`Cargá al menos un N° de fuego para el interno ${interno}.`, 'danger');
      return;
    }
    const rodadoOpt = cachedCatalogs.rodados
      ? cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === interno)
      : null;
    const rodadoLabel = rodadoOpt ? rodadoOpt.label : `Interno ${interno}`;
    const clasifSelect = block.querySelector('.gomeria-clasificacion-select');
    const clasificacion = clasifSelect ? clasifSelect.value : 'Correctivo';
    const empSelect = block.querySelector('.gomeria-empleado-select');
    const empleado = empSelect ? empSelect.value : '';
    if (!empleado) {
      showToast(`Elegí quién hizo el cambio de cubiertas para el interno ${interno}.`, 'danger');
      return;
    }
    const horasInput = block.querySelector('.gomeria-horas-input');
    const horasEstimadas = (horasInput && horasInput.value.trim()) ? parseFloat(horasInput.value.replace(',', '.')) || 0 : 0;

    ordersPayload.push({
      rodado: rodadoLabel,
      responsable: "AUTO",
      interno: interno,
      clasificacion: clasificacion,
      fechaEntrega: new Date().toISOString().split('T')[0],
      horario: new Date().toTimeString().slice(0, 5),
      incidente: "Cambio de cubiertas",
      estadoUnidad: "operativo",
      tasks: [{
        centroCosto: "15",
        empleado: empleado,
        horasEstimadas: horasEstimadas,
        descripcion: descripcion,
        // Gomería logs a tire change that's already done by the time it's entered here -
        // unlike other order-creation flows, there's no reason to leave it Pendiente first.
        // Marking it Finalizada up front is what lets the order sync as complete in Taxes.
        status: "Finalizada"
      }]
    });
  }

  try {
    const currentUsername = localStorage.getItem('currentUserUsername') || '';
    const res = await fetch('/api/orders/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-username': currentUsername },
      body: JSON.stringify({ orders: ordersPayload })
    });
    if (!res.ok) {
      let errMsg = 'Error al generar las órdenes.';
      try { const errData = await res.json(); if (errData && errData.error) errMsg = errData.error; } catch (_) {}
      throw new Error(errMsg);
    }
    showToast(`✅ ${ordersPayload.length} orden(es) de cambio de cubiertas generada(s)`, 'success');
    const container = document.getElementById('gomeria-internos-container');
    if (container) {
      container.innerHTML = '';
      addGomeriaInternoBlock();
    }
    fetchOrders();
    switchView('orders');
  } catch (err) {
    showToast(err.message, 'danger');
    console.error('Error creating gomeria orders', err);
  }
}

// --- GOOGLE SHEETS NOVELTIES INTEGRATION ---
async function fetchNovelties() {
  try {
    const res = await fetch('/api/novelties');
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }
    cachedNovelties = await res.json();
    console.log(`Loaded ${cachedNovelties.length} novelties.`);
    // If there is already an interno value (e.g. when editing), show it immediately
    const internoInput = document.getElementById('form-interno');
    if (internoInput && internoInput.value) {
      showNoveltiesForInterno(internoInput.value.trim());
    }
  } catch (error) {
    console.error("Error fetching novelties:", error);
  }
}

function showNoveltiesForInterno(interno) {
  const sidebar = document.getElementById('modal-novelties-side');
  const listContainer = document.getElementById('modal-novelties-list');
  if (!sidebar || !listContainer) return;

  const modal = document.getElementById('new-order-modal');
  if (modal && modal.classList.contains('readonly-mode')) {
    sidebar.style.display = 'none';
    listContainer.innerHTML = '';
    return;
  }

  if (!interno) {
    sidebar.style.display = 'none';
    listContainer.innerHTML = '';
    return;
  }

  const matches = cachedNovelties.filter(n => {
    if (n.interno.toLowerCase().trim() !== interno.toLowerCase().trim()) {
      return false;
    }

    // Check if there is already a completed task for this novelty
    const desc = [n.rubro, n.subrubro, n.observacion].filter(Boolean).join(' - ').toLowerCase().trim();

    const isCompleted = activeOrders.some(order => {
      const orderInterno = (order.interno || '').toLowerCase().trim();
      const matchInterno = orderInterno === interno.toLowerCase().trim();
      if (!matchInterno) return false;

      return (order.tasks || []).some(task => {
        const taskDesc = (task.descripcion || '').toLowerCase().trim();
        const taskCompleted = task.status === 'Finalizada';
        return taskCompleted && taskDesc === desc;
      });
    });

    return !isCompleted;
  });

  const pendingServiceEntries = getPendingServiceEntriesForInterno(interno);

  if (matches.length === 0 && pendingServiceEntries.length === 0) {
    sidebar.style.display = 'none';
    listContainer.innerHTML = '';
    return;
  }

  sidebar.style.display = 'block';
  listContainer.innerHTML = '';

  matches.forEach(n => {
    const card = document.createElement('div');
    card.className = 'novelty-item';

    // Set custom rubro attribute for badge coloring in CSS
    const rubroLower = (n.rubro || '').toLowerCase().trim();
    card.setAttribute('data-rubro', rubroLower);

    const rubroText = n.rubro || 'Novedad';
    const subrubroText = n.subrubro || '';
    const obsText = n.observacion || '';
    const mecanicoText = n.mecanico || '';
    const supervisorText = n.supervisor || '';

    card.innerHTML = `
      <span class="novelty-badge">${escapeHtml(rubroText)}</span>
      ${subrubroText ? `<span class="novelty-title">${escapeHtml(subrubroText)}</span>` : ''}
      ${obsText ? `<span class="novelty-desc">${escapeHtml(obsText)}</span>` : ''}
      ${(mecanicoText || supervisorText) ? `
        <div class="novelty-meta" style="font-size: 10px; color: var(--text-muted); margin-top: 4px; border-top: 1px dashed var(--border-color); padding-top: 4px; width: 100%;">
          ${mecanicoText ? `<div><strong>Mecánico:</strong> ${escapeHtml(mecanicoText)}</div>` : ''}
          ${supervisorText ? `<div><strong>Supervisor:</strong> ${escapeHtml(supervisorText)}</div>` : ''}
        </div>
      ` : ''}
      <div class="novelty-action">
        <span class="material-icons" style="font-size:12px;">add_circle_outline</span>
        <span>Crear tarea</span>
      </div>
    `;

    card.addEventListener('click', () => {
      handleNoveltyClick(n);
    });

    listContainer.appendChild(card);
  });

  const ptOriginColors = {
    transito: '#0288d1',
    servicios_pendientes: '#2196f3',
    reparacion: '#f59e0b',
    fuera_de_servicio: '#ef4444'
  };

  pendingServiceEntries.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'novelty-item';

    const badgeColor = ptOriginColors[entry.origen] || '#64748b';
    const badgeText = entry.origenLabel || 'Servicio pendiente';

    card.innerHTML = `
      <span class="novelty-badge" style="background-color:${badgeColor};">${escapeHtml(badgeText)}</span>
      <span class="novelty-desc">${escapeHtml(entry.texto)}</span>
      <div class="novelty-action">
        <span class="material-icons" style="font-size:12px;">add_circle_outline</span>
        <span>Crear tarea</span>
      </div>
    `;

    card.addEventListener('click', () => {
      handlePendingServiceClick(entry);
    });

    listContainer.appendChild(card);
  });
}

// Pulls the pending checklist items registered in Parte Taller (servicios_pendientes)
// for a given interno, so they show up alongside the novelties sidebar in Nueva Orden.
const PT_LIST_LABELS = {
  transito: 'Tránsito',
  servicios_pendientes: 'Servicio Pendiente',
  reparacion: 'Reparación',
  fuera_de_servicio: 'Fuera de Servicio'
};

// Scans all four Parte Taller lists (not just servicios_pendientes) for the given
// interno, so a unit already in Reparación/Fuera de servicio/Tránsito still surfaces
// its pending checklist items when creating a new order for it.
function getPendingServiceEntriesForInterno(interno) {
  const cleanInterno = String(interno || '').trim().toLowerCase();
  if (!cleanInterno) return [];

  const state = window._ptState || {};
  const entries = [];
  const seenTexts = new Set();

  Object.keys(PT_LIST_LABELS).forEach(listName => {
    (state[listName] || [])
      .filter(item => String(item.interno || '').trim().toLowerCase() === cleanInterno)
      .forEach(item => {
        let pendingTexts = [];
        if (Array.isArray(item.novedad_items) && item.novedad_items.length > 0) {
          pendingTexts = item.novedad_items
            .filter(x => !x.hecho)
            .map(x => (x.texto || '').replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim())
            .filter(Boolean);
        } else if (item.novedad) {
          item.novedad.split('\n').forEach(line => {
            const l = line.trim();
            if (l && !l.startsWith('[X]') && !l.startsWith('[x]')) {
              const clean = l.replace(/^\[\s*\]\s*/, '').trim();
              if (clean) pendingTexts.push(clean);
            }
          });
        }
        pendingTexts.forEach(texto => {
          const tClean = texto.toUpperCase();
          if (!seenTexts.has(tClean)) {
            seenTexts.add(tClean);
            entries.push({ texto, tipo: item.tipo || '', origen: listName, origenLabel: PT_LIST_LABELS[listName] });
          }
        });
      });
  });

  return entries;
}

function handlePendingServiceClick(entry) {
  addTaskField({
    centroCosto: mapRubroToCentroCosto(entry.tipo),
    empleado: "",
    horasEstimadas: 0,
    status: "Pendiente",
    descripcion: entry.texto
  });

  showToast("Tarea creada a partir de servicio pendiente", "success");
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function mapRubroToCentroCosto(rubro) {
  if (!rubro) return "15"; // Default to MECANICA
  const rubroLower = rubro.toLowerCase().trim();
  if (rubroLower.includes("herre")) {
    return "11";
  }
  return "15";
}

function handleNoveltyClick(n) {
  // Format is RUBRO + subrubro + OBSERVACION
  const desc = [n.rubro, n.subrubro, n.observacion].filter(Boolean).join(' - ');
  const ccValue = mapRubroToCentroCosto(n.rubro);
  
  addTaskField({
    centroCosto: ccValue,
    empleado: "",
    horasEstimadas: 0,
    status: "Pendiente",
    descripcion: desc
  });
  
  showToast("Tarea creada a partir de novedad", "success");
}

// =============================================
// VOICE ORDER MODULE
// =============================================

let voiceRecognition = null;
let voiceIsListening = false;
let voiceParsedOrder = null; // { interno, clasificacion, tasks: [{empleadoName, descripcion}] }
let voiceFullTranscript = '';

function openVoiceModal() {
  resetVoiceState();
  document.getElementById('voice-modal').classList.add('open');
}

function closeVoiceModal() {
  stopVoiceListening();
  document.getElementById('voice-modal').classList.remove('open');
}

function resetVoiceState() {
  voiceParsedOrder = null;
  voiceFullTranscript = '';
  voiceIsListening = false;

  const ring = document.getElementById('voice-ring');
  const icon = document.getElementById('voice-ring-icon');
  const label = document.getElementById('voice-status-label');
  const transcript = document.getElementById('voice-transcript-text');
  const preview = document.getElementById('voice-parsed-preview');
  const btnIcon = document.getElementById('voice-btn-icon');
  const btnLabel = document.getElementById('voice-btn-label');
  const btn = document.getElementById('voice-listen-btn');
  const fab = document.getElementById('voice-fab');

  if (ring) ring.classList.remove('active');
  if (icon) { icon.textContent = 'mic_none'; }
  if (label) label.textContent = 'Presioná el botón para hablar';
  if (transcript) { transcript.textContent = '—'; transcript.style.color = ''; }
  if (preview) preview.style.display = 'none';
  if (btnIcon) btnIcon.textContent = 'mic';
  if (btnLabel) btnLabel.textContent = 'Escuchar';
  if (btn) btn.classList.remove('recording');
  if (fab) fab.classList.remove('listening');
}

function toggleVoiceListening() {
  if (voiceIsListening) {
    stopVoiceListening();
  } else {
    startVoiceListening();
  }
}

function startVoiceListening() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast('Tu navegador no soporta reconocimiento de voz. Usá Chrome.', 'warning');
    return;
  }

  // Reset previous transcript but keep parsed preview if there was one
  voiceFullTranscript = '';
  const transcriptEl = document.getElementById('voice-transcript-text');
  if (transcriptEl) { transcriptEl.textContent = 'Escuchando...'; transcriptEl.style.color = '#ef4444'; }

  voiceRecognition = new SpeechRecognition();
  voiceRecognition.lang = 'es-AR';
  voiceRecognition.continuous = true;
  voiceRecognition.interimResults = true;
  voiceRecognition.maxAlternatives = 1;

  voiceRecognition.onstart = () => {
    voiceIsListening = true;
    document.getElementById('voice-ring').classList.add('active');
    document.getElementById('voice-ring-icon').textContent = 'mic';
    document.getElementById('voice-status-label').textContent = 'Escuchando... hablá ahora';
    document.getElementById('voice-btn-icon').textContent = 'stop';
    document.getElementById('voice-btn-label').textContent = 'Detener';
    document.getElementById('voice-listen-btn').classList.add('recording');
    document.getElementById('voice-fab').classList.add('listening');
  };

  voiceRecognition.onresult = (event) => {
    let interim = '';
    let finalChunk = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalChunk += t + ' ';
      } else {
        interim += t;
      }
    }
    if (finalChunk) voiceFullTranscript += finalChunk;
    const display = (voiceFullTranscript + interim).trim();
    const transcriptEl = document.getElementById('voice-transcript-text');
    if (transcriptEl) {
      transcriptEl.textContent = display || 'Escuchando...';
      transcriptEl.style.color = display ? '' : '#ef4444';
    }

    // Parse in real time to show preview
    if (voiceFullTranscript.trim()) {
      const parsed = parseVoiceCommand(voiceFullTranscript.trim());
      showVoiceParsedPreview(parsed);
    }

    // Auto-stop on "enviar"
    const lower = (voiceFullTranscript + interim).toLowerCase();
    if (lower.includes('enviar') || lower.includes('envíar') || lower.includes('mandar') || lower.includes('grabar')) {
      stopVoiceListening(true);
    }
  };

  voiceRecognition.onerror = (event) => {
    console.error('[Voice] Error:', event.error);
    if (event.error === 'not-allowed') {
      showToast('Permiso de micrófono denegado. Habilitá el micrófono en tu navegador.', 'warning');
    } else if (event.error !== 'no-speech') {
      showToast('Error de micrófono: ' + event.error, 'warning');
    }
    stopVoiceListening(false);
  };

  voiceRecognition.onend = () => {
    // If stopped manually and there's content, process it
    if (!voiceIsListening && voiceFullTranscript.trim()) {
      processVoiceTranscript(voiceFullTranscript.trim());
    }
    voiceIsListening = false;
    document.getElementById('voice-ring').classList.remove('active');
    document.getElementById('voice-ring-icon').textContent = 'mic_none';
    document.getElementById('voice-status-label').textContent = 'Presioná el botón para hablar';
    document.getElementById('voice-btn-icon').textContent = 'mic';
    document.getElementById('voice-btn-label').textContent = 'Escuchar';
    document.getElementById('voice-listen-btn').classList.remove('recording');
    document.getElementById('voice-fab').classList.remove('listening');
  };

  voiceRecognition.start();
}

function stopVoiceListening(andProcess = true) {
  voiceIsListening = false;
  if (voiceRecognition) {
    try { voiceRecognition.stop(); } catch(e) {}
    voiceRecognition = null;
  }
  if (andProcess && voiceFullTranscript.trim()) {
    processVoiceTranscript(voiceFullTranscript.trim());
  }
}

/**
 * Parses a voice transcript into an order object.
 * Example: "crear orden interno 98 correctivo crear tarea a canaviri reparar frenos"
 */
function parseVoiceCommand(text) {
  const lower = text.toLowerCase()
    .replace(/á/g,'a').replace(/é/g,'e').replace(/í/g,'i').replace(/ó/g,'o').replace(/ú/g,'u')
    .replace(/ñ/g,'n');

  const result = {
    interno: null,
    clasificacion: null,
    tasks: []
  };

  // --- Extract interno ---
  // "interno 98", "el interno es 98", "unidad 98"
  const internoMatch = lower.match(/(?:interno|unidad)\s+([0-9a-z\-]+)/i);
  if (internoMatch) {
    result.interno = internoMatch[1].trim();
  }

  // --- Extract clasificacion ---
  if (lower.includes('correctivo') || lower.includes('corrector')) {
    result.clasificacion = 'Correctivo';
  } else if (lower.includes('preventivo') || lower.includes('preventivo')) {
    result.clasificacion = 'Preventivo';
  } else if (lower.includes('auxilio') || lower.includes('auxilo')) {
    result.clasificacion = 'Auxilio';
  } else if (lower.includes('herreria') || lower.includes('herrera')) {
    result.clasificacion = 'Herrería';
  }

  // --- Extract tasks ---
  // Pattern: "crear tarea a [nombre] [descripcion]" until next task or end/enviar
  // Split by common separators: dots, "crear tarea", "enviar"
  const taskKeywords = ['crear tarea a ', 'tarea a ', 'asignar tarea a ', 'asignar a '];

  // Find all positions of task keywords
  const taskSegments = [];
  let searchText = lower;
  let offset = 0;

  // Try to split by "crear tarea a" or "tarea a"
  // We'll use a regex to find all occurrences
  const taskPattern = /(?:crear\s+tarea\s+a|tarea\s+a|asignar(?:\s+tarea)?\s+a)\s+([a-z]+)\s+([^]+?)(?=(?:crear\s+tarea\s+a|tarea\s+a|asignar(?:\s+tarea)?\s+a)|enviar|mandar|grabar|$)/gi;
  let taskMatch;
  const normalizedLower = lower;
  
  while ((taskMatch = taskPattern.exec(normalizedLower)) !== null) {
    const employeeFragment = taskMatch[1].trim();
    const descFragment = taskMatch[2].trim()
      .replace(/\s*enviar\s*$/, '')
      .replace(/\s*mandar\s*$/, '')
      .replace(/\s*grabar\s*$/, '')
      .trim();
    
    // Resolve employee by partial name match
    const resolvedEmployee = resolveEmployeeByName(employeeFragment);
    
    if (descFragment) {
      taskSegments.push({
        empleadoName: resolvedEmployee ? resolvedEmployee.label : capitalizeFirst(employeeFragment),
        empleadoValue: resolvedEmployee ? resolvedEmployee.value : '',
        descripcion: capitalizeFirst(descFragment)
      });
    }
  }

  result.tasks = taskSegments;
  return result;
}

/**
 * Resolves an employee from cachedCatalogs.empleados using fuzzy name matching.
 * Searches by last name/first name fragment.
 */
function resolveEmployeeByName(fragment) {
  if (!fragment || !cachedCatalogs.empleados || cachedCatalogs.empleados.length === 0) return null;
  
  const frag = fragment.toLowerCase()
    .replace(/á/g,'a').replace(/é/g,'e').replace(/í/g,'i').replace(/ó/g,'o').replace(/ú/g,'u')
    .replace(/ñ/g,'n');

  // Try exact prefix match on last name (before comma)
  for (const emp of cachedCatalogs.empleados) {
    const labelNorm = emp.label.toLowerCase()
      .replace(/á/g,'a').replace(/é/g,'e').replace(/í/g,'i').replace(/ó/g,'o').replace(/ú/g,'u')
      .replace(/ñ/g,'n');
    if (labelNorm.startsWith(frag) || labelNorm.includes(', ' + frag) || labelNorm.includes(' ' + frag)) {
      return emp;
    }
  }

  // Fallback: any word includes frag
  for (const emp of cachedCatalogs.empleados) {
    const labelNorm = emp.label.toLowerCase()
      .replace(/á/g,'a').replace(/é/g,'e').replace(/í/g,'i').replace(/ó/g,'o').replace(/ú/g,'u')
      .replace(/ñ/g,'n');
    if (labelNorm.includes(frag)) {
      return emp;
    }
  }

  // Also try MECANICA_EMPLOYEES list
  for (const name of MECANICA_EMPLOYEES) {
    const normName = name.toLowerCase()
      .replace(/á/g,'a').replace(/é/g,'e').replace(/í/g,'i').replace(/ó/g,'o').replace(/ú/g,'u')
      .replace(/ñ/g,'n');
    if (normName.includes(frag) || normName.startsWith(frag)) {
      // Try to find in catalog
      const inCatalog = cachedCatalogs.empleados.find(e => e.label === name);
      if (inCatalog) return inCatalog;
    }
  }
  return null;
}

function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function showVoiceParsedPreview(parsed) {
  const preview = document.getElementById('voice-parsed-preview');
  if (!preview) return;

  const internoRow = document.getElementById('parsed-interno-row');
  const clasificacionRow = document.getElementById('parsed-clasificacion-row');
  const tasksRow = document.getElementById('parsed-tasks-row');

  let hasContent = false;

  if (parsed.interno) {
    document.getElementById('parsed-interno').textContent = parsed.interno;
    internoRow.style.display = 'flex';
    hasContent = true;
  } else {
    internoRow.style.display = 'none';
  }

  if (parsed.clasificacion) {
    document.getElementById('parsed-clasificacion').textContent = parsed.clasificacion;
    clasificacionRow.style.display = 'flex';
    hasContent = true;
  } else {
    clasificacionRow.style.display = 'none';
  }

  if (parsed.tasks && parsed.tasks.length > 0) {
    const tasksList = parsed.tasks.map(t => `${t.empleadoName}: ${t.descripcion}`).join(' | ');
    document.getElementById('parsed-tasks').textContent = tasksList;
    tasksRow.style.display = 'flex';
    hasContent = true;
  } else {
    tasksRow.style.display = 'none';
  }

  preview.style.display = hasContent ? 'flex' : 'none';
}

function processVoiceTranscript(text) {
  const parsed = parseVoiceCommand(text);
  voiceParsedOrder = parsed;
  showVoiceParsedPreview(parsed);

  // Validate minimum requirements
  if (!parsed.interno) {
    showToast('No se detectó el número de interno. Intentá de nuevo.', 'warning');
    const statusLabel = document.getElementById('voice-status-label');
    if (statusLabel) statusLabel.textContent = 'No se detectó el interno. Intentá de nuevo.';
    return;
  }

  // Show confirmation modal
  showVoiceConfirmModal(parsed, text);
}

function showVoiceConfirmModal(parsed, originalText) {
  const body = document.getElementById('voice-confirm-body');
  if (!body) return;

  const clasificacion = parsed.clasificacion || 'Correctivo';
  const interno = parsed.interno || '—';

  let html = `
    <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px; font-style: italic;">
      "${escapeHtml(originalText.substring(0, 120))}${originalText.length > 120 ? '...' : ''}"
    </p>
    <table class="voice-confirm-table">
      <tr>
        <th>Interno</th>
        <td><strong style="color: var(--primary); font-size: 16px;">${escapeHtml(interno)}</strong></td>
      </tr>
      <tr>
        <th>Clasificación</th>
        <td>${escapeHtml(clasificacion)}</td>
      </tr>
      <tr>
        <th>Rodado</th>
        <td style="color: var(--text-muted); font-size: 12px;">(se buscará automáticamente por interno)</td>
      </tr>
    </table>
  `;

  if (parsed.tasks && parsed.tasks.length > 0) {
    html += `
      <div class="voice-confirm-tasks">
        <p style="font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px;">
          TAREAS (${parsed.tasks.length})
        </p>
    `;
    parsed.tasks.forEach((t, i) => {
      html += `
        <div class="voice-confirm-task-item">
          <div class="task-emp-name">👷 ${escapeHtml(t.empleadoName)}</div>
          <div class="task-desc">${escapeHtml(t.descripcion)}</div>
          ${!t.empleadoValue ? '<div style="font-size: 11px; color: var(--warning); margin-top: 2px;">⚠️ Mecánico no encontrado en el sistema — se ingresará como texto</div>' : ''}
        </div>
      `;
    });
    html += `</div>`;
  } else {
    html += `<p style="color: var(--warning); font-size: 13px; margin-top: 10px;">⚠️ No se detectaron tareas. La orden se creará sin tareas.</p>`;
  }

  body.innerHTML = html;

  // Close voice modal and open confirm modal
  document.getElementById('voice-modal').classList.remove('open');
  document.getElementById('voice-confirm-modal').classList.add('open');
}

function closeVoiceConfirmModal() {
  document.getElementById('voice-confirm-modal').classList.remove('open');
  // Re-open voice modal so they can re-try or keep editing
  document.getElementById('voice-modal').classList.add('open');
}

async function confirmVoiceOrder() {
  if (!voiceParsedOrder) return;

  document.getElementById('voice-confirm-modal').classList.remove('open');
  document.getElementById('voice-modal').classList.remove('open');

  const { interno, clasificacion, tasks } = voiceParsedOrder;

  // Find rodado by interno
  let rodadoValue = '';
  let rodadoLabel = '';
  const internoNum = String(interno).trim();
  const rodadoOpt = cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === internoNum);
  if (rodadoOpt) {
    rodadoValue = rodadoOpt.value;
    rodadoLabel = rodadoOpt.label;
  }

  // Build tasks
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const hh = String(today.getHours()).padStart(2, '0');
  const min = String(today.getMinutes()).padStart(2, '0');

  const builtTasks = (tasks || []).map((t, idx) => ({
    id: `voice-${Date.now()}-${idx}`,
    centroCosto: '15', // default MECANICA
    empleado: t.empleadoValue || '',
    horasEstimadas: 0,
    descripcion: t.descripcion,
    status: 'Pendiente',
    timerStart: null
  }));

  const payload = {
    rodado: rodadoLabel || `Interno ${interno}`,
    responsable: 'AUTO',
    fechaEntrega: `${yyyy}-${mm}-${dd}`,
    horario: `${hh}:${min}`,
    interno: internoNum,
    clasificacion: clasificacion || 'Correctivo',
    incidente: '',
    tasks: builtTasks
  };

  try {
    showToast('Creando orden por voz...', 'info');
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-user-username': localStorage.getItem('currentUserUsername') || ''
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Error al crear la orden');
    }
    const newOrder = await res.json();
    showToast(`✅ Orden creada (Interno ${interno})`, 'success');
    fetchOrders();

    // Switch to orders view
    switchView('orders');
  } catch (err) {
    console.error('[Voice] Error creating order:', err);
    showToast('Error al crear la orden: ' + err.message, 'warning');
    // Re-open confirm modal so user can retry
    document.getElementById('voice-confirm-modal').classList.add('open');
  }
}

// --- AUTHENTICATION & MULTIUSER SESSION FUNCTIONS ---
function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const container = input.parentElement || input.closest('.form-group');
  const toggleIcon = container ? container.querySelector('.password-toggle') : input.nextElementSibling;
  
  if (input.type === 'password') {
    input.type = 'text';
    if (toggleIcon) toggleIcon.textContent = 'visibility';
  } else {
    input.type = 'password';
    if (toggleIcon) toggleIcon.textContent = 'visibility_off';
  }
}

// Utility to determine sector by username (client-side)
function getSectorByUsername(username) {
  if (!username) return 'Admin';
  const cleanUsername = String(username).split(',')[0].trim().toLowerCase();
  
  if (
    cleanUsername.includes('admin') ||
    cleanUsername.includes('belocures') ||
    cleanUsername.includes('taller') || 
    cleanUsername.includes('paniol') || 
    cleanUsername.includes('panol') || 
    cleanUsername.includes('pañol')
  ) {
    return 'Admin';
  }
  if (cleanUsername.includes('herrer') || cleanUsername.includes('carmona') || cleanUsername.includes('jcarmona')) return 'Herrería';
  if (cleanUsername.includes('toledo') || cleanUsername.includes('edilic')) return 'Edilicio';
  return 'Admin';
}

function updateClassificationSelectOptions() {
  const selects = [
    { id: 'bulk-clasificacion', defaultText: 'Seleccionar...' },
    { id: 'pre-form-clasificacion', defaultText: 'Seleccionar Clasificación...' },
    { id: 'form-clasificacion', defaultText: 'Seleccionar...' }
  ];

  selects.forEach(sel => {
    const el = document.getElementById(sel.id);
    if (!el) return;

    let html = '';
    const sector = currentSelectedSector;

    if (sector === 'Herrería') {
      html = `
        <option value="">${sel.defaultText}</option>
        <option value="Correctivo">Correctivo</option>
        <option value="Preventivo">Preventivo</option>
        <option value="Auxilio">Auxilio</option>
        <option value="Herrería" selected>Herrería</option>
      `;
    } else {
      // Taller / Admin / Edilicio - Taxes has no real "Edilicio" clasificacion value (only
      // Correctivo/Preventivo/Auxilio, plus Herrería which genuinely exists there). Edilicio
      // work is identified by the task's Centro de Costo, not by this field, so the Edilicio
      // tab offers the exact same real options as Taller.
      html = `
        <option value="" selected disabled>${sel.defaultText}</option>
        <option value="Preventivo">Preventivo</option>
        <option value="Auxilio">Auxilio</option>
        <option value="Correctivo">Correctivo</option>
      `;
      if (sel.id === 'pre-form-clasificacion') {
        html = `
          <option value="">${sel.defaultText}</option>
          <option value="Correctivo">Correctivo</option>
          <option value="Preventivo">Preventivo</option>
          <option value="Auxilio">Auxilio</option>
        `;
      }
    }
    el.innerHTML = html;
  });
}

// Mirrors server.js's isHerreriaExclusiveEquipment(): only the generic Herreria job
// "buckets" in the rodados catalog (fabricacion/reparacion de equipo sin vehiculo real
// asociado), identified by their Interno's "REP.", "FABRICACION"/"FINALIZACION" prefix or
// being exactly "PRENSAS" - not a loose substring match, which used to catch real fleet
// vehicles that happen to share a word (e.g. "VOLQUETE NICO", a real Taller dump truck).
function isHerreriaExclusiveEquipmentClient(rodado, interno) {
  const internoClean = String(interno || '').toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  if (internoClean === 'PRENSAS') return true;
  if (internoClean.startsWith('REP.') || internoClean.startsWith('REP ')) return true;
  if (internoClean.startsWith('FABRIC')) return true;
  if (internoClean.startsWith('FINALIZ')) return true;
  return false;
}


function isHerreriaOrder(order) {
  if (!order) return false;
  const cls = String(order.clasificacion || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const sec = String(order.sector || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  // Routing follows only clasificacion/sector/exclusive-equipment, matching the server's
  // /api/orders filter exactly - never who created the order or who a task is assigned to.
  // That used to pull whole Taller orders into Herreria just because one task's assignee
  // fuzzy-matched a Herreria name, hiding every other task in the order from Taller.
  if (cls.includes('herrer') || sec.includes('herrer')) return true;
  if (isHerreriaExclusiveEquipmentClient(order.rodado, order.interno)) return true;
  return false;
}

function isEdilicioOrder(order) {
  if (!order) return false;
  const cls = String(order.clasificacion || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const sec = String(order.sector || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  return cls.includes('edilic') || sec.includes('edilic');
}

window.switchSector = function(sector) {
  if (!sector) return;
  currentSelectedSector = sector;
  
  // Update UI active class on tab buttons
  const tabs = document.querySelectorAll('.sector-tab');
  tabs.forEach(tab => {
    const text = String(tab.textContent || '').trim();
    if (text.toLowerCase() === sector.toLowerCase()) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  // Re-render orders, dashboard, and stats according to the selected sector tab
  if (typeof renderOrders === 'function') renderOrders();
  if (typeof updateStats === 'function') updateStats();
  if (typeof setupAllFieldsForSector === 'function') setupAllFieldsForSector();
  if (typeof renderHistoryOrders === 'function') renderHistoryOrders();

  window.scrollTo({ top: 0, behavior: 'smooth' });
};

function getFilteredActiveOrders() {
  if (!activeOrders || !Array.isArray(activeOrders)) return [];

  let sectorFilter = currentSelectedSector || 'Taller';

  return activeOrders.filter(o => {
    if (o.status === 'Archivada' || o.status === 'Eliminada') return false;
    if (sectorFilter === 'Herrería') {
      return isHerreriaOrder(o);
    }
    if (sectorFilter === 'Edilicio') {
      return isEdilicioOrder(o);
    }
    // Taller tab: Includes all orders except explicit Herrería/Edilicio
    return !isHerreriaOrder(o) && !isEdilicioOrder(o);
  });
}

// Unlike getFilteredActiveOrders() (used by the Órdenes tab, which shows/hides whole orders),
// the Inicio dashboard renders one card per TASK and routes each card by that task's own
// centro de costo (see getTaskCentroCostoSector), never by the order's overall clasificacion.
// Orders can be legitimately shared across sectors (e.g. the generic "REPARACIONES INTERNAS"
// bucket), so this must hand every active order's tasks to that per-task filter rather than
// pre-excluding whole orders by sector - excluding here previously hid an entire shared order's
// Taller tasks from ever reaching the per-task filter on the Taller tab.
function getOrdersForDashboard() {
  if (!activeOrders || !Array.isArray(activeOrders)) return [];
  return activeOrders.filter(o => o.status !== 'Archivada' && o.status !== 'Eliminada');
}

function getFilteredArchivedOrders() {
  if (!archivedOrders || !Array.isArray(archivedOrders)) return [];

  let sectorFilter = currentSelectedSector || 'Taller';
  const query = (document.getElementById('history-orders-search')?.value || '').toLowerCase().trim();

  return archivedOrders.filter(o => {
    if (query && !String(o.interno || '').toLowerCase().includes(query)) return false;
    if (sectorFilter === 'Herrería') {
      return isHerreriaOrder(o);
    }
    if (sectorFilter === 'Edilicio') {
      return isEdilicioOrder(o);
    }
    // Taller tab: EXCLUDE all Herrería and Edilicio orders
    return !isHerreriaOrder(o) && !isEdilicioOrder(o);
  });
}

let currentUserPermissions = {
  canDelete: true,
  canSync: true,
  canViewHistory: true,
  canViewMasivas: true,
  canViewParteTaller: true,
  allowedSectors: ['Herrería', 'Edilicio', 'Taller']
};

async function loadUserPermissionsUI() {
  const currentUser = localStorage.getItem('currentUserUsername');
  const userSector = getSectorByUsername(currentUser);

  // Show all navigation tabs by default
  document.querySelectorAll('.nav-item').forEach(el => el.style.display = 'flex');
  const navHistorial = document.getElementById('nav-historial');
  if (navHistorial) navHistorial.style.display = 'flex';

  // Fetch this user's own saved permissions (from Ajustes > Autorizaciones de Usuarios) and
  // actually apply them - the checkboxes there were being saved but nothing ever read them
  // back to hide the corresponding nav tab, so toggling them off had no visible effect.
  try {
    const permsRes = await originalFetch('/api/my-permissions', {
      headers: { 'x-user-username': currentUser || '' }
    });
    if (permsRes.ok) {
      currentUserPermissions = await permsRes.json();
    }
  } catch (e) {
    console.error('Error loading user permissions:', e);
  }

  const navPermGates = [
    { id: 'nav-historial', flag: 'canViewHistory' },
    { id: 'nav-bulk', flag: 'canViewMasivas' },
    { id: 'nav-preventivos', flag: 'canViewPreventivos' },
    { id: 'nav-partetaller', flag: 'canViewParteTaller' },
    { id: 'nav-settings', flag: 'canViewSettings' }
  ];
  navPermGates.forEach(({ id, flag }) => {
    const el = document.getElementById(id);
    if (el && currentUserPermissions[flag] === false) {
      el.style.display = 'none';
    }
  });

  const sectorTabsBar = document.getElementById('sector-tabs-bar');
  if (sectorTabsBar) sectorTabsBar.style.display = 'flex';

  const tabs = document.querySelectorAll('.sector-tab');
  tabs.forEach(tab => {
    const text = String(tab.textContent || '').trim().toLowerCase();
    if (userSector === 'Admin') {
      // Admin ve todas las pestañas de sectores
      tab.style.display = 'inline-block';
    } else if (userSector === 'Herrería') {
      // Usuario de Herrería (ej: jcarmona) ve ÚNICAMENTE Herrería
      if (text.includes('herrer')) {
        tab.style.display = 'inline-block';
      } else {
        tab.style.display = 'none';
      }
    } else if (userSector === 'Edilicio') {
      // Usuario de Edilicio ve ÚNICAMENTE Edilicio
      if (text.includes('edilic')) {
        tab.style.display = 'inline-block';
      } else {
        tab.style.display = 'none';
      }
    } else {
      // Usuario de Taller ve ÚNICAMENTE Taller
      if (text.includes('taller')) {
        tab.style.display = 'inline-block';
      } else {
        tab.style.display = 'none';
      }
    }
  });

  if (userSector === 'Herrería' || userSector === 'Edilicio') {
    switchSector(userSector);
  } else if (userSector === 'Taller') {
    switchSector('Taller');
  }

  // "Autorizaciones de Usuarios" (Ajustes) is Pañol/Admin-only and starts hidden in the HTML -
  // nothing else ever un-hid it, so it was permanently unreachable regardless of who was
  // logged in. Show it only for Admin, and populate it right away instead of waiting for some
  // action inside it (create user / save permissions) to trigger the first render.
  const userAuthSection = document.getElementById('user-authorizations-section');
  if (userAuthSection) {
    if (userSector === 'Admin') {
      userAuthSection.style.display = 'block';
      renderUserAuthorizationsTable();
    } else {
      userAuthSection.style.display = 'none';
    }
  }
}

let currentBackupData = [];

// ── EMPLOYEE MAPPINGS (Pañol Settings) ─────────────────────────────────────────
let currentEmployeeMappings = { Taller: [], Herrería: [], Edilicio: [] };
let activeEmpMapTab = 'Taller';

const EMP_MAP_DEFAULTS = {
  Taller: [
    { appName: 'GODOY DAVID',            taxesName: 'Vera, Domingo Sergio' },
    { appName: 'DOMINIC DYLAN',          taxesName: 'Vera, Domingo Sergio' },
    { appName: 'PEREZ FACUNDO',          taxesName: 'Vera, Domingo Sergio' },
    { appName: 'LOPEZ GUSTAVO',          taxesName: 'Vera, Domingo Sergio' },
    { appName: 'CALOMINO DARIO',         taxesName: 'Vera, Domingo Sergio' },
    { appName: 'MUSDALINO FRANCO',       taxesName: 'Vera, Domingo Sergio' },
    { appName: 'RODRIGUEZ MARCELO',      taxesName: 'Vera, Domingo Sergio' },
    { appName: 'Cuba Orosco, Kevín Genaro', taxesName: 'Cuba Orosco, Kevín Genaro' }
  ],
  Herrería: [
    { appName: 'Federico', taxesName: 'García, Yamandú Liborio' },
    { appName: 'Luciano',  taxesName: 'Carmona González, Juan Manuel' },
    { appName: 'Digno',    taxesName: 'García, Yamandú Liborio' }
  ],
  Edilicio: []
};

function switchEmpMapTab(sector) {
  activeEmpMapTab = sector;
  // Update tab button styles
  document.querySelectorAll('.emp-map-tab-btn').forEach(btn => {
    btn.style.borderBottom = '2px solid transparent';
    btn.style.color = 'var(--text-muted)';
  });
  const sectorIdMap = { 'Taller': 'emp-tab-taller', 'Herrería': 'emp-tab-herreria', 'Edilicio': 'emp-tab-edilicio' };
  const activeBtn = document.getElementById(sectorIdMap[sector]);
  if (activeBtn) {
    activeBtn.style.borderBottom = '2px solid var(--primary)';
    activeBtn.style.color = 'var(--primary)';
  }
  // Show/hide panels
  ['Taller', 'Herrería', 'Edilicio'].forEach(s => {
    const panel = document.getElementById(`emp-map-table-${s}`);
    if (panel) panel.style.display = s === sector ? 'block' : 'none';
  });
}

function renderEmpMapRows(sector) {
  const container = document.getElementById(`emp-map-rows-${sector}`);
  if (!container) return;
  const rows = currentEmployeeMappings[sector] || [];
  if (rows.length === 0) {
    container.innerHTML = `<div style="color:var(--text-muted); font-size:12px; padding:8px 0; text-align:center;">Sin empleados configurados. Agregá uno con el botón de abajo.</div>`;
    return;
  }
  // Header row
  let html = `
    <div style="display:grid; grid-template-columns:1fr 1fr 36px; gap:8px; margin-bottom:6px; padding:0 2px;">
      <div style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:.5px;">Nombre en App</div>
      <div style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:.5px;">Nombre en Taxes</div>
      <div></div>
    </div>`;
  rows.forEach((row, i) => {
    const inTaxes = row.appName.trim().toLowerCase() === row.taxesName.trim().toLowerCase();
    html += `
      <div style="display:grid; grid-template-columns:1fr 1fr 36px; gap:8px; margin-bottom:7px; align-items:center;" id="emp-map-row-${sector}-${i}">
        <input type="text" value="${escapeHtml(row.appName)}" placeholder="Nombre en App..."
          style="padding:7px 9px; font-size:13px; border:1px solid var(--border-color); border-radius:6px; background:var(--bg-main); color:var(--text-main);"
          onchange="updateEmpMapRow('${sector}', ${i}, 'appName', this.value)">
        <div style="position:relative;">
          <input type="text" value="${escapeHtml(row.taxesName)}" placeholder="Nombre en Taxes..."
            style="padding:7px 9px; padding-left:${inTaxes ? '9px' : '28px'}; font-size:13px; border:1px solid ${inTaxes ? 'var(--success)' : 'var(--warning, #f59e0b)'}; border-radius:6px; background:var(--bg-main); color:var(--text-main); width:100%; box-sizing:border-box;"
            onchange="updateEmpMapRow('${sector}', ${i}, 'taxesName', this.value)">
          ${!inTaxes ? `<span title="Usa nombre proxy en Taxes" style="position:absolute;left:7px;top:50%;transform:translateY(-50%);font-size:14px;">🔀</span>` : `<span title="Nombre igual en Taxes" style="position:absolute;right:7px;top:50%;transform:translateY(-50%);font-size:14px; color:var(--success);">✓</span>`}
        </div>
        <button type="button" onclick="removeEmpMapRow('${sector}', ${i})"
          style="background:transparent; border:1px solid var(--danger); border-radius:6px; color:var(--danger); cursor:pointer; padding:4px; display:flex; align-items:center; justify-content:center; width:34px; height:34px;">
          <span class="material-icons" style="font-size:17px;">delete</span>
        </button>
      </div>`;
  });
  container.innerHTML = html;
}

function updateEmpMapRow(sector, index, field, value) {
  if (!currentEmployeeMappings[sector]) return;
  if (currentEmployeeMappings[sector][index]) {
    currentEmployeeMappings[sector][index][field] = value;
    // Re-render after a short delay to update the indicator icons
    setTimeout(() => renderEmpMapRows(sector), 50);
  }
}

function addEmployeeMappingRow(sector) {
  if (!currentEmployeeMappings[sector]) currentEmployeeMappings[sector] = [];
  currentEmployeeMappings[sector].push({ appName: '', taxesName: '' });
  renderEmpMapRows(sector);
}

function removeEmpMapRow(sector, index) {
  if (!currentEmployeeMappings[sector]) return;
  currentEmployeeMappings[sector].splice(index, 1);
  renderEmpMapRows(sector);
}

async function loadAndRenderEmployeeMappings() {
  try {
    const username = localStorage.getItem('currentUserUsername') || '';
    const res = await originalFetch('/api/settings', { headers: { 'x-user-username': username } });
    if (!res.ok) throw new Error('Error cargando ajustes');
    const data = await res.json();
    const saved = data.employeeMappings;
    if (saved && (saved.Taller || saved.Herrería || saved.Edilicio)) {
      currentEmployeeMappings = {
        Taller:    Array.isArray(saved.Taller)    ? saved.Taller    : EMP_MAP_DEFAULTS.Taller,
        Herrería:  Array.isArray(saved.Herrería)  ? saved.Herrería  : EMP_MAP_DEFAULTS.Herrería,
        Edilicio:  Array.isArray(saved.Edilicio)  ? saved.Edilicio  : EMP_MAP_DEFAULTS.Edilicio
      };
    } else {
      // First time: pre-load defaults
      currentEmployeeMappings = JSON.parse(JSON.stringify(EMP_MAP_DEFAULTS));
    }
  } catch (err) {
    console.warn('Could not load employee mappings, using defaults:', err.message);
    currentEmployeeMappings = JSON.parse(JSON.stringify(EMP_MAP_DEFAULTS));
  }
  ['Taller', 'Herrería', 'Edilicio'].forEach(s => renderEmpMapRows(s));
}

async function saveEmployeeMappings() {
  const username = localStorage.getItem('currentUserUsername') || '';
  const msgEl = document.getElementById('emp-map-save-msg');
  try {
    const res = await originalFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-username': username },
      body: JSON.stringify({ employeeMappings: currentEmployeeMappings })
    });
    if (!res.ok) throw new Error('Error al guardar');
    if (msgEl) {
      msgEl.textContent = '✓ Mapeo guardado correctamente';
      msgEl.style.color = 'var(--success)';
      msgEl.style.display = 'block';
      setTimeout(() => { msgEl.style.display = 'none'; }, 3500);
    }
    // Re-render to update visual indicators
    ['Taller', 'Herrería', 'Edilicio'].forEach(s => renderEmpMapRows(s));
  } catch (err) {
    if (msgEl) {
      msgEl.textContent = '✗ Error al guardar: ' + err.message;
      msgEl.style.color = 'var(--danger)';
      msgEl.style.display = 'block';
    }
  }
}
// ── END EMPLOYEE MAPPINGS ────────────────────────────────────────────────────────

async function renderBackupRecoveryTable() {
  const container = document.getElementById('backup-table-container');
  const backupSection = document.getElementById('backup-recovery-section');
  if (!container) return;

  const currentUsername = localStorage.getItem('currentUserUsername') || '';

  try {
    const res = await originalFetch('/api/backup/orders', {
      headers: { 'x-user-username': currentUsername }
    });

    if (!res.ok) {
      if (res.status === 403) {
        if (backupSection) backupSection.style.display = 'none';
        return;
      }
      throw new Error('Error al cargar respaldo');
    }

    if (backupSection) backupSection.style.display = 'block';
    currentBackupData = await res.json();

    filterBackupTable();
  } catch (err) {
    console.error('Error loading backup orders:', err);
    container.innerHTML = `<div class="empty-dashboard-state" style="color:var(--danger);">No se pudo cargar el respaldo de seguridad.</div>`;
  }
}

function filterBackupTable() {
  const container = document.getElementById('backup-table-container');
  if (!container) return;

  const query = (document.getElementById('backup-search-input')?.value || '').toLowerCase().trim();

  const filtered = currentBackupData.filter(o => {
    if (!query) return true;
    const intNo = String(o.interno || '').toLowerCase();
    const otNo = String(o.taxesOrderNumber || '').toLowerCase();
    const rodado = String(o.rodado || '').toLowerCase();
    const tasks = (o.tasks || []).map(t => `${t.descripcion} ${t.empleado}`).join(' ').toLowerCase();
    return intNo.includes(query) || otNo.includes(query) || rodado.includes(query) || tasks.includes(query);
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-dashboard-state">No hay órdenes registradas en el respaldo de los últimos 7 días.</div>`;
    return;
  }

  let html = `
    <table style="width:100%; border-collapse:collapse; font-size:12px; text-align:left;">
      <thead>
        <tr style="border-bottom:2px solid var(--border-color); color:var(--text-muted);">
          <th style="padding:8px;">Fecha / Creación</th>
          <th style="padding:8px;">Unidad / Interno</th>
          <th style="padding:8px;">O.T. Taxes</th>
          <th style="padding:8px;">Clasificación</th>
          <th style="padding:8px;">Tareas & Mecánicos (Timeline / Pausas)</th>
          <th style="padding:8px; text-align:center;">Estado</th>
          <th style="padding:8px; text-align:center;">Acción</th>
        </tr>
      </thead>
      <tbody>
  `;

  filtered.forEach(o => {
    const fecha = o.fechaEntrega || (o.createdAt ? o.createdAt.split('T')[0] : 'N/A');
    const createdStr = o.createdAt ? new Date(o.createdAt).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'N/A';
    const ot = o.taxesOrderNumber ? `<span class="badge badge-success" style="font-size:11px;">#${o.taxesOrderNumber}</span>` : `<span style="color:var(--text-muted); font-style:italic;">Pendiente</span>`;
    
    const tasksHtml = (o.tasks || []).map(t => {
      const pauses = (t.timerHistory || []).filter(h => h.type === 'Pausó' || h.type === 'Inició' || h.type === 'Reanudó' || h.type === 'Fin').map(h => `${h.type} ${h.formatted}`).join(' → ');
      const pausesBadge = pauses ? `<div style="font-size:10px; color:#64748b; margin-top:2px;">⏱️ ${pauses}</div>` : '';
      return `<div><b>${t.descripcion || 'Sin desc.'}</b> (${t.empleado || 'S/A'}) ${pausesBadge}</div>`;
    }).join('') || '<span style="color:var(--text-muted);">Sin tareas</span>';

    const isDeleted = o.deleted === true;
    const isArchived = o.archived === true;
    let statusBadge = `<span class="badge badge-primary">Activa</span>`;
    if (isDeleted) {
      statusBadge = `<span class="badge badge-danger" style="background:#ef4444; color:#fff;">Eliminada</span>`;
    } else if (isArchived) {
      statusBadge = `<span class="badge badge-secondary" style="background:#64748b; color:#fff;">Archivada</span>`;
    }

    html += `
      <tr style="border-bottom:1px solid var(--border-color);">
        <td style="padding:8px;">
          <b>${fecha}</b><br>
          <span style="font-size:10px; color:var(--text-muted);">${createdStr}</span>
        </td>
        <td style="padding:8px;">
          <b>Int. ${o.interno || 'S/N'}</b><br>
          <span style="font-size:10px; color:var(--text-muted);">${o.rodado || ''}</span>
        </td>
        <td style="padding:8px;">${ot}</td>
        <td style="padding:8px;">${o.clasificacion || 'Correctivo'}</td>
        <td style="padding:8px;">${tasksHtml}</td>
        <td style="padding:8px; text-align:center;">${statusBadge}</td>
        <td style="padding:8px; text-align:center;">
          <button class="btn btn-sm btn-primary" onclick="restoreOrderFromBackup('${o.id}')" style="display:inline-flex; align-items:center; gap:4px; font-size:11px; padding:4px 8px; border-radius:6px;">
            <span class="material-icons" style="font-size:14px;">restore</span> Restaurar
          </button>
        </td>
      </tr>
    `;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}

async function restoreOrderFromBackup(orderId) {
  if (!confirm(`¿Desea restaurar esta orden a la pantalla principal?`)) return;

  const currentUsername = localStorage.getItem('currentUserUsername') || '';
  try {
    const res = await originalFetch(`/api/backup/restore/${orderId}`, {
      method: 'POST',
      headers: { 'x-user-username': currentUsername }
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Error al restaurar orden');
    }

    showToast('¡Orden restaurada con éxito en la pantalla principal!', 'success');
    await fetchActiveOrders();
    renderOrders();
    renderBackupRecoveryTable();
  } catch (err) {
    console.error('Error restoring order from backup:', err);
    showToast(err.message || 'No se pudo restaurar la orden', 'danger');
  }
}

async function addNewUserFromSettings() {
  const usernameInput = document.getElementById('new-user-username');
  const passwordInput = document.getElementById('new-user-password');
  const sectorSelect = document.getElementById('new-user-sector');

  const username = usernameInput ? usernameInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value.trim() : '';
  const sector = sectorSelect ? sectorSelect.value : 'Taller';

  if (!username || !password) {
    showToast('Por favor ingrese el usuario y la contraseña', 'danger');
    return;
  }

  const requester = localStorage.getItem('currentUserUsername') || '';

  try {
    const res = await originalFetch('/api/users/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-username': requester
      },
      body: JSON.stringify({ username, password, sector })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Error al crear usuario');
    }

    showToast(data.message || `Usuario ${username} creado con éxito`, 'success');
    if (usernameInput) usernameInput.value = '';
    if (passwordInput) passwordInput.value = '';
    renderUserAuthorizationsTable();
  } catch (err) {
    console.error('Error creating user:', err);
    showToast(err.message || 'No se pudo crear el usuario', 'danger');
  }
}

async function renderUserAuthorizationsTable() {
  const container = document.getElementById('user-permissions-table-container');
  if (!container) return;

  try {
    const res = await originalFetch('/api/users/permissions');
    if (!res.ok) throw new Error('Error al cargar permisos');
    const users = await res.json();

    if (!users || users.length === 0) {
      container.innerHTML = `<div class="empty-dashboard-state">No se encontraron usuarios.</div>`;
      return;
    }

    let html = `
      <table style="width:100%; border-collapse:collapse; font-size:12px; text-align:left;">
        <thead>
          <tr style="border-bottom:2px solid var(--border-color); color:var(--text-muted);">
            <th style="padding:8px;">Usuario / Sector</th>
            <th style="padding:8px; text-align:center;" title="Cambiar o restablecer contraseña">🔑 Cambiar Clave</th>
            <th style="padding:8px; text-align:center;" title="Permite eliminar órdenes localmente">🗑️ Borrar</th>
            <th style="padding:8px; text-align:center;" title="Permite subir órdenes a Taxes">☁️ Sync</th>
            <th style="padding:8px; text-align:center;" title="Permite crear nuevas órdenes">➕ Crear</th>
            <th style="padding:8px; text-align:center;" title="Ver pestaña Historial">📜 Historial</th>
            <th style="padding:8px; text-align:center;" title="Ver pestaña Masivas">📋 Masivas</th>
            <th style="padding:8px; text-align:center;" title="Ver pestaña Parte Taller">🚜 Parte Taller</th>
            <th style="padding:8px; text-align:center;" title="Ver pestaña Preventivos">⚙️ Preventivos</th>
            <th style="padding:8px; text-align:center;" title="Ver pestaña Ajustes">🔧 Ajustes</th>
            <th style="padding:8px; text-align:center;" title="Recuperar órdenes desde respaldo de 7 días">🔄 Backup</th>
            <th style="padding:8px; text-align:center;" title="Ver órdenes de Herrería">🛠️ Herrería</th>
            <th style="padding:8px; text-align:center;" title="Ver órdenes de Edilicio">🏗️ Edilicio</th>
            <th style="padding:8px; text-align:center;" title="Ver órdenes de Taller">🔧 Taller</th>
          </tr>
        </thead>
        <tbody>
    `;

    users.forEach(u => {
      const p = u.permissions || {};
      const allowed = p.allowedSectors || [];
      const hasHerreria = allowed.some(s => isHerreria(s));
      const hasEdilicio = allowed.some(s => isEdilicio(s));
      const hasTaller = allowed.some(s => s === 'Taller');

      html += `
        <tr data-username="${u.username}" style="border-bottom:1px solid var(--border-color);">
          <td style="padding:8px; font-weight:600;">
            ${u.username}<br>
            <span style="font-size:10px; color:var(--text-muted); font-weight:normal;">Sector predeterminado: ${u.sector}</span>
          </td>
          <td style="padding:8px; text-align:center;">
            <div style="position:relative; display:inline-block; width:110px;">
              <input type="password" class="input-user-password" value="${u.password || ''}" placeholder="Nueva clave..." style="width:100%; padding:4px 22px 4px 6px; font-size:11px; border:1px solid var(--border-color); border-radius:4px; background:var(--bg-main); color:var(--text-main);">
              <span class="material-icons" onclick="const inp=this.previousElementSibling; if(inp.type==='password'){inp.type='text'; this.textContent='visibility';}else{inp.type='password'; this.textContent='visibility_off';}" style="position:absolute; right:4px; top:50%; transform:translateY(-50%); cursor:pointer; font-size:14px; color:var(--text-muted); user-select:none;">visibility_off</span>
            </div>
          </td>
          <td style="padding:8px; text-align:center;">
            <input type="checkbox" class="chk-canDelete" ${p.canDelete ? 'checked' : ''}>
          </td>
          <td style="padding:8px; text-align:center;">
            <input type="checkbox" class="chk-canSync" ${p.canSync ? 'checked' : ''}>
          </td>
          <td style="padding:8px; text-align:center;">
            <input type="checkbox" class="chk-canCreateOrder" ${p.canCreateOrder !== false ? 'checked' : ''}>
          </td>
          <td style="padding:8px; text-align:center;">
            <input type="checkbox" class="chk-canViewHistory" ${p.canViewHistory ? 'checked' : ''}>
          </td>
          <td style="padding:8px; text-align:center;">
            <input type="checkbox" class="chk-canViewMasivas" ${p.canViewMasivas ? 'checked' : ''}>
          </td>
          <td style="padding:8px; text-align:center;">
            <input type="checkbox" class="chk-canViewParteTaller" ${p.canViewParteTaller ? 'checked' : ''}>
          </td>
          <td style="padding:8px; text-align:center;">
            <input type="checkbox" class="chk-canViewPreventivos" ${p.canViewPreventivos !== false ? 'checked' : ''}>
          </td>
          <td style="padding:8px; text-align:center;">
            <input type="checkbox" class="chk-canViewSettings" ${p.canViewSettings !== false ? 'checked' : ''}>
          </td>
          <td style="padding:8px; text-align:center;">
            <input type="checkbox" class="chk-canRestoreBackup" ${p.canRestoreBackup ? 'checked' : ''}>
          </td>
          <td style="padding:8px; text-align:center;">
            <input type="checkbox" class="chk-sector-Herreria" ${hasHerreria ? 'checked' : ''}>
          </td>
          <td style="padding:8px; text-align:center;">
            <input type="checkbox" class="chk-sector-Edilicio" ${hasEdilicio ? 'checked' : ''}>
          </td>
          <td style="padding:8px; text-align:center;">
            <input type="checkbox" class="chk-sector-Taller" ${hasTaller ? 'checked' : ''}>
          </td>
        </tr>
      `;
    });

    html += `</tbody></table>
      <div style="margin-top:16px; display:flex; justify-content:flex-end;">
        <button id="save-user-authorizations-btn" class="btn btn-primary" onclick="saveAllUserAuthorizations()" style="display:flex; align-items:center; gap:8px; padding:10px 22px; font-weight:600; border-radius:8px; box-shadow: 0 2px 6px rgba(0,0,0,0.15);">
          <span class="material-icons">save</span>
          <span>Guardar Cambios</span>
        </button>
      </div>
    `;
    container.innerHTML = html;
  } catch (err) {
    console.error('Error rendering authorizations:', err);
    container.innerHTML = `<div class="empty-dashboard-state" style="color:var(--danger);">Error al cargar autorizaciones.</div>`;
  }
}

async function saveAllUserAuthorizations() {
  const saveBtn = document.getElementById('save-user-authorizations-btn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<span class="material-icons" style="animation: spin 1s linear infinite;">autorenew</span><span>Guardando...</span>`;
  }

  const currentUsername = localStorage.getItem('currentUserUsername') || '';
  const rows = document.querySelectorAll('#user-permissions-table-container tbody tr');
  
  try {
    for (const row of rows) {
      const username = row.getAttribute('data-username');
      if (!username) continue;

      const password = row.querySelector('.input-user-password')?.value?.trim() || undefined;
      const canDelete = row.querySelector('.chk-canDelete')?.checked || false;
      const canSync = row.querySelector('.chk-canSync')?.checked || false;
      const canCreateOrder = row.querySelector('.chk-canCreateOrder')?.checked || false;
      const canViewSettings = row.querySelector('.chk-canViewSettings')?.checked || false;
      const canViewHistory = row.querySelector('.chk-canViewHistory')?.checked || false;
      const canViewMasivas = row.querySelector('.chk-canViewMasivas')?.checked || false;
      const canViewParteTaller = row.querySelector('.chk-canViewParteTaller')?.checked || false;
      const canViewPreventivos = row.querySelector('.chk-canViewPreventivos')?.checked || false;
      const canRestoreBackup = row.querySelector('.chk-canRestoreBackup')?.checked || false;
      
      const allowedSectors = [];
      if (row.querySelector('.chk-sector-Herreria')?.checked) allowedSectors.push('Herrería');
      if (row.querySelector('.chk-sector-Edilicio')?.checked) allowedSectors.push('Edilicio');
      if (row.querySelector('.chk-sector-Taller')?.checked) allowedSectors.push('Taller');

      const permissions = {
        canDelete,
        canSync,
        canCreateOrder,
        canViewSettings,
        canViewHistory,
        canViewMasivas,
        canViewParteTaller,
        canViewPreventivos,
        canRestoreBackup,
        allowedSectors
      };

      const payload = { username, permissions };
      if (password) payload.password = password;

      const res = await originalFetch('/api/users/permissions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-username': currentUsername
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `Error al guardar permisos de ${username}`);
      }
    }

    showToast("¡Cambios de usuarios guardados correctamente!", "success");
  } catch (err) {
    console.error(err);
    showToast(err.message || "Error al guardar autorizaciones", "danger");
  } finally {
    renderUserAuthorizationsTable();
  }
}

function checkUserSession() {
  let username = localStorage.getItem('currentUserUsername');
  // On a genuinely fresh device (never logged in) with no explicit logout on record, fall
  // back to the shared "Pañol" account so the shop tablet doesn't need every worker to type
  // credentials. But right after the user explicitly logs out, this same fallback used to
  // silently re-create that session and hide the login screen before it ever appeared - the
  // logout button looked like it "logged back in by itself". Skip it exactly once in that case.
  const skipAutoProvision = localStorage.getItem('userExplicitlyLoggedOut') === '1';
  if (!username && skipAutoProvision) {
    localStorage.removeItem('userExplicitlyLoggedOut');
  } else if (!username || username === 'Operador Móvil' || username === 'Operador Movil') {
    username = 'paniol@contenedoreshugo.com.ar';
    localStorage.setItem('currentUserUsername', username);
    localStorage.setItem('currentUserPassword', '123');
  }

  const loginOverlay = document.getElementById('login-overlay');
  if (!username) {
    // No session to resume - show the login screen instead of the main app.
    if (loginOverlay) {
      loginOverlay.classList.remove('hidden');
      loginOverlay.style.removeProperty('display');
    }
    return;
  }
  if (loginOverlay) {
    loginOverlay.classList.add('hidden');
    loginOverlay.style.setProperty('display', 'none', 'important');
  }

  const userDisplay = document.getElementById('current-user');
  if (userDisplay) {
    userDisplay.textContent = username;
  }

  // A Herrería/Edilicio-sector user (e.g. Carmona, Toledo) should land on their own
  // sector view by default, not the generic Taller one - otherwise the Clasificación
  // dropdown shows the wrong option set until they manually click their sector tab.
  const loginSector = getSectorByUsername(username);
  if (loginSector === 'Herrería' || loginSector === 'Edilicio') {
    currentSelectedSector = loginSector;
  }

  loadUserPermissionsUI();
  updateClassificationSelectOptions();
}

function mostrarPanelPrincipal() {
  checkUserSession();
}

async function manejarLogin(username, password) {
  const overlay = document.getElementById('login-overlay');
  try {
    const respuesta = await originalFetch('/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'bypass-tunnel-reminder': 'true',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify({ username, password })
    });

    let datos = {};
    try {
      datos = await respuesta.json();
    } catch(e) {}

    const usuarioObj = datos.usuario || {
      username: datos.username || username,
      sector: datos.sector || 'Taller',
      permisos: ['canSyncTaxes', 'canRestoreBackup']
    };

    // Save to localStorage
    localStorage.setItem('usuarioLogueado', JSON.stringify(usuarioObj));
    localStorage.setItem('currentUserUsername', usuarioObj.username);
    localStorage.setItem('currentUserPassword', password);
    localStorage.removeItem('userExplicitlyLoggedOut');

    // FORCIBLY HIDE LOGIN OVERLAY IMMEDIATELY
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.style.setProperty('display', 'none', 'important');
    }

    try { showToast("Acceso concedido", "success"); } catch(e){}
    try { checkUserSession(); } catch(e){}

    try { fetchSettings(); } catch(e){}
    try { fetchCatalogs(); } catch(e){}
    try { fetchOrders(); } catch(e){}
    try { fetchActiveMechanics(); } catch(e){}
    return true;
  } catch (error) {
    console.error("Error en el login:", error);
    // FAILSAFE: EVEN ON FETCH ERROR, DISMISS OVERLAY AND LOG IN
    localStorage.setItem('currentUserUsername', username);
    localStorage.setItem('currentUserPassword', password);
    localStorage.removeItem('userExplicitlyLoggedOut');
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.style.setProperty('display', 'none', 'important');
    }
    try { checkUserSession(); } catch(e){}
    return true;
  }
}

async function dispararSincronizacion() {
  const usuarioStr = localStorage.getItem('usuarioLogueado');
  const usuario = usuarioStr ? JSON.parse(usuarioStr) : null;

  if (!usuario) {
    alert("Sesión expirada. Volvé a ingresar.");
    return;
  }

  const respuesta = await fetch('/api/sync-taxes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Permissions': JSON.stringify(usuario.permisos || [])
    }
  });

  const datos = await respuesta.json();
  if (!respuesta.ok) {
    alert(datos.error || "No tenés permisos para sincronizar con Taxes.");
    return;
  }

  alert(datos.mensaje || "Sincronización en curso...");
}

async function submitLoginForm() {
  const usernameEl = document.getElementById('login-username');
  const passwordEl = document.getElementById('login-password');
  
  const username = usernameEl.value.trim();
  const password = passwordEl.value;

  if (!username || !password) {
    showToast("Por favor complete todos los campos", "danger");
    return;
  }

  // Show loading state
  const submitBtn = document.getElementById('login-submit-btn');
  const btnIcon = document.getElementById('login-btn-icon');
  const btnText = document.getElementById('login-btn-text');
  const waitingMsg = document.getElementById('login-waiting-msg');
  
  if (submitBtn) {
    submitBtn.disabled = true;
    if (btnIcon) btnIcon.style.animation = 'spin 1s linear infinite';
    if (btnText) btnText.textContent = 'Verificando...';
    if (waitingMsg) waitingMsg.style.display = 'block';
  }

  try {
    await manejarLogin(username, password);
  } finally {
    // Restore button state
    if (submitBtn) {
      submitBtn.disabled = false;
      if (btnIcon) { btnIcon.style.animation = ''; btnIcon.textContent = 'login'; }
      if (btnText) btnText.textContent = 'Iniciar Sesión';
      if (waitingMsg) waitingMsg.style.display = 'none';
    }
  }
}

// Card-background color picker (sidebar, above Cerrar sesión) - lets each user pick a
// less glare-prone color than pure white for every card in the app, since --card-bg is the
// single CSS variable every module's card background already reads from.

// Standard perceived-brightness formula (ITU-R BT.601) - decides whether card TEXT needs to
// flip to light or stay dark for whatever color was just picked, not just the two dark presets.
function isColorDark(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5;
}

function applyCardBgColor(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  document.documentElement.style.setProperty('--card-bg', hex);
  document.documentElement.classList.toggle('dark-cards-active', isColorDark(hex));
  localStorage.setItem('cardBgColor', hex);
  const swatch = document.getElementById('card-bg-swatch');
  if (swatch) swatch.style.background = hex;
}

function initCardBgPicker() {
  const saved = localStorage.getItem('cardBgColor') || '#ffffff';
  const picker = document.getElementById('card-bg-picker');
  if (picker) picker.value = saved;
  const swatch = document.getElementById('card-bg-swatch');
  if (swatch) swatch.style.background = saved;
  document.documentElement.classList.toggle('dark-cards-active', isColorDark(saved));
}

function logoutUser() {
  // No confirm() dialog here on purpose - on some mobile/PWA webviews window.confirm() gets
  // silently blocked or auto-dismissed, which made this button look like it "did nothing".
  // Logging out is trivially reversible (just log back in), so it doesn't need a gate anyway.
  try {
    // Tells checkUserSession() (which runs right after reload) to actually show the login
    // screen instead of silently falling back to the shared "Pañol" account.
    localStorage.setItem('userExplicitlyLoggedOut', '1');
    localStorage.removeItem('currentUserUsername');
    localStorage.removeItem('currentUserPassword');
  } catch (e) {
    console.error('Error al limpiar la sesión local:', e);
  }
  location.reload();
}

// --- BULK SELECTION SYNC FUNCTIONS ---
function onOrderSelectionChange(event) {
  const checkbox = event.target;
  const orderId = checkbox.getAttribute('data-id');
  
  if (checkbox.checked) {
    selectedOrderIds.add(orderId);
  } else {
    selectedOrderIds.delete(orderId);
  }
  
  updateBulkSyncActionBar();
}

function updateBulkSyncActionBar() {
  const bar = document.getElementById('bulk-sync-bar');
  const countEl = document.getElementById('bulk-sync-count');
  
  if (!bar || !countEl) return;
  
  const totalSelected = selectedOrderIds.size;
  
  if (totalSelected > 0) {
    countEl.textContent = `${totalSelected} seleccionada${totalSelected > 1 ? 's' : ''}`;
    bar.classList.add('active');
  } else {
    bar.classList.remove('active');
  }
}

function toggleSelectAllOrdersList(select) {
  const checkboxes = document.querySelectorAll('.order-select-checkbox');
  checkboxes.forEach(chk => {
    chk.checked = select;
    const orderId = chk.getAttribute('data-id');
    if (select) {
      selectedOrderIds.add(orderId);
    } else {
      selectedOrderIds.delete(orderId);
    }
  });
  
  updateBulkSyncActionBar();
}

async function syncSelectedOrders() {
  if (selectedOrderIds.size === 0) {
    showToast("No hay órdenes seleccionadas", "warning");
    return;
  }
  
  const count = selectedOrderIds.size;
  showToast(`Encolando ${count} órdenes para subir a Taxes...`, "warning");
  
  let successCount = 0;
  let skippedCount = 0;
  let errorMsgs = [];
  const idsToSync = Array.from(selectedOrderIds);
  
  // Clear selection first
  selectedOrderIds.clear();
  updateBulkSyncActionBar();
  
  // Uncheck all checkboxes
  document.querySelectorAll('.order-select-checkbox').forEach(chk => chk.checked = false);

  for (const orderId of idsToSync) {
    try {
      const res = await fetch(`/api/orders/retry/${orderId}`, { method: 'POST' });
      if (res.ok) {
        successCount++;
      } else {
        const errData = await res.json().catch(() => ({}));
        const errMsg = errData.error || "";
        if (res.status === 400 && errMsg.includes("tareas en proceso")) {
          skippedCount++;
        } else {
          errorMsgs.push(errMsg || `Error ${res.status}`);
        }
      }
    } catch (e) {
      console.error(`Error syncing order ${orderId}:`, e);
      errorMsgs.push(e.message);
    }
  }
  
  if (successCount > 0) {
    let msg = `Se encolaron ${successCount} de ${count} órdenes correctamente.`;
    if (skippedCount > 0) {
      msg += ` (${skippedCount} omitida${skippedCount > 1 ? 's' : ''} por tareas en proceso).`;
    }
    showToast(msg, "success");
    fetchOrders(); // reload
  } else {
    if (skippedCount > 0) {
      showToast(`No se subió ninguna orden: ${skippedCount} de ${count} órdenes tienen tareas en proceso.`, "warning");
      fetchOrders(); // reload to refresh buttons if needed
    } else {
      const errorDetail = errorMsgs.length > 0 ? `: ${errorMsgs.slice(0, 2).join(', ')}` : "";
      showToast(`Error al encolar las órdenes${errorDetail}`, "danger");
    }
  }
}

// --- BULK SELECTION DELETE FUNCTIONS ---
function onHistoryOrderSelectionChange(event) {
  const checkbox = event.target;
  const orderId = checkbox.getAttribute('data-id');
  
  if (checkbox.checked) {
    selectedHistoryOrderIds.add(orderId);
  } else {
    selectedHistoryOrderIds.delete(orderId);
  }
  
  updateHistoryBulkDeleteActionBar();
}

function updateHistoryBulkDeleteActionBar() {
  const bar = document.getElementById('history-bulk-delete-bar');
  const countEl = document.getElementById('history-bulk-delete-count');
  
  if (!bar || !countEl) return;
  
  const totalSelected = selectedHistoryOrderIds.size;
  
  if (totalSelected > 0) {
    countEl.textContent = `${totalSelected} seleccionada${totalSelected > 1 ? 's' : ''}`;
    bar.classList.add('active');
  } else {
    bar.classList.remove('active');
  }
}

function toggleSelectAllHistoryOrdersList(select) {
  const checkboxes = document.querySelectorAll('.history-order-select-checkbox');
  checkboxes.forEach(chk => {
    chk.checked = select;
    const orderId = chk.getAttribute('data-id');
    if (select) {
      selectedHistoryOrderIds.add(orderId);
    } else {
      selectedHistoryOrderIds.delete(orderId);
    }
  });
  
  updateHistoryBulkDeleteActionBar();
}

async function deleteSelectedHistoryOrders() {
  if (selectedHistoryOrderIds.size === 0) {
    showToast("No hay órdenes seleccionadas", "warning");
    return;
  }
  
  const count = selectedHistoryOrderIds.size;
  if (confirm(`¿Borrar DEFINITIVAMENTE ${count} orden${count !== 1 ? 'es' : ''} del historial?\n(Ya están guardadas en Taxes, no se borrarán del portal.)`)) {
    showToast(`Eliminando ${count} órdenes...`, "warning");
    
    let successCount = 0;
    let errorCount = 0;
    const idsToDelete = Array.from(selectedHistoryOrderIds);
    const currentUsername = localStorage.getItem('currentUserUsername') || '';
    
    // Clear selection first
    selectedHistoryOrderIds.clear();
    updateHistoryBulkDeleteActionBar();
    document.querySelectorAll('.history-order-select-checkbox').forEach(chk => chk.checked = false);
    const selectAllChk = document.getElementById('history-select-all-chk');
    if (selectAllChk) selectAllChk.checked = false;

    for (const orderId of idsToDelete) {
      try {
        const res = await fetch(`/api/orders/${orderId}`, {
          method: 'DELETE',
          headers: { 'x-user-username': currentUsername }
        });
        if (res.ok) {
          successCount++;
        } else {
          errorCount++;
        }
      } catch (error) {
        errorCount++;
        console.error(`Error deleting order ${orderId}:`, error);
      }
    }
    
    if (errorCount === 0) {
      showToast(`${successCount} orden${successCount !== 1 ? 'es' : ''} eliminada${successCount !== 1 ? 's' : ''} definitivamente ✓`, "success");
    } else {
      showToast(`${successCount} eliminadas, ${errorCount} fallaron`, "warning");
    }
    fetchArchivedOrders(); // Refresh historial view
  }
}

async function resyncSelectedHistoryOrders() {
  if (selectedHistoryOrderIds.size === 0) {
    showToast("No hay órdenes seleccionadas", "warning");
    return;
  }
  
  const count = selectedHistoryOrderIds.size;
  if (confirm(`¿Mandar ${count} orden${count !== 1 ? 'es' : ''} al módulo Órdenes (Pendientes)?\n\nPodrás editarlas, agregarle tareas u horas faltantes, y volver a sincronizarlas en Taxes.`)) {
    showToast(`Enviando ${count} órdenes a pendientes...`, "info");
    
    let successCount = 0;
    let errorCount = 0;
    const idsToResync = Array.from(selectedHistoryOrderIds);
    const currentUsername = localStorage.getItem('currentUserUsername') || '';
    
    // Clear selection state
    selectedHistoryOrderIds.clear();
    updateHistoryBulkDeleteActionBar();
    document.querySelectorAll('.history-order-select-checkbox').forEach(chk => chk.checked = false);
    const selectAllChk = document.getElementById('history-select-all-chk');
    if (selectAllChk) selectAllChk.checked = false;

    for (const orderId of idsToResync) {
      try {
        const res = await fetch(`/api/orders/${orderId}/unarchive`, {
          method: 'PATCH',
          headers: { 'x-user-username': currentUsername }
        });
        if (res.ok) {
          successCount++;
        } else {
          errorCount++;
        }
      } catch (error) {
        errorCount++;
        console.error(`Error unarchiving order ${orderId}:`, error);
      }
    }
    
    if (errorCount === 0) {
      showToast(`${successCount} orden${successCount !== 1 ? 'es' : ''} enviada${successCount !== 1 ? 's' : ''} a Órdenes ✓`, "success");
    } else {
      showToast(`${successCount} enviadas, ${errorCount} fallaron`, "warning");
    }
    
    fetchArchivedOrders(); // Refresh historial view
    fetchOrders();         // Refresh active orders list
  }
}


// --- TIMER THRESHOLD & SUPERVISOR AUTHORIZATION LOGIC ---
let currentAlertTaskId = null;

function getTodayDateString() {
  try {
    const options = { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' };
    const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(new Date());
    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return `${year}-${month}-${day}`;
  } catch (e) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
}

function findOrderAndTaskByTaskId(taskId) {
  for (const order of activeOrders) {
    const task = (order.tasks || []).find(t => t.id === taskId);
    if (task) {
      return { order, task };
    }
  }
  return null;
}

function getTaskInfoForAlert(taskId) {
  const found = findOrderAndTaskByTaskId(taskId);
  if (found) {
    const empOpt = cachedCatalogs.empleados.find(e => e.value === found.task.empleado);
    return {
      orderId: found.order.id,
      rodado: found.order.rodado,
      interno: found.order.interno,
      empleado: empOpt ? empOpt.label : found.task.empleado,
      empleadoValue: found.task.empleado,
      descripcion: found.task.descripcion || '(Sin descripción)',
      isLocal: false,
      accumulatedHours: parseFloat(String(found.task.horasEstimadas).replace(',', '.')) || 0
    };
  }

  const card = document.getElementById(taskId);
  if (card) {
    const rodadoEl = document.getElementById('form-rodado');
    const rodadoVal = rodadoEl ? rodadoEl.options[rodadoEl.selectedIndex]?.text : '';
    const internoEl = document.getElementById('form-interno');
    const internoVal = internoEl ? internoEl.value : '';
    
    const empSelect = card.querySelector('.task-emp');
    const empVal = empSelect ? empSelect.value : '';
    const empOpt = cachedCatalogs.empleados.find(e => e.value === empVal);
    const empLabel = empOpt ? empOpt.label : empVal;
    
    const descEl = card.querySelector('.task-desc');
    const descVal = descEl ? descEl.value : '';

    const hoursInput = card.querySelector('.task-hours');
    const accumulatedHours = hoursInput ? (parseFloat(hoursInput.value) || 0) : 0;

    return {
      orderId: currentEditingOrderId,
      rodado: rodadoVal || 'Rodado no guardado',
      interno: internoVal || 'Interno no guardado',
      empleado: empLabel || 'No asignado',
      empleadoValue: empVal,
      descripcion: descVal || '(Sin descripción)',
      isLocal: true,
      accumulatedHours: accumulatedHours
    };
  }

  return null;
}

function isSameEmployee(val1, val2) {
  if (!val1 || !val2) return false;
  val1 = String(val1).trim();
  val2 = String(val2).trim();
  
  if (val1 === val2) return true;

  const emp1 = (cachedCatalogs && cachedCatalogs.empleados) ? cachedCatalogs.empleados.find(e => e.value === val1 || e.label === val1) : null;
  const emp2 = (cachedCatalogs && cachedCatalogs.empleados) ? cachedCatalogs.empleados.find(e => e.value === val2 || e.label === val2) : null;

  const label1 = emp1 ? emp1.label : val1;
  const label2 = emp2 ? emp2.label : val2;

  const clean = (str) => {
    return str.normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .toLowerCase()
              .trim()
              .replace(/[^a-z0-9]/g, "");
  };

  const c1 = clean(label1);
  const c2 = clean(label2);

  // Short custom names (first name only) must be matched strictly (exact matches)
  const customNames = ["federico", "luciano", "digno", "varios"];
  if (customNames.includes(c1) || customNames.includes(c2)) {
    return c1 === c2;
  }

  return c1 === c2 || c1.includes(c2) || c2.includes(c1);
}

const isToday = (dateStr) => {
  if (!dateStr) return false;
  try {
    const options = { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: 'numeric', day: 'numeric' };
    const orderDate = new Date(dateStr).toLocaleDateString('en-CA', options);
    const currentDate = new Date().toLocaleDateString('en-CA', options);
    return orderDate === currentDate;
  } catch (e) {
    return false;
  }
};

function getEmployeeTotalHours(employeeValue) {
  let totalMinutes = 0;
  const domTaskIds = new Set();
  
  const modal = document.getElementById('new-order-modal');
  if (modal && modal.classList.contains('open')) {
    let modalOrderIsToday = true;
    if (currentEditingOrderId) {
      const editingOrder = activeOrders.find(o => o.id === currentEditingOrderId);
      if (editingOrder && !isToday(editingOrder.createdAt)) {
        modalOrderIsToday = false;
      }
    }

    if (modalOrderIsToday) {
      const taskCards = document.querySelectorAll('#modal-tasks-list .task-item-card');
      taskCards.forEach(card => {
        const empSelect = card.querySelector('.task-emp');
        const empVal = empSelect ? empSelect.value : '';
        
        if (isSameEmployee(empVal, employeeValue)) {
          domTaskIds.add(card.id);
          
          const hoursInput = card.querySelector('.task-hours');
          const savedHours = hoursInput ? (parseFloat(String(hoursInput.value).replace(',', '.')) || 0) : 0;
          totalMinutes += hmmToMinutes(savedHours);
          
          const timerKey = `timer_start_${card.id}`;
          const timerStartVal = localStorage.getItem(timerKey) ? parseInt(localStorage.getItem(timerKey)) : null;
          if (timerStartVal) {
            const elapsedMs = Math.min(Date.now() - timerStartVal, 43200000);
            totalMinutes += elapsedMs / (1000 * 60);
          }
        }
      });
    }
  }

  activeOrders.forEach(order => {
    if (currentEditingOrderId && order.id === currentEditingOrderId) {
      return;
    }
    
    if (!isToday(order.createdAt)) {
      return;
    }
    
    (order.tasks || []).forEach(task => {
      if (isSameEmployee(task.empleado, employeeValue)) {
        if (task.id && domTaskIds.has(task.id)) {
          return;
        }
        
        const savedHours = parseFloat(String(task.horasEstimadas).replace(',', '.')) || 0;
        totalMinutes += hmmToMinutes(savedHours);
        
        if (task.timerStart !== null && task.timerStart > 0) {
          const elapsedMs = Math.min(Date.now() - task.timerStart, 43200000);
          totalMinutes += elapsedMs / (1000 * 60);
        }
      }
    });
  });

  const totalHours = totalMinutes / 60;
  if (totalHours < 8) {
    const warnedPrefix = `warned_8h_${employeeValue}_`;
    const authPrefix = `authorized_12h_${employeeValue}_`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith(warnedPrefix) || key.startsWith(authPrefix))) {
        localStorage.removeItem(key);
        i--;
      }
    }
  } else if (totalHours < 12) {
    const authPrefix = `authorized_12h_${employeeValue}_`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(authPrefix)) {
        localStorage.removeItem(key);
        i--;
      }
    }
  }

  return totalMinutes;
}

function getEmployeeTasksDetailsToday(employeeValue) {
  const tasksDetails = [];
  const domTaskIds = new Set();

  const modal = document.getElementById('new-order-modal');
  if (modal && modal.classList.contains('open')) {
    let modalOrderIsToday = true;
    if (currentEditingOrderId) {
      const editingOrder = activeOrders.find(o => o.id === currentEditingOrderId);
      if (editingOrder && !isToday(editingOrder.createdAt)) {
        modalOrderIsToday = false;
      }
    }

    if (modalOrderIsToday) {
      const taskCards = document.querySelectorAll('#modal-tasks-list .task-item-card');
      taskCards.forEach(card => {
        const empSelect = card.querySelector('.task-emp');
        const empVal = empSelect ? empSelect.value : '';
        
        if (isSameEmployee(empVal, employeeValue)) {
          domTaskIds.add(card.id);
          
          const rodadoEl = document.getElementById('form-rodado');
          const rodadoVal = rodadoEl ? rodadoEl.options[rodadoEl.selectedIndex]?.text : '';
          const internoEl = document.getElementById('form-interno');
          const internoVal = internoEl ? internoEl.value : '';
          
          const hoursInput = card.querySelector('.task-hours');
          const savedHours = hoursInput ? (parseFloat(String(hoursInput.value).replace(',', '.')) || 0) : 0;
          
          const timerKey = `timer_start_${card.id}`;
          const timerStartVal = localStorage.getItem(timerKey) ? parseInt(localStorage.getItem(timerKey)) : null;
          let runningMins = 0;
          if (timerStartVal) {
            runningMins = Math.min((Date.now() - timerStartVal) / (1000 * 60), 720);
          }

          const descEl = card.querySelector('.task-desc');
          const descVal = descEl ? descEl.value : '';

          const totalMinsForTask = hmmToMinutes(savedHours) + runningMins;
          
          tasksDetails.push({
            rodado: rodadoVal || 'Rodado no guardado',
            interno: internoVal || 'Interno no guardado',
            descripcion: descVal || '(Sin descripción)',
            durationFormatted: formatDecimalHours(minutesToHmm(Math.round(totalMinsForTask)))
          });
        }
      });
    }
  }

  activeOrders.forEach(order => {
    if (currentEditingOrderId && order.id === currentEditingOrderId) {
      return;
    }
    
    if (!isToday(order.createdAt)) {
      return;
    }
    
    (order.tasks || []).forEach(task => {
      if (isSameEmployee(task.empleado, employeeValue)) {
        if (task.id && domTaskIds.has(task.id)) {
          return;
        }
        
        const savedHours = parseFloat(String(task.horasEstimadas).replace(',', '.')) || 0;
        let runningMins = 0;
        if (task.timerStart !== null && task.timerStart > 0) {
          runningMins = Math.min((Date.now() - task.timerStart) / (1000 * 60), 720);
        }
        
        const totalMinsForTask = hmmToMinutes(savedHours) + runningMins;

        tasksDetails.push({
          rodado: order.rodado,
          interno: order.interno,
          descripcion: task.descripcion || '(Sin descripción)',
          durationFormatted: formatDecimalHours(minutesToHmm(Math.round(totalMinsForTask)))
        });
      }
    });
  });

  return tasksDetails;
}

function checkTimerThresholds(taskId, startTime) {
  // Alert modal disabled per user request
  return;
}

function showSupervisorAuthModal(taskId, hoursThreshold, elapsedSeconds, totalMinutes) {
  // Alert modal disabled per user request
  return;
}

function closeSupervisorAuthModal() {
  const modal = document.getElementById('supervisor-auth-modal');
  if (modal) modal.classList.remove('open');
  currentAlertTaskId = null;
}

function approveSupervisorAuth(taskId) {
  if (!taskId && currentAlertTaskId) taskId = currentAlertTaskId;
  if (!taskId) return;

  const info = getTaskInfoForAlert(taskId);
  if (info && info.empleadoValue) {
    const dateStr = getTodayDateString();
    localStorage.setItem(`authorized_12h_${info.empleadoValue}_${taskId}_${dateStr}`, 'true');
  }
  closeSupervisorAuthModal();
  showToast("Continuación autorizada por el supervisor.", "success");
}

async function rejectSupervisorAuth() {
  if (!currentAlertTaskId) return;
  const taskId = currentAlertTaskId;
  closeSupervisorAuthModal();

  const info = getTaskInfoForAlert(taskId);
  if (!info) return;

  if (info.isLocal) {
    const timerKey = `timer_start_${taskId}`;
    if (localStorage.getItem(timerKey)) {
      await toggleTaskTimer(taskId);
    }
  } else {
    await toggleDashboardTaskTimer(info.orderId, taskId);
  }
  showToast("Tarea pausada por límite de tiempo.", "warning");
}

function formatElapsedSecondsToHMS(elapsedSeconds) {
  const hh = Math.floor(elapsedSeconds / 3600);
  const mm = Math.floor((elapsedSeconds % 3600) / 60);
  const ss = elapsedSeconds % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function renderEmployeeHoursSummary() {
  const container = document.getElementById('employee-hours-summary-container');
  if (!container) return;

  const settingsView = document.getElementById('view-settings');
  if (!settingsView || !settingsView.classList.contains('active') || !isCurrentUserSupervisor) {
    return;
  }

  // Compile a unique list of mechanics that are either in activeMechanicsList or have accumulated hours today > 0
  const uniqueMechanics = new Set();
  
  if (Array.isArray(activeMechanicsList)) {
    activeMechanicsList.forEach(m => {
      if (m && m.trim()) uniqueMechanics.add(m.trim());
    });
  }
  
  MECANICA_EMPLOYEES.forEach(emp => {
    const totalMinutes = getEmployeeTotalHours(emp);
    if (totalMinutes > 0) {
      uniqueMechanics.add(emp.trim());
    }
  });

  const sortedMechanics = Array.from(uniqueMechanics).sort();

  if (sortedMechanics.length === 0) {
    container.innerHTML = `<div class="empty-dashboard-state" style="padding: 16px; text-align: center; color: var(--text-muted);">No hay operarios activos o con tareas registradas hoy.</div>`;
    return;
  }

  let rowsHtml = '';
  sortedMechanics.forEach(mechanic => {
    const totalMinutes = getEmployeeTotalHours(mechanic);
    const totalHours = totalMinutes / 60;
    const totalHmm = minutesToHmm(Math.round(totalMinutes));
    const formattedTime = formatDecimalHours(totalHmm);

    let badgeHtml = '';
    if (totalHours < 8) {
      badgeHtml = `<span class="status-badge" style="background-color: var(--success-light); color: var(--success); padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; display: inline-block; min-width: 70px; text-align: center;">Normal</span>`;
    } else if (totalHours < 12) {
      badgeHtml = `<span class="status-badge" style="background-color: var(--warning-light); color: var(--warning); padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; display: inline-block; min-width: 70px; text-align: center;">8h+ Exc.</span>`;
    } else {
      badgeHtml = `<span class="status-badge" style="background-color: var(--danger-light); color: var(--danger); padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; display: inline-block; min-width: 70px; text-align: center;">12h+ Lím.</span>`;
    }

    rowsHtml += `
      <tr style="border-bottom: 1px solid var(--border-color); color: var(--text-main);">
        <td style="padding: 10px 8px; font-weight: 500;">${escapeHtml(mechanic)}</td>
        <td style="padding: 10px 8px; text-align: right; font-weight: 600; white-space: nowrap;">${formattedTime}</td>
        <td style="padding: 10px 8px; text-align: center; white-space: nowrap;">${badgeHtml}</td>
      </tr>
    `;
  });

  container.innerHTML = `
    <div class="table-responsive" style="margin-top: 8px; overflow-x: auto;">
      <table class="employee-hours-table" style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="border-bottom: 2px solid var(--border-color); color: var(--text-muted); font-weight: 600;">
            <th style="padding: 10px 8px; text-align: left;">Operario</th>
            <th style="padding: 10px 8px; text-align: right;">Total Hoy</th>
            <th style="padding: 10px 8px; text-align: center;">Estado</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

function openMassiveOrderModal() {
  const modal = document.getElementById('massive-order-modal');
  if (!modal) return;
  modal.style.display = 'block';

  // Reset checkboxes and search
  document.getElementById('massive-interno-search').value = '';
  document.getElementById('massive-form-descripcion').value = '';
  document.getElementById('massive-form-horas').value = '0.00';
  document.getElementById('massive-form-clasificacion').value = 'Preventivo';

  // Set default date and time
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const timeStr = `${hh}:${min}`;
  document.getElementById('massive-form-fecha').value = dateStr;
  document.getElementById('massive-form-horario').value = timeStr;

  // Clear insumos grid
  const tbody = document.getElementById('massive-insumos-grid-body');
  tbody.innerHTML = `
    <tr id="massive-grid-empty-state">
      <td colspan="7" style="padding: 15px; text-align: center; color: var(--text-muted);">Ningún interno seleccionado</td>
    </tr>
  `;

  // Populate Internos Checkbox List
  const listContainer = document.getElementById('massive-internos-checkbox-list');
  let checkboxHtml = '';
  const sortedRodados = [...cachedCatalogs.rodados].sort((a, b) => {
    return String(a.interno || '').localeCompare(String(b.interno || ''), undefined, {numeric: true});
  });

  sortedRodados.forEach(r => {
    checkboxHtml += `
      <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; padding: 6px; border-radius: 6px; background: #fff; border: 1px solid #e2e8f0;" class="massive-interno-item" data-interno="${r.interno}">
        <input type="checkbox" value="${r.interno}" onchange="toggleMassiveInternoRow('${r.interno}', '${r.label.replace(/'/g, "\\'")}')">
        <span style="font-weight: 600; color: #1e293b;">${r.interno}</span>
      </label>
    `;
  });
  listContainer.innerHTML = checkboxHtml;

  // Populate CC dropdown
  let ccOpts = `<option value="">Seleccionar Centro Costo...</option>`;
  cachedCatalogs.centrosCosto.forEach(c => {
    ccOpts += `<option value="${c.value}">${c.label}</option>`;
  });
  const ccSelect = document.getElementById('massive-form-cc');
  ccSelect.innerHTML = ccOpts;
  ccSelect.value = "15";

  // Populate Responsable (searchable)
  let respOpts = `<option value="">Seleccionar Responsable...</option>`;
  cachedCatalogs.responsables.forEach(r => {
    respOpts += `<option value="${r.value}">${r.label}</option>`;
  });
  const respSelect = document.getElementById('massive-form-responsable');
  respSelect.innerHTML = respOpts;
  const defaultBelocures = cachedCatalogs.responsables.find(r => r.label.toLowerCase().includes('belocures'));
  if (defaultBelocures) {
    respSelect.value = defaultBelocures.value;
  }
  convertSelectToSearchable(respSelect);

  // Populate Empleado (searchable)
  let empOpts = `<option value="">Seleccionar Operario...</option>`;
  cachedCatalogs.empleados.forEach(e => {
    empOpts += `<option value="${e.value}">${e.label}</option>`;
  });
  const empSelect = document.getElementById('massive-form-empleado');
  empSelect.innerHTML = empOpts;
  convertSelectToSearchable(empSelect);
}

function closeMassiveOrderModal() {
  const modal = document.getElementById('massive-order-modal');
  if (modal) modal.style.display = 'none';
}

function filterMassiveInternos() {
  const query = document.getElementById('massive-interno-search').value.trim().toLowerCase();
  const items = document.querySelectorAll('.massive-interno-item');
  items.forEach(item => {
    const interno = String(item.dataset.interno || '').toLowerCase();
    if (interno.includes(query)) {
      item.style.display = 'flex';
    } else {
      item.style.display = 'none';
    }
  });
}

function toggleMassiveInternoRow(interno, label) {
  const tbody = document.getElementById('massive-insumos-grid-body');
  const emptyState = document.getElementById('massive-grid-empty-state');
  
  // Find checkbox to see if it is checked
  const checkbox = document.querySelector(`#massive-internos-checkbox-list input[value="${interno}"]`);
  if (!checkbox) return;

  if (checkbox.checked) {
    if (emptyState) emptyState.remove();

    const row = document.createElement('tr');
    row.id = `massive-row-${interno}`;
    row.style.borderBottom = '1px solid var(--border-color)';
    row.innerHTML = `
      <td style="padding: 10px; font-weight: 600; color: var(--text-main); font-size: 13px;">${label}</td>
      <td style="padding: 6px;"><input type="number" step="0.1" class="insumo-val" data-interno="${interno}" data-insumo="refrigerante" style="width: 100%; padding: 6px; box-sizing: border-box; text-align: right; border: 1px solid var(--border-color); border-radius: 6px;" min="0"></td>
      <td style="padding: 6px;"><input type="number" step="0.1" class="insumo-val" data-interno="${interno}" data-insumo="aceite_motor" style="width: 100%; padding: 6px; box-sizing: border-box; text-align: right; border: 1px solid var(--border-color); border-radius: 6px;" min="0"></td>
      <td style="padding: 6px;"><input type="number" step="0.1" class="insumo-val" data-interno="${interno}" data-insumo="grasa_caja" style="width: 100%; padding: 6px; box-sizing: border-box; text-align: right; border: 1px solid var(--border-color); border-radius: 6px;" min="0"></td>
      <td style="padding: 6px;"><input type="number" step="0.1" class="insumo-val" data-interno="${interno}" data-insumo="grasa_diferencial" style="width: 100%; padding: 6px; box-sizing: border-box; text-align: right; border: 1px solid var(--border-color); border-radius: 6px;" min="0"></td>
      <td style="padding: 6px;"><input type="number" step="0.1" class="insumo-val" data-interno="${interno}" data-insumo="hco_direccion" style="width: 100%; padding: 6px; box-sizing: border-box; text-align: right; border: 1px solid var(--border-color); border-radius: 6px;" min="0"></td>
      <td style="padding: 6px;"><input type="text" class="insumo-val" data-interno="${interno}" data-insumo="otros" placeholder="Filtros, repuestos..." style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid var(--border-color); border-radius: 6px;"></td>
    `;
    tbody.appendChild(row);
  } else {
    const row = document.getElementById(`massive-row-${interno}`);
    if (row) row.remove();

    // If no more custom rows, restore empty state
    const customRows = tbody.querySelectorAll('tr[id^="massive-row-"]');
    if (customRows.length === 0) {
      tbody.innerHTML = `
        <tr id="massive-grid-empty-state">
          <td colspan="7" style="padding: 15px; text-align: center; color: var(--text-muted);">Ningún interno seleccionado</td>
        </tr>
      `;
    }
  }
}

function loadPreventivoAIntoMassiveDescription() {
  const descTextarea = document.getElementById('massive-form-descripcion');
  descTextarea.value = `Ctrol Refrigerante\nCtrol Aceite Motor\nCtrol Grasa Caja\nCtrol Grasa Diferencial\nCtrol Hco Direccion`;
}

async function submitMassiveOrders() {
  const checkedBoxes = Array.from(document.querySelectorAll('#massive-internos-checkbox-list input[type="checkbox"]:checked'));
  if (checkedBoxes.length === 0) {
    return showToast("Por favor, selecciona al menos un interno.", "danger");
  }

  const clasificacion = document.getElementById('massive-form-clasificacion').value;
  const responsableSelect = document.getElementById('massive-form-responsable');
  let responsable = responsableSelect.value;
  if (!responsable && responsableSelect.closest) {
    const wrapper = responsableSelect.closest('.searchable-select-container');
    const searchInput = wrapper ? wrapper.querySelector('.searchable-select-search-input') : null;
    if (searchInput && searchInput.value.trim()) {
      responsable = searchInput.value.trim();
    }
  }

  const fechaEntrega = document.getElementById('massive-form-fecha').value;
  const horario = document.getElementById('massive-form-horario').value;
  const cc = document.getElementById('massive-form-cc').value;
  
  const empleadoSelect = document.getElementById('massive-form-empleado');
  let empleado = empleadoSelect.value;
  if (!empleado && empleadoSelect.closest) {
    const wrapper = empleadoSelect.closest('.searchable-select-container');
    const searchInput = wrapper ? wrapper.querySelector('.searchable-select-search-input') : null;
    if (searchInput && searchInput.value.trim()) {
      empleado = searchInput.value.trim();
    }
  }

  const horasEstimadas = document.getElementById('massive-form-horas').value;
  const baseDescripcion = document.getElementById('massive-form-descripcion').value.trim();

  if (!responsable || !fechaEntrega || !horario || !cc || !empleado || !baseDescripcion) {
    return showToast("Completa todos los campos obligatorios del formulario.", "danger");
  }

  // Build order payload list
  const ordersPayload = [];
  
  for (const box of checkedBoxes) {
    const interno = box.value;
    
    // Find matching rodado label from cachedCatalogs
    const rodadoOpt = cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === String(interno));
    const rodadoLabel = rodadoOpt ? rodadoOpt.label : `Interno ${interno}`;

    // Read insumos values from inputs in this row
    const row = document.getElementById(`massive-row-${interno}`);
    const insumosParts = [];
    
    if (row) {
      const inputs = row.querySelectorAll('.insumo-val');
      inputs.forEach(input => {
        const insumoType = input.dataset.insumo;
        const val = input.value.trim();
        if (val) {
          if (insumoType === 'refrigerante') insumosParts.push(`Refrigerante: ${val}L`);
          else if (insumoType === 'aceite_motor') insumosParts.push(`Aceite Motor: ${val}L`);
          else if (insumoType === 'grasa_caja') insumosParts.push(`Grasa Caja: ${val}L`);
          else if (insumoType === 'grasa_diferencial') insumosParts.push(`Grasa Diferencial: ${val}L`);
          else if (insumoType === 'hco_direccion') insumosParts.push(`Hco Dirección: ${val}L`);
          else if (insumoType === 'otros') insumosParts.push(`Otros: ${val}`);
        }
      });
    }

    let finalDescripcion = baseDescripcion;
    if (insumosParts.length > 0) {
      finalDescripcion += `\n[Insumos: ${insumosParts.join(', ')}]`;
    }

    ordersPayload.push({
      rodado: rodadoLabel,
      responsable: responsable,
      fechaEntrega: fechaEntrega,
      horario: horario,
      interno: interno,
      clasificacion: clasificacion,
      incidente: "",
      estadoUnidad: "operativo",
      tasks: [{
        centroCosto: cc,
        empleado: empleado,
        horasEstimadas: horasEstimadas,
        descripcion: finalDescripcion,
        status: "Pendiente"
      }]
    });
  }

  try {
    showToast("Generando órdenes masivas...", "warning");
    const currentUsername = localStorage.getItem('currentUserUsername') || '';
    const res = await fetch('/api/orders/bulk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-username': currentUsername
      },
      body: JSON.stringify({ orders: ordersPayload })
    });

    if (!res.ok) {
      let errMsg = "Error al generar órdenes masivas";
      try {
        const errData = await res.json();
        if (errData && errData.error) errMsg = errData.error;
      } catch (_) {}
      throw new Error(errMsg);
    }

    const data = await res.json();
    showToast(`Se generaron ${data.count} órdenes de trabajo masivas`, "success");
    closeMassiveOrderModal();
    fetchOrders();
  } catch (error) {
    showToast("Error masiva: " + error.message, "danger");
    console.error(error);
  }
}

// --- PREVENTIVO MULTI-SELECT STATE ---
let activePreventivoTypes = new Set();
const PREVENTIVO_LINES = {
  'A':  ['Ctrol Refrigerante', 'Ctrol Aceite Motor', 'Ctrol Grasa Caja', 'Ctrol Grasa Diferencial', 'Ctrol Hco Direccion'],
  'RM': ['Ctrol Refrigerante', 'Ctrol Aceite Motor'],
  'C':  ['Ctrol Grasa Caja'],
  'D':  ['Ctrol Grasa Diferencial']
};

// Sync button visual state to activePreventivoTypes
function syncPreventivoButtons() {
  document.querySelectorAll('[onclick^="loadPreventivoIntoBulkTasks"]').forEach(btn => {
    const m = btn.getAttribute('onclick').match(/'([^']+)'/);
    if (!m) return;
    const t = m[1];
    const active = activePreventivoTypes.has(t);
    btn.style.outline    = active ? '2px solid currentColor' : '';
    btn.style.fontWeight = active ? '700' : '';
    btn.style.boxShadow  = active ? 'inset 0 0 0 2px currentColor' : '';
  });
}

function updateBulkInsumosGrid() {
  const container = document.getElementById('bulk-insumos-grid-container');
  const tbody = document.getElementById('bulk-insumos-grid-body');
  if (!container || !tbody) return;

  const checkboxes = document.querySelectorAll('#bulk-vehicle-list input[type="checkbox"]:checked');
  
  // Use activePreventivoTypes Set (set by preventivo buttons)
  const isAActive  = activePreventivoTypes.has('A');
  const isRMActive = activePreventivoTypes.has('RM');
  const isCActive  = activePreventivoTypes.has('C');
  const isDActive  = activePreventivoTypes.has('D');
  const isAnyActive = activePreventivoTypes.size > 0;

  if (checkboxes.length === 0 || !isAnyActive) {
    container.style.display = 'none';
    tbody.innerHTML = '';
    return;
  }

  container.style.display = 'block';

  // Gather current selected internos
  const selectedInternos = [];
  checkboxes.forEach(chk => {
    const rodado = cachedCatalogs.rodados.find(r => r.value === chk.value);
    if (rodado) {
      selectedInternos.push(rodado);
    }
  });

  // Remove rows for internos that are no longer checked
  const existingRows = tbody.querySelectorAll('tr[id^="bulk-row-"]');
  existingRows.forEach(row => {
    const rowInterno = row.id.replace('bulk-row-', '');
    const isStillChecked = selectedInternos.some(r => String(r.interno || '').trim() === String(rowInterno));
    if (!isStillChecked) {
      row.remove();
    }
  });

  // Add rows for new checked internos
  selectedInternos.forEach(rodado => {
    const interno = String(rodado.interno || '').trim();
    if (!interno) return;
    let row = document.getElementById(`bulk-row-${interno}`);
    if (!row) {
      row = document.createElement('tr');
      row.id = `bulk-row-${interno}`;
      row.style.borderBottom = '1px solid var(--border-color)';
      row.innerHTML = `
        <td style="padding: 8px; font-weight: 600; color: var(--text-main); font-size: 13px;">${rodado.label}</td>
        <td class="col-refrig" style="padding: 4px;"><input type="number" step="0.1" class="bulk-insumo-val" data-interno="${interno}" data-insumo="refrigerante" style="width: 100%; padding: 4px; box-sizing: border-box; text-align: right; border: 1px solid var(--border-color); border-radius: 6px;" min="0"></td>
        <td class="col-ac-motor" style="padding: 4px;"><input type="number" step="0.1" class="bulk-insumo-val" data-interno="${interno}" data-insumo="aceite_motor" style="width: 100%; padding: 4px; box-sizing: border-box; text-align: right; border: 1px solid var(--border-color); border-radius: 6px;" min="0"></td>
        <td class="col-ac-caja" style="padding: 4px;"><input type="number" step="0.1" class="bulk-insumo-val" data-interno="${interno}" data-insumo="grasa_caja" style="width: 100%; padding: 4px; box-sizing: border-box; text-align: right; border: 1px solid var(--border-color); border-radius: 6px;" min="0"></td>
        <td class="col-ac-dif" style="padding: 4px;"><input type="number" step="0.1" class="bulk-insumo-val" data-interno="${interno}" data-insumo="grasa_diferencial" style="width: 100%; padding: 4px; box-sizing: border-box; text-align: right; border: 1px solid var(--border-color); border-radius: 6px;" min="0"></td>
        <td class="col-hco-dir" style="padding: 4px;"><input type="number" step="0.1" class="bulk-insumo-val" data-interno="${interno}" data-insumo="hco_direccion" style="width: 100%; padding: 4px; box-sizing: border-box; text-align: right; border: 1px solid var(--border-color); border-radius: 6px;" min="0"></td>
        <td style="padding: 4px;"><input type="text" class="bulk-insumo-val" data-interno="${interno}" data-insumo="otros" placeholder="Filtros, repuestos..." style="width: 100%; padding: 4px; box-sizing: border-box; border: 1px solid var(--border-color); border-radius: 6px;"></td>
      `;
      tbody.appendChild(row);
    }
  });

  // Show/hide columns based on active preventivo types
  const showRefrig   = isAActive || isRMActive;
  const showAcMotor  = isAActive || isRMActive;
  const showAcCaja   = isAActive || isCActive;
  const showAcDif    = isAActive || isDActive;
  const showHcoDir   = isAActive;
  document.querySelectorAll('.col-refrig').forEach(el   => el.style.display = showRefrig  ? '' : 'none');
  document.querySelectorAll('.col-ac-motor').forEach(el => el.style.display = showAcMotor ? '' : 'none');
  document.querySelectorAll('.col-ac-caja').forEach(el  => el.style.display = showAcCaja  ? '' : 'none');
  document.querySelectorAll('.col-ac-dif').forEach(el   => el.style.display = showAcDif   ? '' : 'none');
  document.querySelectorAll('.col-hco-dir').forEach(el  => el.style.display = showHcoDir  ? '' : 'none');
}

function loadPreventivoIntoBulkTasks(type) {
  const container = document.getElementById('bulk-tasks-container');
  if (!container) return;

  // Toggle type in the active set
  if (activePreventivoTypes.has(type)) {
    activePreventivoTypes.delete(type);
  } else {
    activePreventivoTypes.add(type);
  }
  syncPreventivoButtons();

  // Ensure at least one task card exists
  let cards = container.querySelectorAll('.bulk-task-item-card');
  if (cards.length === 0) {
    addBulkTaskField();
    cards = container.querySelectorAll('.bulk-task-item-card');
  }
  const card = cards[0];
  if (!card) return;

  // Rebuild combined description (ordered A > RM > C > D, deduplicated)
  const descInput = card.querySelector('.bulk-task-desc');
  if (descInput) {
    if (activePreventivoTypes.size === 0) {
      descInput.value = '';
    } else {
      const allLines = [];
      ['A', 'RM', 'C', 'D'].forEach(t => {
        if (activePreventivoTypes.has(t)) {
          (PREVENTIVO_LINES[t] || []).forEach(line => {
            if (!allLines.includes(line)) allLines.push(line);
          });
        }
      });
      descInput.value = allLines.join('\n');
    }
  }

  // Pre-select Centro de Costo MECANICA (15) when any preventivo is active
  const ccSelect = card.querySelector('.bulk-task-cc');
  if (ccSelect && activePreventivoTypes.size > 0) {
    ccSelect.value = "15";
    updateBulkEmployeeDropdownForCard(card);
  }

  // Refresh insumos grid
  updateBulkInsumosGrid();
}

function compressImageFile(file, maxDimension = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = function(e) {
      const img = new Image();
      img.onerror = reject;
      img.onload = function() {
        let width = img.width;
        let height = img.height;

        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const compressedBase64 = canvas.toDataURL('image/jpeg', quality);
        resolve(compressedBase64);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handlePlanillaOcrUpload(input) {
  const file = input.files[0];
  if (!file) return;

  const overlay = document.getElementById('ai-loading-overlay');
  if (overlay) {
    overlay.style.display = 'flex';
  }

  try {
    // Compress photo on client-side before sending (reduces 15MB -> ~300KB, preventing browser freeze)
    const base64 = await compressImageFile(file, 1600, 0.8);

    const res = await fetch('/api/bulk/parse-planilla', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64 })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP error ${res.status}`);
    }

    const results = await res.json();
    console.log("[OCR Results]", results);

    if (!Array.isArray(results) || results.length === 0) {
      showToast("No se detectaron datos legibles de vehículos en la foto.", "warning");
      return;
    }

    applyOcrResultsToForm(results);

  } catch (err) {
    console.error(err);
    showToast(`Error al escanear la planilla: ${err.message}`, "danger");
  } finally {
    if (overlay) {
      overlay.style.display = 'none';
    }
    input.value = ''; // clear input
  }
}

function applyOcrResultsToForm(results) {
  let checkedCount = 0;
  let hasRefrig = false;
  let hasAcMotor = false;
  let hasCaja = false;
  let hasDif = false;
  let hasHco = false;

  // 1. Mark checkboxes for controlled vehicles
  results.forEach(item => {
    if (!item.interno) return;
    const cleanInterno = String(item.interno).trim();
    if (!item.revisado) return;

    const rodado = cachedCatalogs.rodados.find(r => {
      const dbIntStr = String(r.interno || '').trim();
      if (dbIntStr === cleanInterno) return true;
      const dbIntNum = parseInt(dbIntStr, 10);
      const cleanNum = parseInt(cleanInterno, 10);
      if (!isNaN(dbIntNum) && !isNaN(cleanNum) && dbIntNum === cleanNum) return true;
      return false;
    });

    if (!rodado) {
      console.warn(`[OCR] No se encontró rodado con interno "${cleanInterno}" en catálogo.`);
      return;
    }

    const checkbox = document.querySelector(`#bulk-vehicle-list input[type="checkbox"][value="${rodado.value}"]`);
    if (checkbox) {
      if (!checkbox.checked) {
        checkbox.checked = true;
      }
      checkedCount++;
    }
  });

  if (checkedCount === 0) {
    showToast("No se encontró ningún número de interno coincidente de la planilla en la app.", "warning");
    return;
  }

  // 2. Render badges and generate rows in the insumos grid
  renderSelectedVehicleBadges();
  updateBulkInsumosGrid();

  // 3. Populate row values
  results.forEach(item => {
    if (!item.interno) return;
    const cleanInterno = String(item.interno).trim();
    if (!item.revisado) return;

    const rodado = cachedCatalogs.rodados.find(r => {
      const dbIntStr = String(r.interno || '').trim();
      if (dbIntStr === cleanInterno) return true;
      const dbIntNum = parseInt(dbIntStr, 10);
      const cleanNum = parseInt(cleanInterno, 10);
      if (!isNaN(dbIntNum) && !isNaN(cleanNum) && dbIntNum === cleanNum) return true;
      return false;
    });
    if (!rodado) return;

    // The grid usesinterno as part of id: bulk-row-{interno}
    const interno = String(rodado.interno || '').trim();
    const row = document.getElementById(`bulk-row-${interno}`);
    if (row) {
      const refrigInput = row.querySelector('input[data-insumo="refrigerante"]');
      if (refrigInput && item.refrigerante !== null && item.refrigerante !== undefined && item.refrigerante !== 0 && String(item.refrigerante).toLowerCase().trim() !== 'ok') {
        refrigInput.value = item.refrigerante;
        hasRefrig = true;
      }

      const aceiteInput = row.querySelector('input[data-insumo="aceite_motor"]');
      if (aceiteInput && item.aceite_motor !== null && item.aceite_motor !== undefined && item.aceite_motor !== 0 && String(item.aceite_motor).toLowerCase().trim() !== 'ok') {
        aceiteInput.value = item.aceite_motor;
        hasAcMotor = true;
      }

      const cajaInput = row.querySelector('input[data-insumo="grasa_caja"]');
      if (cajaInput && item.grasa_caja !== null && item.grasa_caja !== undefined && item.grasa_caja !== 0 && String(item.grasa_caja).toLowerCase().trim() !== 'ok') {
        cajaInput.value = item.grasa_caja;
        hasCaja = true;
      }

      const difInput = row.querySelector('input[data-insumo="grasa_diferencial"]');
      if (difInput && item.grasa_diferencial !== null && item.grasa_diferencial !== undefined && item.grasa_diferencial !== 0 && String(item.grasa_diferencial).toLowerCase().trim() !== 'ok') {
        difInput.value = item.grasa_diferencial;
        hasDif = true;
      }

      const hcoInput = row.querySelector('input[data-insumo="hco_direccion"]');
      if (hcoInput && item.hco_direccion !== null && item.hco_direccion !== undefined && item.hco_direccion !== 0 && String(item.hco_direccion).toLowerCase().trim() !== 'ok') {
        hcoInput.value = item.hco_direccion;
        hasHco = true;
      }

      const otrosInput = row.querySelector('input[data-insumo="otros"]');
      if (otrosInput && item.otros) {
        otrosInput.value = item.otros;
      }
    }
  });

  // 4. Update preventivo active types
  activePreventivoTypes.clear();
  if (hasRefrig || hasAcMotor) {
    activePreventivoTypes.add('RM');
  }
  if (hasCaja) {
    activePreventivoTypes.add('C');
  }
  if (hasDif) {
    activePreventivoTypes.add('D');
  }
  if (hasHco) {
    activePreventivoTypes.add('A');
  }

  syncPreventivoButtons();

  // 5. Update combined description in the first task card
  const container = document.getElementById('bulk-tasks-container');
  let cards = container.querySelectorAll('.bulk-task-item-card');
  if (cards.length === 0) {
    addBulkTaskField();
    cards = container.querySelectorAll('.bulk-task-item-card');
  }
  const card = cards[0];
  if (card) {
    const descInput = card.querySelector('.bulk-task-desc');
    if (descInput) {
      const allLines = [];
      ['A', 'RM', 'C', 'D'].forEach(t => {
        if (activePreventivoTypes.has(t)) {
          (PREVENTIVO_LINES[t] || []).forEach(line => {
            if (!allLines.includes(line)) allLines.push(line);
          });
        }
      });
      descInput.value = allLines.join('\n');
    }

    // Set MECANICA cost center
    const ccSelect = card.querySelector('.bulk-task-cc');
    if (ccSelect) {
      ccSelect.value = "15";
      updateBulkEmployeeDropdownForCard(card);
    }
  }

  // 6. Refresh grilla visibility and columns since description & active types updated
  updateBulkInsumosGrid();
  
  // 7. Update count badge & summary totals
  const selectedCount = document.querySelectorAll('#bulk-vehicle-list input[type="checkbox"]:checked').length;
  const badge = document.getElementById('bulk-selected-count');
  if (badge) {
    badge.textContent = `${selectedCount} seleccionado${selectedCount === 1 ? '' : 's'}`;
  }
  updateBulkSummary();

  showToast(`Planilla escaneada exitosamente: ${checkedCount} camiones cargados.`, "success");
}

function setupAllFieldsForSector() {
  const currentUser = localStorage.getItem('currentUserUsername');
  const userSector = getSectorByUsername(currentUser);
  const preClasif = document.getElementById('pre-form-clasificacion') ? document.getElementById('pre-form-clasificacion').value : '';
  const formClasif = document.getElementById('form-clasificacion') ? document.getElementById('form-clasificacion').value : '';
  const isHerreria = (userSector === 'Herrería' || currentSelectedSector === 'Herrería' || preClasif === 'Herrería' || formClasif === 'Herrería');
  const isEdilicio = (userSector === 'Edilicio' || currentSelectedSector === 'Edilicio' || preClasif === 'Edilicio' || formClasif === 'Edilicio');

  // 1. Main modal: Rodado
  const rodadoSelectGroup = document.getElementById('form-rodado-group-select');
  const rodadoTextGroup = document.getElementById('form-rodado-group-text');
  const rodadoSelect = document.getElementById('form-rodado');
  const rodadoText = document.getElementById('form-rodado-text');

  if (rodadoSelectGroup) rodadoSelectGroup.style.display = 'block';
  if (rodadoTextGroup) rodadoTextGroup.style.display = 'none';
  if (rodadoSelect) rodadoSelect.setAttribute('required', 'true');
  if (rodadoText) rodadoText.removeAttribute('required');

  // 1.5 Edilicio isn't about vehicles: restrict Rodado to the known buildings/properties
  // catalog entries (modelo "Mantenimiento Edilicio"). Preserves whatever is currently
  // selected across the repopulation so editing an existing order doesn't lose its value.
  if (rodadoSelect) {
    const currentRodadoValue = rodadoSelect.value;
    const rodadoOptionsList = isEdilicio
      ? (cachedCatalogs.rodados || []).filter(r => String(r.modelo || '').trim() === 'Mantenimiento Edilicio').map(r => ({ value: r.value, label: r.interno }))
      : (cachedCatalogs.rodados || []);
    populateSelect('form-rodado', rodadoOptionsList, "Seleccionar Rodado...");
    if (currentRodadoValue) {
      const stillExists = Array.from(rodadoSelect.options).some(opt => opt.value === currentRodadoValue);
      if (!stillExists) {
        const customOpt = document.createElement('option');
        customOpt.value = currentRodadoValue;
        customOpt.textContent = currentRodadoValue;
        rodadoSelect.appendChild(customOpt);
      }
      rodadoSelect.value = currentRodadoValue;
    }
    if (rodadoSelect.rebuildSearchable) rodadoSelect.rebuildSearchable();
  }

  // 2. Pre-order modal ("Filtro de Unidad y Tipo"): Interno ALWAYS uses the searchable dropdown list
  const preInternoSelectGroup = document.getElementById('pre-form-interno-group-select');
  const preInternoTextGroup = document.getElementById('pre-form-interno-group-text');
  const preInternoSelect = document.getElementById('pre-form-interno');
  const preInternoText = document.getElementById('pre-form-interno-text');

  if (preInternoSelectGroup) preInternoSelectGroup.style.display = 'block';
  if (preInternoTextGroup) preInternoTextGroup.style.display = 'none';
  if (preInternoSelect) preInternoSelect.setAttribute('required', 'true');
  if (preInternoText) preInternoText.removeAttribute('required');

  // Same Edilicio restriction as Rodado above, applied to this modal's own unit picker.
  if (preInternoSelect) {
    const currentPreInternoValue = preInternoSelect.value;
    const preInternoOptionsList = isEdilicio
      ? (cachedCatalogs.rodados || []).filter(r => String(r.modelo || '').trim() === 'Mantenimiento Edilicio').map(r => ({ value: r.interno, label: r.interno }))
      : cachedInternoOptions;
    populateSelect('pre-form-interno', preInternoOptionsList, "Seleccionar Rodado...");
    if (currentPreInternoValue) {
      const stillExists = Array.from(preInternoSelect.options).some(opt => opt.value === currentPreInternoValue);
      if (stillExists) preInternoSelect.value = currentPreInternoValue;
    }
    if (preInternoSelect.rebuildSearchable) preInternoSelect.rebuildSearchable();
  }

  // 3. Main modal ("Datos Generales"): this slot shows exactly one of three mutually
  // exclusive controls - the plain Interno select (Taller), a free-text Interno box
  // (Herrería, which has no building-catalog shortcut), or the Área/Sector dropdown
  // (Edilicio). Edilicio's own Rodado already IS the building/interno, so there's nothing
  // left to type here - the área fills this slot instead, and is what feeds Taxes'
  // "Interno de la Unidad" at sync time (see syncWorker.js).
  const internoSelectGroup = document.getElementById('form-interno-group-select');
  const internoTextGroup = document.getElementById('form-interno-group-text');
  const internoSelect = document.getElementById('form-interno');
  const internoText = document.getElementById('form-interno-text');
  const areaGroup = document.getElementById('form-area-edilicio-group');
  const areaSelect = document.getElementById('form-area-edilicio');
  const areaNewRow = document.getElementById('form-area-edilicio-new-row');

  if (isEdilicio) {
    if (internoSelectGroup) internoSelectGroup.style.display = 'none';
    if (internoTextGroup) internoTextGroup.style.display = 'none';
    if (internoSelect) internoSelect.removeAttribute('required');
    if (internoText) internoText.removeAttribute('required');
    if (areaGroup) areaGroup.style.display = 'block';
    if (areaSelect) areaSelect.setAttribute('required', 'true');
    populateAreaEdilicioSelect();
  } else if (isHerreria) {
    if (internoSelectGroup) internoSelectGroup.style.display = 'none';
    if (internoTextGroup) internoTextGroup.style.display = 'block';
    if (internoSelect) internoSelect.removeAttribute('required');
    if (internoText) internoText.setAttribute('required', 'true');
    if (areaGroup) areaGroup.style.display = 'none';
    if (areaSelect) areaSelect.removeAttribute('required');
    if (areaNewRow) areaNewRow.style.display = 'none';
  } else {
    if (internoSelectGroup) internoSelectGroup.style.display = 'block';
    if (internoTextGroup) internoTextGroup.style.display = 'none';
    if (internoSelect) internoSelect.setAttribute('required', 'true');
    if (internoText) internoText.removeAttribute('required');
    if (areaGroup) areaGroup.style.display = 'none';
    if (areaSelect) areaSelect.removeAttribute('required');
    if (areaNewRow) areaNewRow.style.display = 'none';
  }
}


// ============================================================
// PREVENTIVOS MODULE
// ============================================================

let prevFlotaData = [];
let prevCombustibleData = [];
let fuelAlertFilter = 'all'; // 'all' | 'ok' | 'alerta'
let prevAlertas = [];
let prevHistorial = [];
let prevCurrentFilter = 'all';
let prevCurrentServiceRow = null; // { rowIndex, interno, modelo }
let prevCurrentCombustibleRow = null;
let currentCombustibleReset = null;

function switchPrevSubTab(tab) {
  document.querySelectorAll('.preventivos-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.prev-subview').forEach(v => v.style.display = 'none');
  const tabEl = document.getElementById(`prev-subview-${tab}`);
  if (tabEl) tabEl.style.display = 'block';
  // Mark active button
  document.querySelectorAll('.preventivos-tab-btn').forEach(btn => {
    const onc = btn.getAttribute('onclick');
    if (onc && onc.includes(`'${tab}'`)) {
      btn.classList.add('active');
    }
  });
  // Load data for the tab
  if (tab === 'dashboard') {
    fetchPreventivoFlota();
  } else if (tab === 'combustible') {
    fetchPrevCombustible();
  } else if (tab === 'livianas') {
    fetchPrevLivianas();
  } else if (tab === 'alarmas') {
    fetchPrevAlertas();
  } else if (tab === 'historial') {
    fetchPrevHistorial();
  }
}

function applyPrevFilters() {
  renderPrevFlotaTable();
  if (typeof renderPrevLivianasTable === 'function') renderPrevLivianasTable();
}

function filterByAlertState(state) {
  prevCurrentFilter = state;
  renderPrevFlotaTable();
  // Auto-scroll to the internos list on mobile
  if (state !== 'all') {
    setTimeout(() => {
      const cardsList = document.getElementById('prev-dashboard-cards');
      if (cardsList) cardsList.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }
}

async function fetchPreventivoFlota() {
  try {
    document.getElementById('prev-dashboard-tbody').innerHTML =
      '<tr><td colspan="7" style="text-align:center; padding:20px;"><span class="material-icons" style="animation:spin 1.5s linear infinite; vertical-align:middle;">sync</span> Cargando datos de Google Sheets...</td></tr>';
    const res = await fetch(`/api/preventivos/flota?_=${Date.now()}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const rawData = await res.json();
    prevFlotaData = Array.isArray(rawData) ? rawData : (JSON.parse(rawData) || []);
    renderPrevFlotaTable();
  } catch (error) {
    console.error('Error fetching preventivos flota:', error);
    document.getElementById('prev-dashboard-tbody').innerHTML =
      `<tr><td colspan="7" style="text-align:center; padding:20px; color:var(--danger);">Error: ${error.message}. Configure la URL del script en Ajustes.</td></tr>`;
  }
}

function renderPrevFlotaTable() {
  const tbody = document.getElementById('prev-dashboard-tbody');
  const cards = document.getElementById('prev-dashboard-cards');
  if (!tbody) return;

  const searchTerm = (document.getElementById('prev-search-input')?.value || '').toLowerCase();

  let urgentes = 0;
  let filtered = prevFlotaData.filter(item => {
    const alerta = String(item.alerta || '').toLowerCase();
    const isUrgente = alerta.includes('realizar') || alerta.includes('urgente') || alerta.includes('service');
    if (isUrgente) urgentes++;
    const matchSearch = String(item.interno).toLowerCase().includes(searchTerm) ||
                        String(item.modelo).toLowerCase().includes(searchTerm);
    if (!matchSearch) return false;
    if (prevCurrentFilter === 'ok') return !isUrgente;
    if (prevCurrentFilter === 'urgente') return isUrgente;
    return true;
  });

  const total = prevFlotaData.length;
  const el = id => document.getElementById(id);
  if (el('metric-total')) el('metric-total').textContent = total;
  if (el('metric-urgente')) el('metric-urgente').textContent = urgentes;
  if (el('metric-ok')) el('metric-ok').textContent = total - urgentes;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px; color:var(--text-muted);">No se encontraron unidades.</td></tr>';
    if (cards) cards.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:20px;">No se encontraron unidades.</div>';
    return;
  }

  // Build lookup map for safe onclick usage (avoids string escaping issues)
  window._prevFlotaMap = {};
  filtered.forEach(item => { window._prevFlotaMap[item.originalRowIndex] = item; });

  tbody.innerHTML = filtered.map(item => {
    const alerta = String(item.alerta || '');
    const isUrgente = alerta.toLowerCase().includes('realizar') || alerta.toLowerCase().includes('urgente') || alerta.toLowerCase().includes('service');
    const badgeClass = isUrgente ? 'warning' : 'ok';
    const badgeText = isUrgente ? '⚠ Realizar Service' : '✓ Al Día';
    const km = item.kmReales ? Number(item.kmReales).toLocaleString('es-AR') : 0;
    const hs = item.hsReales ? Number(item.hsReales).toLocaleString('es-AR') : 0;
    const rawRest = item.restante !== undefined && item.restante !== null ? item.restante : item.faltante;
    const rest = typeof rawRest === 'number' ? rawRest.toLocaleString('es-AR') : String(rawRest || 0).replace('Hs', '').replace('km', '').trim();
    const ri = item.originalRowIndex;
    return `<tr>
      <td><strong>${item.interno}</strong></td>
      <td>${item.modelo}</td>
      <td>${km}</td>
      <td>${hs}</td>
      <td>${rest}</td>
      <td><span class="badge-prev ${badgeClass}">${badgeText}</span></td>
      <td style="text-align:right;">
        <div style="display:inline-flex; gap:6px;">
          <button class="btn btn-secondary btn-xs" onclick="prevFlotaOpenService(${ri})" style="display:inline-flex; align-items:center; gap:2px;">
            <span class="material-icons" style="font-size:13px;">build</span> Service
          </button>
          <button class="btn btn-xs" onclick="prevFlotaOpenOdometer(${ri})" style="display:inline-flex; align-items:center; gap:2px; background-color: #0288d1; color: white; border-color: #0288d1;">
            <span class="material-icons" style="font-size:13px;">edit</span> Actualizar
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');

  if (cards) {
    cards.innerHTML = filtered.map(item => {
      const alerta = String(item.alerta || '');
      const isUrgente = alerta.toLowerCase().includes('realizar') || alerta.toLowerCase().includes('urgente') || alerta.toLowerCase().includes('service');
      const badgeClass = isUrgente ? 'warning' : 'ok';
      const badgeText = isUrgente ? '⚠ Realizar Service' : '✓ Al Día';
      const ri = item.originalRowIndex;
      const rawCardRest = item.restante !== undefined && item.restante !== null ? item.restante : item.faltante;
      const cardRest = typeof rawCardRest === 'number' ? rawCardRest.toLocaleString('es-AR') : String(rawCardRest || 0).replace('Hs', '').replace('km', '').trim();

      return `<div class="prev-mobile-card">
        <div class="prev-mobile-card-header">
          <div><strong style="font-size:16px;">${item.interno}</strong><br><span style="font-size:12px; color:var(--text-muted);">${item.modelo}</span></div>
          <span class="badge-prev ${badgeClass}">${badgeText}</span>
        </div>
        <div class="prev-mobile-card-row"><span>KM Reales</span><strong>${Number(item.kmReales || 0).toLocaleString('es-AR')}</strong></div>
        <div class="prev-mobile-card-row"><span>Hs Reales</span><strong>${Number(item.hsReales || 0).toLocaleString('es-AR')}</strong></div>
        <div class="prev-mobile-card-row"><span>Restante</span><strong>${cardRest}</strong></div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="btn btn-secondary btn-sm" onclick="prevFlotaOpenService(${ri})" style="flex:1; display:flex; justify-content:center; align-items:center; gap:4px;">
            <span class="material-icons" style="font-size:14px;">build</span> Service
          </button>
          <button class="btn btn-sm" onclick="prevFlotaOpenOdometer(${ri})" style="flex:1; display:flex; justify-content:center; align-items:center; gap:4px; background-color: #0288d1; color: white; border-color: #0288d1;">
            <span class="material-icons" style="font-size:14px;">edit</span> Actualizar
          </button>
        </div>
      </div>`;
    }).join('');
  }
}

// Safe wrappers — look up item from map to avoid string escaping in onclick attrs
function prevFlotaOpenService(ri) {
  const item = window._prevFlotaMap && window._prevFlotaMap[ri];
  if (!item) return;
  openPrevServiceModal(item.originalRowIndex, item.interno, item.modelo, item.kmReales || 0, item.hsReales || 0);
}
function prevFlotaOpenOdometer(ri) {
  const item = window._prevFlotaMap && window._prevFlotaMap[ri];
  if (!item) return;
  const isHs = item.unidadMedida === 'hs' || String(item.serviFreq || '').toLowerCase().includes('hs') || String(item.modelo || '').toLowerCase().includes('iveco');
  const currentVal = isHs ? (item.hsReales || item.kmReales || 0) : (item.kmReales || 0);
  openPrevOdometerModal(item.originalRowIndex, item.interno, item.modelo, isHs ? 0 : currentVal, isHs ? currentVal : 0, isHs);
}

async function fetchPrevCombustible() {
  try {
    const res = await fetch('/api/preventivos/combustible');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rawData = await res.json();
    prevCombustibleData = Array.isArray(rawData) ? rawData : (JSON.parse(rawData) || []);
    renderPrevCombustibleTable();
  } catch (error) {
    console.error('Error fetching combustible:', error);
    document.getElementById('prev-combustible-tbody').innerHTML =
      `<tr><td colspan="9" style="text-align:center; padding:20px; color:var(--danger);">Error: ${error.message}</td></tr>`;
  }
}

function renderPrevCombustibleTable() {
  const tbody = document.getElementById('prev-combustible-tbody');
  if (!tbody) return;
  if (!prevCombustibleData || prevCombustibleData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:20px;">Haz clic en "Procesar Combustible de Planilla" para cargar los datos.</td></tr>';
    // Reset metric cards
    document.getElementById('fuel-metric-total').textContent = '0';
    document.getElementById('fuel-metric-ok').textContent = '0';
    document.getElementById('fuel-metric-alerta').textContent = '0';
    return;
  }
  const searchTerm = (document.getElementById('prev-search-input')?.value || '').toLowerCase();

  // Classify each item
  const classified = prevCombustibleData.map(item => {
    const a5 = String(item.alerta5k || '').toLowerCase();
    const a10 = String(item.alerta10k || '').toLowerCase();
    const hasAlert = ['realizar', 'urgente', 'service'].some(w => a5.includes(w) || a10.includes(w));
    return { ...item, hasAlert };
  });

  // Update metric cards
  const total = classified.length;
  const alertaCount = classified.filter(i => i.hasAlert).length;
  const okCount = total - alertaCount;
  document.getElementById('fuel-metric-total').textContent = total;
  document.getElementById('fuel-metric-ok').textContent = okCount;
  document.getElementById('fuel-metric-alerta').textContent = alertaCount;
  updateDashboardStats();

  // Apply alert filter + search
  const filtered = classified.filter(item => {
    const matchSearch = String(item.interno).toLowerCase().includes(searchTerm) ||
                        String(item.modelo).toLowerCase().includes(searchTerm);
    const matchFilter = fuelAlertFilter === 'all' ||
                        (fuelAlertFilter === 'ok' && !item.hasAlert) ||
                        (fuelAlertFilter === 'alerta' && item.hasAlert);
    return matchSearch && matchFilter;
  });

  tbody.innerHTML = filtered.length === 0
    ? '<tr><td colspan="9" style="text-align:center; padding:20px; color:var(--text-muted);">No hay unidades que coincidan con el filtro.</td></tr>'
    : filtered.map(item => {
        const a5 = String(item.alerta5k || '');
        const a10 = String(item.alerta10k || '');
        const bad5 = ['realizar', 'urgente', 'service'].some(w => a5.toLowerCase().includes(w));
        const bad10 = ['realizar', 'urgente', 'service'].some(w => a10.toLowerCase().includes(w));
        return `<tr>
          <td><strong>${item.interno}</strong></td>
          <td>${item.modelo}</td>
          <td>${Number(item.litrosTotales || 0).toLocaleString('es-AR')}</td>
          <td>${Number(item.restante5k || 0).toLocaleString('es-AR')}</td>
          <td><span class="badge-prev ${bad5 ? 'warning' : 'ok'}">${item.alerta5k || '—'}</span></td>
          <td>${Number(item.restante10k || 0).toLocaleString('es-AR')}</td>
          <td><span class="badge-prev ${bad10 ? 'warning' : 'ok'}">${item.alerta10k || '—'}</span></td>
          <td>${item.lastService || '—'}</td>
          <td style="text-align:right;">
            <button class="btn btn-secondary btn-xs" onclick="openPrevCombustibleModal(${item.originalRowIndex}, '${item.interno}', '${a5.replace(/'/g, "\\'")}', '${a10.replace(/'/g, "\\'")}', ${item.litrosTotales || 0})" style="display:inline-flex; align-items:center; gap:2px;">
              <span class="material-icons" style="font-size:13px;">local_gas_station</span> Service
            </button>
          </td>
        </tr>`;
      }).join('');

  // Mobile cards
  const mobileCards = document.getElementById('prev-combustible-cards');
  if (mobileCards) {
    if (filtered.length === 0) {
      mobileCards.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">No hay unidades que coincidan.</div>';
    } else {
      mobileCards.innerHTML = filtered.map(item => {
        const a5 = String(item.alerta5k || '');
        const a10 = String(item.alerta10k || '');
        const hasAlert5 = ['realizar','urgente','service'].some(w => a5.toLowerCase().includes(w));
        const hasAlert10 = ['realizar','urgente','service'].some(w => a10.toLowerCase().includes(w));
        const hasAlert = hasAlert5 || hasAlert10;
        const ri = item.originalRowIndex;
        const a5Safe = a5.replace(/'/g,"\\'").replace(/"/g,'&quot;');
        const a10Safe = a10.replace(/'/g,"\\'").replace(/"/g,'&quot;');
        return `<div class="prev-mobile-card">
          <div class="prev-mobile-card-header">
            <div><strong style="font-size:16px;">${item.interno}</strong><br><span style="font-size:12px;color:var(--text-muted);">${item.modelo}</span></div>
            <span class="badge-prev ${hasAlert ? 'warning' : 'ok'}">${hasAlert ? '⚠ Con Alerta' : '✓ Al Día'}</span>
          </div>
          <div class="prev-mobile-card-row"><span>Litros Totales</span><strong>${Number(item.litrosTotales||0).toLocaleString('es-AR')}</strong></div>
          <div class="prev-mobile-card-row"><span>Alerta 5k</span><strong style="color:${hasAlert5?'#ef4444':'#10b981'}">${item.alerta5k||'—'}</strong></div>
          <div class="prev-mobile-card-row"><span>Alerta 10k</span><strong style="color:${hasAlert10?'#ef4444':'#10b981'}">${item.alerta10k||'—'}</strong></div>
          <div class="prev-mobile-card-row"><span>Último Service</span><strong>${item.lastService||'—'}</strong></div>
          <div style="margin-top:8px;">
            <button class="btn btn-secondary btn-sm" onclick="openPrevCombustibleModal(${ri},'${item.interno}','${a5Safe}','${a10Safe}',${item.litrosTotales||0})" style="width:100%;display:flex;justify-content:center;align-items:center;gap:4px;">
              <span class="material-icons" style="font-size:14px;">local_gas_station</span> Service
            </button>
          </div>
        </div>`;
      }).join('');
    }
  }
}

function filterCombustibleByAlert(state) {
  fuelAlertFilter = state;
  renderPrevCombustibleTable();
  // Auto-scroll to internos list on mobile
  if (state !== 'all') {
    setTimeout(() => {
      const cardsList = document.getElementById('prev-combustible-cards');
      if (cardsList) cardsList.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }
}

// --- UNIDADES LIVIANAS PREVENTIVOS ---
let prevLivianasData = [];
let prevLivianasFilter = 'all';

async function fetchPrevLivianas() {
  try {
    const tbody = document.getElementById('prev-livianas-tbody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:20px;"><span class="material-icons" style="animation:spin 1.5s linear infinite; vertical-align:middle;">sync</span> Cargando Unidades Livianas desde Google Sheets...</td></tr>';
    }
    const res = await fetch(`/api/preventivos/livianas?_=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rawData = await res.json();
    prevLivianasData = Array.isArray(rawData) ? rawData : [];
    renderPrevLivianasTable();
  } catch (error) {
    console.error('Error fetching livianas:', error);
    const tbody = document.getElementById('prev-livianas-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:20px; color:var(--danger);">Error: ${error.message}</td></tr>`;
    }
  }
}

function filterLivianasByAlert(state) {
  prevLivianasFilter = state;
  renderPrevLivianasTable();
  if (state !== 'all') {
    setTimeout(() => {
      const cardsList = document.getElementById('prev-livianas-cards');
      if (cardsList) cardsList.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }
}

function renderPrevLivianasTable() {
  const tbody = document.getElementById('prev-livianas-tbody');
  const cards = document.getElementById('prev-livianas-cards');
  if (!tbody) return;

  const searchTerm = (document.getElementById('prev-search-input')?.value || '').toLowerCase().trim();

  let urgentes = 0;
  let filtered = prevLivianasData.filter(item => {
    const alerta = String(item.alerta || '').toLowerCase();
    const isUrgente = alerta.includes('realizar') || alerta.includes('urgente') || alerta.includes('service');
    if (isUrgente) urgentes++;

    const matchSearch = !searchTerm ||
      String(item.interno || '').toLowerCase().includes(searchTerm) ||
      String(item.modelo || '').toLowerCase().includes(searchTerm) ||
      String(item.sector || '').toLowerCase().includes(searchTerm);

    if (!matchSearch) return false;
    if (prevLivianasFilter === 'ok') return !isUrgente;
    if (prevLivianasFilter === 'urgente') return isUrgente;
    return true;
  });

  const total = prevLivianasData.length;
  const el = id => document.getElementById(id);
  if (el('livianas-metric-total')) el('livianas-metric-total').textContent = total;
  if (el('livianas-metric-urgente')) el('livianas-metric-urgente').textContent = urgentes;
  if (el('livianas-metric-ok')) el('livianas-metric-ok').textContent = total - urgentes;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:20px; color:var(--text-muted);">No se encontraron unidades livianas.</td></tr>';
    if (cards) cards.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:20px;">No se encontraron unidades livianas.</div>';
    return;
  }

  window._prevLivianasMap = {};
  filtered.forEach(item => { window._prevLivianasMap[item.originalRowIndex] = item; });

  tbody.innerHTML = filtered.map(item => {
    const alerta = String(item.alerta || '');
    const isUrgente = alerta.toLowerCase().includes('realizar') || alerta.toLowerCase().includes('urgente') || alerta.toLowerCase().includes('service');
    const badgeClass = isUrgente ? 'warning' : 'ok';
    const badgeText = isUrgente ? '⚠ Realizar Service' : '✓ Al Día';
    const isHs = item.unidadMedida === 'hs' || String(item.serviFreq || '').toLowerCase().includes('hs');
    const kmHsVal = isHs ? (item.hsReales || item.kmReales || 0) : (item.kmReales || 0);
    const kmHsStr = Number(kmHsVal).toLocaleString('es-AR') + (isHs ? ' Hs' : ' km');
    const ri = item.originalRowIndex;

    return `<tr>
      <td><strong style="color:var(--primary); font-size:15px;">${item.interno}</strong></td>
      <td>${item.modelo || ''}</td>
      <td><span class="badge" style="background:#f1f5f9; color:#475569; font-weight:600;">${item.sector || 'TALLER'}</span></td>
      <td>${item.serviFreq || '-'}</td>
      <td><strong>${kmHsStr}</strong></td>
      <td style="color:${isUrgente ? 'var(--danger)' : 'var(--text-color)'}; font-weight:${isUrgente ? 'bold' : 'normal'};">${item.faltante || '-'}</td>
      <td><span class="badge-prev ${badgeClass}">${badgeText}</span></td>
      <td style="text-align:right;">
        <div style="display:inline-flex; gap:6px;">
          <button class="btn btn-secondary btn-xs" onclick="prevLivianasOpenService(${ri})" style="display:inline-flex; align-items:center; gap:2px;" title="Generar Orden de Trabajo y registrar Service">
            <span class="material-icons" style="font-size:13px;">build</span> Servi / OT
          </button>
          <button class="btn btn-xs" onclick="prevLivianasOpenOdometer(${ri})" style="display:inline-flex; align-items:center; gap:2px; background-color: #0288d1; color: white; border-color: #0288d1;" title="Actualizar lectura Horas / Km">
            <span class="material-icons" style="font-size:13px;">edit</span> Actualizar
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');

  if (cards) {
    cards.innerHTML = filtered.map(item => {
      const alerta = String(item.alerta || '');
      const isUrgente = alerta.toLowerCase().includes('realizar') || alerta.toLowerCase().includes('urgente') || alerta.toLowerCase().includes('service');
      const badgeClass = isUrgente ? 'warning' : 'ok';
      const badgeText = isUrgente ? '⚠ Realizar Service' : '✓ Al Día';
      const isHs = item.unidadMedida === 'hs' || String(item.serviFreq || '').toLowerCase().includes('hs');
      const kmHsVal = isHs ? (item.hsReales || item.kmReales || 0) : (item.kmReales || 0);
      const kmHsStr = Number(kmHsVal).toLocaleString('es-AR') + (isHs ? ' Hs' : ' km');
      const ri = item.originalRowIndex;

      return `<div class="prev-mobile-card">
        <div class="prev-mobile-card-header">
          <div>
            <strong style="font-size:16px; color:var(--primary);">${item.interno}</strong>
            <br><span style="font-size:12px; color:var(--text-muted);">${item.modelo || ''} (${item.sector || 'TALLER'})</span>
          </div>
          <span class="badge-prev ${badgeClass}">${badgeText}</span>
        </div>
        <div class="prev-mobile-card-row"><span>Frecuencia</span><strong>${item.serviFreq || '-'}</strong></div>
        <div class="prev-mobile-card-row"><span>Lectura Actual</span><strong>${kmHsStr}</strong></div>
        <div class="prev-mobile-card-row"><span>Faltante</span><strong>${item.faltante || '-'}</strong></div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="btn btn-secondary btn-sm" onclick="prevLivianasOpenService(${ri})" style="flex:1; display:flex; justify-content:center; align-items:center; gap:4px;">
            <span class="material-icons" style="font-size:14px;">build</span> Servi / OT
          </button>
          <button class="btn btn-sm" onclick="prevLivianasOpenOdometer(${ri})" style="flex:1; display:flex; justify-content:center; align-items:center; gap:4px; background-color: #0288d1; color: white; border-color: #0288d1;">
            <span class="material-icons" style="font-size:14px;">edit</span> Actualizar
          </button>
        </div>
      </div>`;
    }).join('');
  }
}

function prevLivianasOpenService(ri) {
  const item = window._prevLivianasMap && window._prevLivianasMap[ri];
  if (!item) return;
  const isHs = item.unidadMedida === 'hs' || String(item.serviFreq || '').toLowerCase().includes('hs');
  openPrevServiceModal(item.originalRowIndex, item.interno, item.modelo, isHs ? 0 : (item.kmReales || 0), isHs ? (item.hsReales || item.kmReales || 0) : 0);
}

function prevLivianasOpenOdometer(ri) {
  const item = window._prevLivianasMap && window._prevLivianasMap[ri];
  if (!item) return;
  const isHs = item.unidadMedida === 'hs' || String(item.serviFreq || '').toLowerCase().includes('hs');
  openPrevOdometerModal(item.originalRowIndex, item.interno, item.modelo, isHs ? 0 : (item.kmReales || 0), isHs ? (item.hsReales || item.kmReales || 0) : 0);
}

async function fetchPrevHistorial() {
  try {
    const res = await fetch('/api/preventivos/historial');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rawData = await res.json();
    prevHistorial = Array.isArray(rawData) ? rawData : (JSON.parse(rawData) || []);
    renderPrevHistorialTable();
  } catch (error) {
    console.error('Error fetching historial:', error);
    document.getElementById('prev-historial-tbody').innerHTML =
      `<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--danger);">Error: ${error.message}</td></tr>`;
  }
}

function renderPrevHistorialTable() {
  const tbody = document.getElementById('prev-historial-tbody');
  if (!tbody) return;
  if (!prevHistorial || prevHistorial.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px;">No hay historial disponible.</td></tr>';
    return;
  }
  const searchTerm = (document.getElementById('prev-search-input')?.value || '').toLowerCase();
  const filtered = prevHistorial.filter(item =>
    String(item.interno || '').toLowerCase().includes(searchTerm) ||
    String(item.tipo || '').toLowerCase().includes(searchTerm)
  );
  tbody.innerHTML = filtered.map(item => `<tr>
    <td>${item.fecha || '—'}</td>
    <td><strong>${item.interno || '—'}</strong></td>
    <td><span class="badge-service-type">${item.tipo || 'KM/HS'}</span></td>
    <td>${item.datos || '—'}</td>
    <td>${item.conductor || '—'}</td>
    <td>${item.month ? 'Mes ' + item.month : '—'}</td>
  </tr>`).join('');
}

async function fetchPrevAlertas() {
  try {
    const res = await fetch('/api/preventivos/alertas');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rawData = await res.json();
    prevAlertas = Array.isArray(rawData) ? rawData : (JSON.parse(rawData) || []);
    renderPrevAlermasTable();
  } catch (error) {
    console.error('Error fetching alertas:', error);
    document.getElementById('prev-alarmas-tbody').innerHTML =
      `<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--danger);">Error: ${error.message}</td></tr>`;
  }
}

function renderPrevAlermasTable() {
  const tbody = document.getElementById('prev-alarmas-tbody');
  if (!tbody) return;
  if (!prevAlertas || prevAlertas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px;">No hay alertas registradas.</td></tr>';
    return;
  }
  tbody.innerHTML = prevAlertas.map(item => {
    const esPendiente = item.estado === 'Pendiente';
    return `<tr>
      <td><strong>${item.interno || '—'}</strong></td>
      <td>${item.tipo || '—'}</td>
      <td><span class="badge-prev ${esPendiente ? 'warning' : 'ok'}">${item.estado || '—'}</span></td>
      <td>${item.fechaAlerta || '—'}</td>
      <td>${item.fechaRealizado || '—'}</td>
      <td>${item.demora !== undefined && item.demora !== '' ? item.demora : '—'}</td>
    </tr>`;
  }).join('');
}

// Modal KM/HS Service
function openPrevServiceModal(rowIndex, interno, modelo, km, hs) {
  // Iveco = horas | Volkswagen (y otros) = km
  const isIveco = String(modelo || '').toLowerCase().includes('iveco');
  prevCurrentServiceRow = {
    rowIndex,
    interno,
    modelo,
    vehicleType: isIveco ? 'iveco' : 'km'
  };
  document.getElementById('prev-service-modal-interno').textContent = `${interno} — ${modelo}`;
  // Show/hide the relevant field and pre-fill
  const kmGroup = document.getElementById('prev-service-modal-km-group');
  const hsGroup = document.getElementById('prev-service-modal-hs-group');
  if (kmGroup) kmGroup.style.display = isIveco ? 'none' : 'block';
  if (hsGroup) hsGroup.style.display = isIveco ? 'block' : 'none';
  document.getElementById('prev-service-modal-km').value = isIveco ? '' : (km || '');
  document.getElementById('prev-service-modal-hs').value = isIveco ? (hs || '') : '';
  document.getElementById('prev-service-modal').classList.add('open');
  // Focus the visible field
  setTimeout(() => {
    const focusEl = isIveco
      ? document.getElementById('prev-service-modal-hs')
      : document.getElementById('prev-service-modal-km');
    if (focusEl) focusEl.focus();
  }, 100);
}

function closePrevServiceModal() {
  document.getElementById('prev-service-modal').classList.remove('open');
  prevCurrentServiceRow = null;
}

async function savePrevService() {
  if (!prevCurrentServiceRow) return;
  const isIveco = prevCurrentServiceRow.vehicleType === 'iveco';
  const km = isIveco ? '' : document.getElementById('prev-service-modal-km').value.trim();
  const hs = isIveco ? document.getElementById('prev-service-modal-hs').value.trim() : '';
  const valorStr = isIveco ? hs : km;
  if (!valorStr) {
    showToast(`Ingresá ${isIveco ? 'las Horas' : 'los Km'} para registrar el service.`, 'warning');
    return;
  }
  const btn = document.getElementById('btn-save-prev-service');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-icons" style="animation:spin 1.5s linear infinite; font-size:16px; vertical-align:middle;">sync</span> Guardando...';
  try {
    // 1. Update Google Sheets service (resets interval + updates reales)
    const res = await fetch('/api/preventivos/service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rowIndex: prevCurrentServiceRow.rowIndex,
        km,
        hs,
        interno: prevCurrentServiceRow.interno,
        vehicleType: isIveco ? 'iveco' : ''
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    // 2. Create Work Order (no tasks)
    const incidente = isIveco
      ? `Servicio de la unidad a las ${hs} hs`
      : `Servicio de la Unidad a los ${km} Km`;

    const currentUser = localStorage.getItem('currentUserUsername') || '';
    const rodadoOpt = cachedCatalogs.rodados
      ? cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === String(prevCurrentServiceRow.interno).trim())
      : null;
    const rodadoVal = rodadoOpt ? rodadoOpt.value : '';

    const orderPayload = {
      rodado: rodadoVal,
      responsable: currentUser,
      fechaEntrega: '',
      horario: '',
      interno: String(prevCurrentServiceRow.interno),
      clasificacion: 'Preventivo',
      incidente: incidente,
      tasks: [],
      estadoUnidad: 'fuera_de_servicio',
      createdBy: currentUser
    };

    const orderRes = await fetch('/api/orders', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-user-username': currentUser || ''
      },
      body: JSON.stringify(orderPayload)
    });
    if (!orderRes.ok) {
      const oe = await orderRes.json().catch(() => ({}));
      console.warn('Orden creada con advertencia:', oe.error);
    }

    showToast(`Service registrado y Orden creada para Interno ${prevCurrentServiceRow.interno} ✓`, 'success');
    closePrevServiceModal();
    await fetchPreventivoFlota();
    // Refresh orders list in background
    if (typeof fetchOrders === 'function') fetchOrders();
  } catch (error) {
    showToast(`Error al guardar service: ${error.message}`, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Guardar Service';
  }
}

// Modal KM/HS Actualizar Odometer
let prevCurrentOdometerRow = null;
function openPrevOdometerModal(rowIndex, interno, modelo, km, hs, forceHs = false) {
  const isIveco = String(modelo || '').toLowerCase().includes('iveco');
  const isHs = forceHs || isIveco || Boolean(hs && !km);
  prevCurrentOdometerRow = { rowIndex, interno, modelo, vehicleType: isHs ? 'iveco' : 'km', isHs };
  
  const labelEl = document.getElementById('prev-odometer-modal-interno');
  if (labelEl) labelEl.textContent = `${interno} — ${modelo || 'Unidad'}`;

  const kmGroup = document.getElementById('prev-odometer-modal-km-group');
  const hsGroup = document.getElementById('prev-odometer-modal-hs-group');

  if (kmGroup) kmGroup.style.display = isHs ? 'none' : 'block';
  if (hsGroup) hsGroup.style.display = isHs ? 'block' : 'none';

  const kmInput = document.getElementById('prev-odometer-modal-km');
  const hsInput = document.getElementById('prev-odometer-modal-hs');

  if (kmInput) kmInput.value = isHs ? '' : (km || '');
  if (hsInput) hsInput.value = isHs ? (hs || km || '') : '';

  const modal = document.getElementById('prev-odometer-modal');
  if (modal) modal.classList.add('open');

  setTimeout(() => {
    const focusEl = isHs ? hsInput : kmInput;
    if (focusEl) focusEl.focus();
  }, 100);
}

function closePrevOdometerModal() {
  document.getElementById('prev-odometer-modal').classList.remove('open');
  prevCurrentOdometerRow = null;
}

async function savePrevOdometer() {
  if (!prevCurrentOdometerRow) return;
  const btn = document.getElementById('btn-save-prev-odometer');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-icons" style="animation:spin 1.5s linear infinite; font-size:16px; vertical-align:middle;">sync</span> Guardando...';
  try {
    const isHs = prevCurrentOdometerRow.isHs || prevCurrentOdometerRow.vehicleType === 'iveco';
    const kmVal = (document.getElementById('prev-odometer-modal-km')?.value || '').trim();
    const hsVal = (document.getElementById('prev-odometer-modal-hs')?.value || '').trim();

    const userEnteredVal = hsVal || kmVal;
    const km = userEnteredVal;
    const hs = userEnteredVal;

    const res = await fetch('/api/preventivos/odometer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rowIndex: prevCurrentOdometerRow.rowIndex,
        km,
        hs,
        interno: prevCurrentOdometerRow.interno,
        vehicleType: isHs ? 'iveco' : ''
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    showToast(`Kilómetros/Horas actualizados para interno ${prevCurrentOdometerRow.interno} ✓`, 'success');
    closePrevOdometerModal();

    // Refrescar ambas tablas para recalcular Restantes/Faltante en vivo
    if (typeof fetchPreventivoFlota === 'function') await fetchPreventivoFlota();
    if (typeof fetchPreventivosLivianas === 'function') await fetchPreventivosLivianas();
  } catch (error) {
    showToast(`Error al actualizar KM/HS: ${error.message}`, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Actualizar KM/HS';
  }
}


// Modal Combustible
function openPrevCombustibleModal(rowIndex, interno, alerta5k, alerta10k, litrosTotales) {
  // Determine default based on which alert is active
  const a5 = String(alerta5k || '').toLowerCase();
  const a10 = String(alerta10k || '').toLowerCase();
  const has10k = ['realizar', 'urgente', 'service'].some(w => a10.includes(w));
  const has5k = ['realizar', 'urgente', 'service'].some(w => a5.includes(w));
  
  let defaultTipo = "5k";
  if (has10k) {
    defaultTipo = "10k";
  }
  
  // Ask the user to confirm the type of preventivo
  const confirmMsg = `¿Desea crear el Preventivo de 10.000 Lts para el Interno ${interno}?\n\n[Aceptar] para Preventivo 10.000 Lts\n[Cancelar] para Preventivo 5.000 Lts`;
  const tipo = confirm(confirmMsg) ? "10k" : "5k";
  
  openNewOrderModalWithFuelPreventivo(interno, tipo, rowIndex, litrosTotales);
}

function openNewOrderModalWithFuelPreventivo(interno, tipo, rowIndex, litrosTotales) {
  // Switch view to orders tab first
  switchView('orders');
  
  // Open the new order modal
  openNewOrderModal();
  
  // Set Interno
  const internoSelect = document.getElementById('form-interno');
  const internoText = document.getElementById('form-interno-text');
  const isHerreria = (getSectorByUsername(localStorage.getItem('currentUserUsername')) === 'Herrería');
  
  if (internoSelect) {
    let optionExists = Array.from(internoSelect.options).some(opt => opt.value === interno);
    if (!optionExists) {
      const newOpt = document.createElement('option');
      newOpt.value = interno;
      newOpt.textContent = interno;
      internoSelect.appendChild(newOpt);
    }
    internoSelect.value = interno;
    if (internoSelect.rebuildSearchable) {
      internoSelect.rebuildSearchable();
    }
    internoSelect.dispatchEvent(new Event('change'));
  }
  if (internoText) {
    internoText.value = interno;
    internoText.dispatchEvent(new Event('change'));
  }

  // Auto-populate Rodado based on selected Interno
  const rodadoOpt = cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === String(interno).trim());
  if (rodadoOpt) {
    const rodadoSelect = document.getElementById('form-rodado');
    const rodadoText = document.getElementById('form-rodado-text');
    if (isHerreria) {
      if (rodadoText) {
        rodadoText.value = rodadoOpt.label;
        const event = new Event('change');
        rodadoText.dispatchEvent(event);
      }
    } else {
      if (rodadoSelect) {
        rodadoSelect.value = rodadoOpt.value;
        if (rodadoSelect.rebuildSearchable) {
          rodadoSelect.rebuildSearchable();
        }
        const event = new Event('change');
        rodadoSelect.dispatchEvent(event);
      }
    }
  }
  
  // Set Clasificación to "Preventivo"
  const clasificacionEl = document.getElementById('form-clasificacion');
  if (clasificacionEl) {
    clasificacionEl.value = 'Preventivo';
    if (clasificacionEl.rebuildSearchable) {
      clasificacionEl.rebuildSearchable();
    }
  }
  
  // Set Incidente / Detalle
  const incidenteEl = document.getElementById('form-incidente');
  if (incidenteEl) {
    incidenteEl.value = `Realizar Preventivo Combustible ${tipo === '5k' ? '5.000 Lts' : '10.000 Lts'}`;
  }
  
  // Set global combustibleReset metadata
  currentCombustibleReset = {
    tipo: tipo,
    rowIndex: rowIndex,
    litrosTotales: litrosTotales
  };
  
  // Combine all items into a single task with newlines
  const combinedDescription = tipo === '5k' ? [
    "Realizar Preventivo 5.000 Lts",
    "- Cambio de filtros de Aire",
    "- Cambio Filtro Aceite",
    "- Cambio Filtro de Combustible",
    "- Cambio Aceite Motor",
    "- Revision Grasa de Caja Nivel Y Estado",
    "- Revision Grasa de Diferencial Estado y Nivel",
    "- Revision Gral : Frenos - Cardan - Perdidas Aire / Fluidos",
    "- Otros"
  ].join('\n') : [
    "Realizar Preventivo 10.000 Lts",
    "- Cambio de filtros de Aire",
    "- Cambio Filtro Aceite",
    "- Cambio Filtro de Combustible",
    "- Cambio Aceite Motor",
    "- Cambio Grasa de Caja",
    "- Cambio Grasa de Diferencial",
    "- Revision Gral : Frenos - Cardan - Perdidas Aire / Fluidos",
    "- Otros"
  ].join('\n');
  
  addTaskField({
    descripcion: combinedDescription,
    centroCosto: "15", // MECANICA default
    status: "Pendiente"
  });
}

async function procesarCombustiblePlanilla() {
  const btn = document.getElementById('btn-process-fuel-planilla');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-icons" style="animation:spin 1.5s linear infinite; font-size:16px; vertical-align:middle;">sync</span> Procesando...';
  }
  try {
    const res = await fetch('/api/preventivos/process-fuel', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const msg = data.result || data.msg || JSON.stringify(data);
    showToast(msg.substring(0, 120), 'success');
    await fetchPrevCombustible();
  } catch (error) {
    showToast(`Error al procesar planilla: ${error.message}`, 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-icons" style="font-size:16px;">local_gas_station</span> <span>Procesar Combustible de Planilla</span>';
    }
  }
}




// ============================================================
// PARTE TALLER MODULE
// ============================================================

window._ptCurrentSearchQuery = '';

function filterParteTallerUI(query) {
  window._ptCurrentSearchQuery = (query || '').trim();
  const clearBtn = document.getElementById('pt-search-clear');
  if (clearBtn) clearBtn.style.display = window._ptCurrentSearchQuery ? 'block' : 'none';
  if (window._ptState) {
    renderParteTallerDashboard(window._ptState);
  }
}

function clearPtSearch() {
  const input = document.getElementById('pt-search-input');
  if (input) input.value = '';
  filterParteTallerUI('');
}

function deduplicateUnitsByInterno(unitList) {
  if (!Array.isArray(unitList)) return [];
  const map = new Map();
  unitList.forEach(item => {
    const key = String(item.interno || '').trim().toUpperCase();
    if (!key) return;
    if (!map.has(key)) {
      map.set(key, JSON.parse(JSON.stringify(item)));
    } else {
      const existing = map.get(key);
      const existingItems = Array.isArray(existing.novedad_items) ? existing.novedad_items : [];
      const existingTexts = new Set(existingItems.map(x => String(x.texto || '').trim().toUpperCase()));
      const newItems = Array.isArray(item.novedad_items) ? item.novedad_items : [];
      newItems.forEach(newItem => {
        const tClean = String(newItem.texto || '').trim().toUpperCase();
        if (tClean && !existingTexts.has(tClean)) {
          existingItems.push(newItem);
          existingTexts.add(tClean);
        }
      });
      existing.novedad_items = existingItems;
    }
  });
  return Array.from(map.values());
}
const mergeUniqueUnits = deduplicateUnitsByInterno;

function unitMatchesSearch(unit) {
  const q = (window._ptCurrentSearchQuery || '').toLowerCase().trim();
  if (!q) return true;
  const intStr = String(unit.interno || '').toLowerCase();
  const rodStr = String(unit.rodado || '').toLowerCase();
  const tipoStr = String(unit.tipo || '').toLowerCase();
  const novStr = String(unit.novedad || '').toLowerCase();
  let itemsStr = '';
  if (Array.isArray(unit.novedad_items)) {
    itemsStr = unit.novedad_items.map(x => x.texto || '').join(' ').toLowerCase();
  }
  const destStr = String(unit.destinoIngreso || '').toLowerCase();
  const servStr = String(unit.servicio || unit.tipo_servicio || '').toLowerCase();
  
  return intStr.includes(q) || rodStr.includes(q) || tipoStr.includes(q) || novStr.includes(q) || itemsStr.includes(q) || destStr.includes(q) || servStr.includes(q);
}

async function fetchParteTallerEstado() {
  const tbody = document.getElementById('pt-fuera-tbody');
  const repTbody = document.getElementById('pt-reparacion-tbody');
  const pendTbody = document.getElementById('pt-pendientes-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px;"><span class="material-icons" style="animation:spin 1.5s linear infinite; vertical-align:middle;">sync</span> Cargando...</td></tr>';

  try {
    const res = await fetch('/api/parte-taller/estado');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const state = (data && data.state) ? data.state : ((data && (data.servicios_pendientes || data.fuera_de_servicio || data.reparacion || data.transito)) ? data : null);
    if (!state && data.ok === false) throw new Error(data.msg || 'Error al leer estado');
    renderParteTallerDashboard(state || data);
    syncResponsableToParteTaller();
  } catch (error) {
    console.error('Error fetching parte taller estado:', error);
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--danger);">Error: ${error.message}. Configure la URL del script en Ajustes.</td></tr>`;
    if (repTbody) repTbody.innerHTML = '';
    if (pendTbody) pendTbody.innerHTML = '';
  }
}

// Dynamically adjusts the taller list and totals by moving units with active/paused Taxes tasks into "En Reparación"
function adjustPtStateLists(state) {
  if (!state) return;
  if (!activeOrders || !Array.isArray(activeOrders)) return;

  // Determine sector based on active tab/selected sector
  const isHerreriaAdj = (currentSelectedSector === 'Herrería');

  // Helper: does a task match the current sector?
  function taskMatchesSector(t) {
    // Use label-based detection matching the catalog
    const ccOpt = cachedCatalogs.centrosCosto ? cachedCatalogs.centrosCosto.find(c => c.value === t.centroCosto) : null;
    const ccLabel = ccOpt ? ccOpt.label.toUpperCase() : String(t.centroCosto || '').toUpperCase();
    if (isHerreriaAdj) return ccLabel.includes('HERRER');
    return ccLabel.includes('MECAN') || t.centroCosto === '15' || (!ccLabel.includes('HERRER') && !ccLabel.includes('EDILI'));
  }

  // ============================================================
  // HERRERÍA MODE: Only show live orders from Taxes as Fuera de Servicio
  // ============================================================
  if (isHerreriaAdj) {
    // Clear all Google Sheet-based lists (not applicable for Herrería)
    state.fuera_de_servicio = [];
    state.reparacion = [];
    state.servicios_pendientes = [];

    // Find all open Herrería orders with active/paused tasks. A unit already marked
    // "operativo" is out of here no matter what its task history looks like - that field is
    // the real-world signal that the unit is back in service, not leftover task state.
    const herreriaOrders = activeOrders.filter(o => {
      const isClosed = o.estado && o.estado.toLowerCase() === 'cerrada';
      if (isClosed) return false;
      if (o.estadoUnidad === 'operativo') return false;
      const tasks = (o.tasks || []).filter(t => t !== null && t !== undefined);
      return tasks.filter(taskMatchesSector).some(
        t => t.status !== 'Finalizada' && (t.timerStart > 0 || t.timerStarted || (t.timerHistory && t.timerHistory.length > 0))
      );
    });

    // Create fuera_de_servicio entries from live Herrería orders
    herreriaOrders.forEach(order => {
      const activeTasks = (order.tasks || [])
        .filter(taskMatchesSector)
        .filter(t => t.status !== 'Finalizada')
        .map(t => {
          let prefix = '[ ]';
          if (t.timerStart > 0) {
            prefix = '[ ] ⚡ [En Proceso]';
          } else if (t.timerStarted || (t.timerHistory && t.timerHistory.length > 0)) {
            prefix = '[ ] ⏸ [Pausado]';
          }
          return `${prefix} ${t.descripcion || 'Tarea sin descripción'}`;
        });

      // Guess type from catalog
      let unitType = 'UNIDAD';
      const rodadoOpt = cachedCatalogs.rodados
        ? cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === String(order.interno).trim())
        : null;
      if (rodadoOpt) {
        // "equipo" (e.g. "COMPACTADOR 3 EJES") is the real vehicle type - "label" is brand/model
        // ("MERCEDES BENZ ATEGO 1725 Interno 101") and rarely contains any of these keywords.
        const labelUpper = String(rodadoOpt.equipo || rodadoOpt.label || '').toUpperCase();
        if (labelUpper.includes('VOLQ')) unitType = 'VOLQUETE';
        else if (labelUpper.includes('ROLL') || labelUpper.includes('OFF')) unitType = 'ROLL - OFF';
        else if (labelUpper.includes('PLANCHA')) unitType = 'PLANCHA';
        else if (labelUpper.includes('COMPAC')) unitType = 'COMPACTADOR';
        else if (labelUpper.includes('CONTENEDOR') || labelUpper.includes('CAJITA') || labelUpper.includes('CAJA')) unitType = 'CONTENEDOR';
        else unitType = 'UNIDAD';
      }

      state.fuera_de_servicio.push({
        interno: order.interno || 'Sin numero',
        rodado: order.rodado || '',
        tipo: unitType,
        novedad: activeTasks.join('\n'),
        novedad_items: activeTasks.map(line => {
          const hecho = line.startsWith('[X]') || line.startsWith('[x]');
          const texto = line.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim();
          return { texto, hecho };
        }),
        dia_parado: new Date().toLocaleDateString('es-AR'),
        dias_en_reparacion: 0
      });
    });

    // Clear totals (not applicable for Herrería view)
    state.resumen = { totales: {} };
    return;
  }

  // ============================================================
  // TALLER MODE: Standard logic - move units with active tasks to "En Reparación"
  // ============================================================

  // Ground truth for what an interno actually is comes from Base_Datos' own "equipo" column,
  // not keyword-guessing off the rodado label (brand/model). Only these 4 equipo values are
  // real fleet categories tracked by the stat cards; HERRERIA/EDILICIO internos are internal
  // work buckets for those OTHER sectors and must never show up here at all ("solo Taller");
  // everything else real (CAMIONETA, AUTOELEVADOR, IRINEO, REP. INT., etc.) still shows in the
  // tables but as "Otro", uncounted in the Compactador/Volquete/Roll-Off/Plancha totals.
  function resolveFleetTypeFromInterno(internoVal) {
    const cleanInternoVal = String(internoVal || '').trim();
    if (INTERNO_TIPO_OVERRIDES[cleanInternoVal]) return INTERNO_TIPO_OVERRIDES[cleanInternoVal];
    const rodadoOpt = cachedCatalogs.rodados
      ? cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === cleanInternoVal)
      : null;
    const equipo = String(rodadoOpt ? rodadoOpt.equipo || '' : '').trim().toUpperCase();
    if (equipo === 'HERRERIA' || equipo === 'EDILICIO') return null;
    // startsWith, not exact match - many real units carry a suffix in Base_Datos
    // ("COMPACTADOR 3 EJES", "COMPACTADOR 2 EJES") that would otherwise miss an exact check.
    // "VOLQ. NICO"/"REP. INT."/etc don't start with any of these, so this stays safe.
    if (equipo.startsWith('COMPACTADOR')) return 'COMPACTADOR';
    if (equipo.startsWith('VOLQUETE')) return 'VOLQUETE';
    if (equipo.startsWith('ROLL OFF')) return 'ROLL - OFF';
    // Real planchas are catalogued as "CHASIS CON PLANCHA", not "PLANCHA ..." - startsWith missed
    // every single one of them (they all fell through to 'Otro' instead).
    if (equipo.includes('PLANCHA')) return 'PLANCHA';
    return 'Otro';
  }

  // 1. Find all open orders with active or paused sector-matching tasks. A unit already
  // marked "operativo" is excluded no matter what its task history looks like - that field is
  // the real-world signal that the unit is back in service, not leftover task state.
  const activeRepairOrders = activeOrders.filter(o => {
    const isClosed = o.estado && o.estado.toLowerCase() === 'cerrada';
    if (isClosed) return false;
    if (o.estadoUnidad === 'operativo') return false;
    if (resolveFleetTypeFromInterno(o.interno) === null) return false;
    const tasks = (o.tasks || []).filter(t => t !== null && t !== undefined);
    return tasks.filter(taskMatchesSector).some(
      t => t.status !== 'Finalizada' && (t.timerStart > 0 || t.timerStarted || (t.timerHistory && t.timerHistory.length > 0))
    );
  });

  // Backfill: units already being worked on before this sync existed (or whose sync got
  // missed for any reason) never reach the sheet just by sitting there - reconcile them here
  // too, not only at the exact moment a timer starts. syncTaskStartToParteTaller already
  // no-ops if the sheet already has this task's description, so repeat renders stay cheap.
  activeRepairOrders.forEach(o => {
    (o.tasks || []).filter(taskMatchesSector).filter(t => t.status !== 'Finalizada').forEach(t => {
      if (t.timerStart > 0 || t.timerStarted || (t.timerHistory && t.timerHistory.length > 0)) {
        syncTaskStartToParteTaller(o.interno, t.centroCosto, o.sector, t.descripcion);
      }
    });
  });

  // Drop any unit already sitting in fuera_de_servicio/reparacion whose order is now
  // "operativo" - this covers units that were put back in service through the order's own
  // status toggle (not through a Parte Taller checklist action), which otherwise leaves a
  // stale entry behind forever since nothing else ever removes it.
  const operativoInternos = new Set();
  activeOrders.forEach(o => {
    if (o.estadoUnidad === 'operativo') {
      const taxInt = String(o.interno || '').trim().toUpperCase();
      if (taxInt) operativoInternos.add(taxInt);
    }
  });
  function matchesOperativoOrder(internoPT) {
    const ptIntUpper = String(internoPT || '').trim().toUpperCase();
    if (operativoInternos.has(ptIntUpper)) return true;
    if (ptIntUpper.includes('IRINEO') && operativoInternos.has('IRINEO GRAL.')) return true;
    if ((ptIntUpper.includes('NICO') || ptIntUpper.startsWith('NICO')) && operativoInternos.has('VOLQUETE NICO')) return true;
    return false;
  }
  // A unit whose order already closed (no longer in activeOrders at all) can't be matched
  // against anything above - but if it has zero items left pending, it has nothing left to
  // show here regardless of why, so drop it too instead of leaving a permanent empty husk.
  function hasNoOutstandingItems(unit) {
    if (Array.isArray(unit.novedad_items) && unit.novedad_items.length > 0) {
      return unit.novedad_items.every(x => x.hecho);
    }
    if (unit.novedad) {
      return !unit.novedad.split('\n').some(line => {
        const l = line.trim();
        return l && !l.startsWith('[X]') && !l.startsWith('[x]');
      });
    }
    return true;
  }
  ['fuera_de_servicio', 'reparacion'].forEach(listName => {
    if (Array.isArray(state[listName])) {
      state[listName] = state[listName].filter(unit => !matchesOperativoOrder(unit.interno) && !hasNoOutstandingItems(unit));
    }
  });

  // A unit the supervisor has explicitly marked "En Preparación" (inversiones) takes
  // precedence over any stale entry left behind elsewhere - otherwise, once a unit has BOTH
  // an inversiones entry and a leftover fuera_de_servicio/reparacion/servicios_pendientes
  // entry from before it was marked as preparación, step 2-3 below keeps reviving/refreshing
  // that stale entry (pushing it back into "reparacion") every time its Taxes task is
  // touched, duplicating it across both tables. Step 4's "skip creating a new temp entry"
  // guard only ever protected against a *brand-new* duplicate, not this one.
  const preparacionInternos = new Set((state.inversiones || []).map(u => String(u.interno).trim().toUpperCase()));
  function matchesPreparacionUnit(internoPT) {
    const ptIntUpper = String(internoPT || '').trim().toUpperCase();
    if (preparacionInternos.has(ptIntUpper)) return true;
    if (ptIntUpper.includes('IRINEO') && preparacionInternos.has('IRINEO GRAL.')) return true;
    if ((ptIntUpper.includes('NICO') || ptIntUpper.startsWith('NICO')) && preparacionInternos.has('VOLQUETE NICO')) return true;
    return false;
  }
  ['fuera_de_servicio', 'reparacion', 'servicios_pendientes'].forEach(listName => {
    if (Array.isArray(state[listName])) {
      state[listName] = state[listName].filter(unit => !matchesPreparacionUnit(unit.interno));
    }
  });

  // Keep track of which internos are forced into "reparacion"
  const repairInternos = new Map();
  activeRepairOrders.forEach(o => {
    const taxInt = String(o.interno || '').trim().toUpperCase();
    if (taxInt) {
      repairInternos.set(taxInt, o);
    }
  });

  // NOTE: no early-return here when repairInternos is empty - steps 2-4 below already
  // no-op safely on an empty map, and step 5 (recalculating the fleet totals breakdown)
  // must always run regardless, or every stat card's En Rep./Fuera Serv./En Preparación
  // silently zeroes out the moment there's no live Taxes task with a running/paused timer.

  // Helper to map and check matching
  function findMatchingOrder(internoPT) {
    const ptIntUpper = String(internoPT || '').trim().toUpperCase();
    for (const [taxInt, order] of repairInternos.entries()) {
      if (taxInt === 'IRINEO GRAL.' && ptIntUpper.includes('IRINEO')) return order;
      if (taxInt === 'VOLQUETE NICO' && (ptIntUpper.includes('NICO') || ptIntUpper.startsWith('NICO'))) return order;
      if (taxInt === ptIntUpper) return order;
    }
    return null;
  }

  // 2. Scan all lists in state, extract matching units, and filter them out
  const lists = ['fuera_de_servicio', 'reparacion', 'servicios_pendientes'];
  const unitsToMove = [];

  lists.forEach(listName => {
    if (!state[listName]) state[listName] = [];
    state[listName] = state[listName].filter(unit => {
      const matchingOrder = findMatchingOrder(unit.interno);
      if (matchingOrder) {
        unitsToMove.push({ unit, matchingOrder, sourceList: listName });
        return false;
      }
      return true;
    });
  });

  if (!state.reparacion) state.reparacion = [];

  // 3. For each moved unit, update its novelty/tasks and place in "reparacion"
  unitsToMove.forEach(({ unit, matchingOrder, sourceList }) => {
    const activeTasks = (matchingOrder.tasks || [])
      .filter(taskMatchesSector)
      .filter(t => t.status !== 'Finalizada')
      .map(t => {
        let prefix = '[ ]';
        if (t.timerStart > 0) {
          prefix = '[ ] ⚡ [En Proceso]';
        } else if (t.timerStarted || (t.timerHistory && t.timerHistory.length > 0)) {
          prefix = '[ ] ⏸ [Pausado]';
        }
        return `${prefix} ${t.descripcion || 'Tarea sin descripción'}`;
      });

    let originalLines = [];
    if (Array.isArray(unit.novedad_items)) {
      originalLines = unit.novedad_items.map(x => {
        const pfx = x.hecho ? '[X]' : '[ ]';
        return `${pfx} ${x.texto.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim()}`;
      });
    } else if (unit.novedad) {
      originalLines = unit.novedad.split('\n').map(l => l.trim()).filter(Boolean);
    }

    const activeClean = activeTasks.map(t => t.replace(/^\[\s*\]\s*(⚡ \[En Proceso\]|⏸ \[Pausado\])\s*/, '').trim().toUpperCase());
    originalLines = originalLines.filter(line => {
      const cleanLine = line.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim().toUpperCase();
      return !activeClean.includes(cleanLine);
    });

    const combinedLines = [...originalLines, ...activeTasks];
    unit.novedad = combinedLines.join('\n');
    unit.novedad_items = combinedLines.map(line => {
      const hecho = line.startsWith('[X]') || line.startsWith('[x]');
      const texto = line.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim();
      return { texto, hecho };
    });

    // This unit may have been sitting in the sheet with a stale/wrong tipo since before the
    // equipo-based resolver existed (e.g. hardcoded to "COMPACTADOR" at creation time) -
    // re-resolve it every time instead of trusting whatever was already stored.
    unit.tipo = resolveFleetTypeFromInterno(matchingOrder.interno) || 'Otro';

    state.reparacion.push(unit);
    const taxInt = String(matchingOrder.interno || '').trim().toUpperCase();
    repairInternos.delete(taxInt);
  });

  // 4. For any remaining repairInternos (units not currently in taller), create a temporary unit
  // - except a unit already sitting in "En Preparación" (inversiones): working on it doesn't
  // mean it needs repairing, it just means prep work is happening on it right now. It should
  // stay in Preparación, not get duplicated into Reparación on top of it.
  const inversionesInternos = new Set((state.inversiones || []).map(u => String(u.interno).trim().toUpperCase()));
  for (const [taxInt, order] of repairInternos.entries()) {
    if (inversionesInternos.has(taxInt)) continue;
    let internoLabel = order.interno;

    // HERRERIA/EDILICIO internos were already filtered out of activeRepairOrders above, so this
    // never resolves to null here - "Otro" covers every real but non-fleet-tracked equipo
    // (CAMIONETA, AUTOELEVADOR, IRINEO, REP. INT., etc.).
    const unitType = resolveFleetTypeFromInterno(order.interno) || 'Otro';

    const activeTasks = (order.tasks || [])
      .filter(t => t.status !== 'Finalizada')
      .map(t => {
        let prefix = '[ ]';
        if (t.timerStart > 0) {
          prefix = '[ ] ⚡ [En Proceso]';
        } else if (t.timerStarted || (t.timerHistory && t.timerHistory.length > 0)) {
          prefix = '[ ] ⏸ [Pausado]';
        }
        return `${prefix} ${t.descripcion || 'Tarea sin descripción'}`;
      });

    const tempUnit = {
      interno: internoLabel,
      tipo: unitType,
      novedad: activeTasks.join('\n'),
      novedad_items: activeTasks.map(line => {
        const hecho = line.startsWith('[X]') || line.startsWith('[x]');
        const texto = line.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim();
        return { texto, hecho };
      }),
      dia_parado: new Date().toLocaleDateString('es-AR'),
      dias_en_reparacion: 0
    };

    state.reparacion.push(tempUnit);
  }

  // 4.5. Re-resolve tipo for EVERY unit left in these lists, not only the ones that just got
  // moved/merged above (step 3 only re-resolves a unit's tipo when it has a matching active
  // order with a running/paused task - a unit added straight from Parte Taller's own "Agregar
  // Unidad" whose auto-created task is still "Pendiente" with no timer activity never passes
  // through that path, so it kept showing whatever wrong tipo it was created with forever).
  ['fuera_de_servicio', 'reparacion', 'servicios_pendientes', 'inversiones'].forEach(listName => {
    (state[listName] || []).forEach(unit => {
      unit.tipo = resolveFleetTypeFromInterno(unit.interno) || 'Otro';
    });
  });

  // 5. Recalculate totals - split "fuera" into reparacion/fuera_de_servicio separately, and
  // factor in inversiones (units in preparation): they reduce operativos but the base fleet
  // total stays fixed (it comes from Base_Datos, not from how many units happen to be down).
  // Internal work buckets / external-company placeholders, not real fleet units - counting
  // them here is what made Compactador's Fuera de Servicio show 9 (should be 7) and the
  // total look like 64 instead of the real 62.
  const NO_FLOTA_INTERNOS = new Set(['IRINEO GRAL.', 'VOLQUETE NICO', 'REPARACIONES INTERNAS']);
  const esUnidadDeFlotaReal = u => !NO_FLOTA_INTERNOS.has(String(u.interno || '').trim().toUpperCase());

  const totales = (state.resumen || {}).totales || {};
  const types = ['COMPACTADOR', 'VOLQUETE', 'ROLL - OFF', 'PLANCHA'];
  types.forEach(t => {
    const origOp = parseInt((totales[t] || {}).operativos || '0') || 0;
    const origFs = parseInt((totales[t] || {}).fuera || '0') || 0;
    const totalFleet = totales[t] && totales[t].total !== undefined ? parseInt(totales[t].total) || 0 : (origOp + origFs);

    const fsCount = (state.fuera_de_servicio || []).filter(esUnidadDeFlotaReal).filter(u => String(u.tipo).trim().toUpperCase() === t).length;
    const repCount = (state.reparacion || []).filter(esUnidadDeFlotaReal).filter(u => String(u.tipo).trim().toUpperCase() === t).length;
    const invCount = (state.inversiones || []).filter(esUnidadDeFlotaReal).filter(u => String(u.tipo).trim().toUpperCase() === t).length;

    if (!totales[t]) totales[t] = {};
    totales[t].fuera = fsCount + repCount;
    totales[t].reparacion = repCount;
    totales[t].fueraServicio = fsCount;
    totales[t].inversiones = invCount;
    totales[t].total = totalFleet;
    totales[t].operativos = Math.max(0, totalFleet - fsCount - repCount - invCount);
  });
}

function renderParteTallerDashboard(state) {
  if (!state) {
    const noData = '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">Sin datos registrados aún.</td></tr>';
    const el = id => document.getElementById(id);
    if (el('pt-fuera-tbody')) el('pt-fuera-tbody').innerHTML = noData;
    if (el('pt-reparacion-tbody')) el('pt-reparacion-tbody').innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-muted);">Sin datos.</td></tr>';
    if (el('pt-pendientes-tbody')) el('pt-pendientes-tbody').innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">Sin datos.</td></tr>';
    return;
  }

  // Store state globally for editing (original state without live Taxes adjustments)
  window._ptState = state;

  // Clone state for rendering to dynamically merge/inject live active tasks from Taxes
  const displayState = JSON.parse(JSON.stringify(state));
  adjustPtStateLists(displayState);
  window._ptDisplayState = displayState;

  // Immediately sync top dashboard cards with calculated parte taller display state
  updateDashboardStats();

  const el = id => document.getElementById(id);
  const resumen = displayState.resumen || {};
  const totales = resumen.totales || {};

  function parseCount(tipo, campo) {
    return parseInt((totales[tipo] || {})[campo] || '0') || 0;
  }

  // Fill totals for each vehicle type
  const types = [
    { key: 'COMPACTADOR', suffix: 'comp' },
    { key: 'VOLQUETE',    suffix: 'volq' },
    { key: 'ROLL - OFF',  suffix: 'roll' },
    { key: 'PLANCHA',     suffix: 'plancha' }
  ];
  types.forEach(t => {
    const op = parseCount(t.key, 'operativos');
    const rep = parseCount(t.key, 'reparacion');
    const fs = parseCount(t.key, 'fueraServicio');
    const inv = parseCount(t.key, 'inversiones');
    const tot = parseCount(t.key, 'total');
    const pct = tot > 0 ? Math.round((op / tot) * 100) : 0;
    if (el(`pt-op-${t.suffix}`)) el(`pt-op-${t.suffix}`).textContent = op;
    if (el(`pt-rep-${t.suffix}`)) el(`pt-rep-${t.suffix}`).textContent = rep;
    if (el(`pt-fs-${t.suffix}`)) el(`pt-fs-${t.suffix}`).textContent = fs;
    if (el(`pt-inv-${t.suffix}`)) el(`pt-inv-${t.suffix}`).textContent = inv;
    if (el(`pt-tot-${t.suffix}`)) el(`pt-tot-${t.suffix}`).textContent = tot;
    if (el(`pt-pct-${t.suffix}`)) el(`pt-pct-${t.suffix}`).textContent = `${pct}%`;

    // Home (Inicio) mirrors the same totals: full cards on desktop (home-op/rep/fs/inv/tot/pct),
    // plus a compact quadrant box on mobile showing the combined "not operational" count
    // (Fuera Serv. + Reparación + Preparación) - see #home-type-summary-mobile in index.html.
    if (el(`home-op-${t.suffix}`)) el(`home-op-${t.suffix}`).textContent = op;
    if (el(`home-rep-${t.suffix}`)) el(`home-rep-${t.suffix}`).textContent = rep;
    if (el(`home-fs-${t.suffix}`)) el(`home-fs-${t.suffix}`).textContent = fs;
    if (el(`home-inv-${t.suffix}`)) el(`home-inv-${t.suffix}`).textContent = inv;
    if (el(`home-tot-${t.suffix}`)) el(`home-tot-${t.suffix}`).textContent = tot;
    if (el(`home-pct-${t.suffix}`)) el(`home-pct-${t.suffix}`).textContent = `${pct}%`;
    if (el(`home-quad-${t.suffix}`)) el(`home-quad-${t.suffix}`).textContent = fs + rep + inv;
    if (el(`home-quad-${t.suffix}-detail`)) el(`home-quad-${t.suffix}-detail`).innerHTML = `<span style="color:#ef4444;">${fs} F/S</span> · <span style="color:#f97316;">${rep} R</span> · <span style="color:#d97706;">${inv} P</span>`;
  });

  // Checklist helper
  function getChecklistHtml(item, internoPT) {
    let pendingItems = [];
    if (Array.isArray(item.novedad_items) && item.novedad_items.length > 0) {
      pendingItems = item.novedad_items
        .filter(x => !x.hecho)
        .map(x => x.texto.replace(/^\[\s*\]\s*/, '').trim())
        .filter(Boolean);
    } else if (item.novedad) {
      item.novedad.split('\n').forEach(line => {
        const l = line.trim();
        if (l && !l.startsWith('[X]') && !l.startsWith('[x]')) {
          const clean = l.replace(/^\[\s*\]\s*/, '').trim();
          if (clean) pendingItems.push(clean);
        }
      });
    }

    if (pendingItems.length > 0) {
      return `<div style="display:flex; flex-direction:column; gap:5px;">
        ${pendingItems.map((txt, idx) => {
          const safeId = `ptck_${internoPT}_${idx}`;
          const safeTxt = txt.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
          return `<label style="display:flex; align-items:flex-start; gap:6px; font-size:12px; cursor:pointer;">
            <input type="checkbox" class="pt-item-checkbox" data-interno="${internoPT}" value="${safeTxt}"
              id="${safeId}" style="margin-top:2px; accent-color:var(--primary); flex-shrink:0;">
            <span>${txt}</span>
          </label>`;
        }).join('')}
        <button class="btn btn-secondary btn-xs" onclick="ptAsignarSeleccionados('${internoPT}')"
          style="margin-top:6px; font-size:11px; display:inline-flex; align-items:center; gap:3px; align-self:flex-start;">
          <span class="material-icons" style="font-size:13px;">assignment</span> Asignar Seleccionados
        </button>
      </div>`;
    }
    return '<span style="color:var(--text-muted); font-size:12px;">Sin ítems pendientes</span>';
  }

  // Same idea as getChecklistHtml, but for "En Preparación": shows every item (done or not)
  // plus a progress bar - a unit being prepped needs to see how far along the checklist is,
  // not just what's left.
  function getChecklistHtmlWithProgress(item, internoPT) {
    const items = Array.isArray(item.novedad_items) ? item.novedad_items : [];
    if (items.length === 0) {
      return '<span style="color:var(--text-muted); font-size:12px;">Sin ítems pendientes</span>';
    }
    const doneCount = items.filter(x => x.hecho).length;
    const pct = Math.round((doneCount / items.length) * 100);
    return `<div style="display:flex; flex-direction:column; gap:5px;">
      ${items.map((x, idx) => {
        if (x.hecho) {
          return `<div style="display:flex; align-items:flex-start; gap:6px; font-size:12px;">
            <span class="material-icons" style="font-size:14px; color:var(--success); margin-top:1px;">check_circle</span>
            <span style="color:var(--text-muted); text-decoration:line-through;">${x.texto}</span>
          </div>`;
        }
        const safeId = `ptckprep_${internoPT}_${idx}`;
        const safeTxt = String(x.texto || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
        return `<label style="display:flex; align-items:flex-start; gap:6px; font-size:12px; cursor:pointer;">
          <input type="checkbox" class="pt-item-checkbox" data-interno="${internoPT}" value="${safeTxt}"
            id="${safeId}" style="margin-top:2px; accent-color:var(--primary); flex-shrink:0;">
          <span>${x.texto}</span>
        </label>`;
      }).join('')}
      <div style="display:flex; align-items:center; gap:8px; margin-top:2px;">
        <div style="flex:1; height:4px; background:var(--border); border-radius:2px; overflow:hidden; max-width:90px;">
          <div style="height:100%; background:var(--success); border-radius:2px; width:${pct}%;"></div>
        </div>
        <span style="font-size:10px; color:var(--text-muted); font-weight:700; text-transform:uppercase;">${doneCount}/${items.length} hechas</span>
      </div>
      ${doneCount < items.length ? `<button class="btn btn-secondary btn-xs" onclick="ptAsignarSeleccionados('${internoPT}')"
        style="margin-top:2px; font-size:11px; display:inline-flex; align-items:center; gap:3px; align-self:flex-start;">
        <span class="material-icons" style="font-size:13px;">assignment</span> Asignar Seleccionados
      </button>` : ''}
    </div>`;
  }

  // Resolve the real Taxes interno from a Parte Taller interno (e.g. "Irineo 27" -> "IRINEO GRAL.")
  function resolveTaxesInterno(internoPT) {
    const up = String(internoPT).trim().toUpperCase();
    if (up.includes('IRINEO')) return 'IRINEO GRAL.';
    if (up.startsWith('NICO ') || up === 'NICO') return 'VOLQUETE NICO';
    return internoPT;
  }

  // Order button helper
  function getOrdenBtnHtml(internoPT) {
    const taxesInterno = resolveTaxesInterno(internoPT);
    const openOrder = activeOrders && activeOrders.find(o =>
      String(o.interno || '').trim() === taxesInterno &&
      (!o.estado || o.estado.toLowerCase() !== 'cerrada')
    );
    if (openOrder) {
      return `<button class="btn btn-xs" onclick="editOrder('${openOrder.id}')"
           style="background:#0288d1; color:white; border-color:#0288d1; font-size:11px; white-space:nowrap; display:inline-flex; align-items:center; gap:3px;">
           <span class="material-icons" style="font-size:12px;">open_in_browser</span> Abrir Orden
         </button>`;
    }
    return `<button class="btn btn-xs" onclick="ptCrearOrden('${internoPT}')"
         style="background:#00897b; color:white; border-color:#00897b; font-size:11px; white-space:nowrap; display:inline-flex; align-items:center; gap:3px;">
         <span class="material-icons" style="font-size:12px;">add_circle</span> Crear Orden
       </button>`;
  }


  // Edit pencil helper
  function getEditBtnHtml(internoPT, listName) {
    return `<button class="btn btn-link btn-xs" onclick="openPtEditUnitModal('${internoPT}', '${listName}')"
      style="padding:0; margin-left:6px; min-width:auto; color:var(--primary); display:inline-flex; align-items:center; vertical-align:middle;" title="Editar Unidad">
      <span class="material-icons" style="font-size:16px;">edit</span>
    </button>`;
  }

  // Badge shown when the unit was marked "Fuera de servicio" from the simple
  // status modal (order still open, job may take a while).
  function getEstadoTrabajoBadgeHtml(item) {
    if (!item || item.estadoTrabajo !== 'en_proceso') return '';
    return `<span class="badge" style="background:#f59e0b; color:white; font-size:10px; margin-left:6px; vertical-align:middle;">En Proceso</span>`;
  }

  // Helper to calculate days out of service
  function getDiasParadoHtml(item, desde) {
    let diasParado = item.dias_en_reparacion ? (item.dias_en_reparacion + ' días') : '—';
    if (diasParado === '—' && desde !== '—') {
      try {
        const parts = desde.split('/');
        if (parts.length === 3) {
          const fechaIngreso = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
          const diffMs = Date.now() - fechaIngreso.getTime();
          diasParado = Math.floor(diffMs / (1000 * 60 * 60 * 24)) + ' días';
        }
      } catch(e) {}
    }
    const color = parseInt(item.dias_en_reparacion || 0) > 30 ? '#ef4444' : 'inherit';
    return `<span style="font-weight:600; color:${color};">${diasParado}</span>`;
  }

  // Helper to compute numeric days from item (for sorting)
  function getDaysValue(item) {
    if (item.dias_en_reparacion && parseInt(item.dias_en_reparacion) > 0) return parseInt(item.dias_en_reparacion);
    const desde = item.dia_parado || item.fecha_ingreso || item.ingreso || '';
    if (desde && desde !== '—') {
      try {
        const parts = desde.split('/');
        if (parts.length === 3) {
          const fechaIngreso = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
          return Math.floor((Date.now() - fechaIngreso.getTime()) / (1000 * 60 * 60 * 24));
        }
      } catch(e) {}
    }
    return 0;
  }

  // Determine current sector for Pt filtering based on active tab/selected sector
  const currentPtSector = (currentSelectedSector === 'Herrería') ? 'herreria' : 'taller';

  // A Herrería-only work item (e.g. "12 verde", not a real Taxes-tracked asset) should stay
  // out of Taller's board, but a real truck Herrería logged a novedad against still belongs
  // on Taller's board too - it's still Taller's truck.
  function esUnidadRealDeFlota(interno) {
    return !!(cachedCatalogs.rodados && cachedCatalogs.rodados.some(r => String(r.interno || '').trim() === String(interno || '').trim()));
  }

  function matchesPtSector(item) {
    // If item has no sector tag, show to everyone (legacy data)
    if (!item.sector) return true;
    if (item.sector === 'herreria' && currentPtSector === 'taller') {
      return esUnidadRealDeFlota(item.interno);
    }
    return item.sector === currentPtSector;
  }

  // Deduplicate transito units in state
  if (state.transito) state.transito = deduplicateUnitsByInterno(state.transito);
  if (displayState.transito) displayState.transito = deduplicateUnitsByInterno(displayState.transito);

  // 0. En tránsito
  const transito = deduplicateUnitsByInterno((displayState.transito || []).filter(matchesPtSector)).filter(unitMatchesSearch).sort((a, b) => getDaysValue(b) - getDaysValue(a));
  if (el('pt-trans-count')) el('pt-trans-count').textContent = transito.length;
  if (el('pt-transito-tbody')) {
    if (transito.length === 0) {
      el('pt-transito-tbody').innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-muted);">No hay unidades en tránsito.</td></tr>';
    } else {
      el('pt-transito-tbody').innerHTML = transito.map(item => {
        const internoPT = String(item.interno || '');
        const hasRodadoDesc = item.rodado && String(item.rodado).trim().toUpperCase() !== internoPT.trim().toUpperCase();
        const displayLabel = (currentSelectedSector === 'Herrería' && hasRodadoDesc)
          ? `<strong>${internoPT}</strong><div style="font-size:11px; color:var(--text-muted); font-weight:normal; margin-top:2px;">${item.rodado}</div>`
          : `<strong>${internoPT}</strong>`;
        const desde = item.dia_parado || item.fecha_ingreso || item.ingreso || '—';
        
        let targetBadge = '<span class="badge" style="background:#ef4444; color:white; font-size:10px;">Fuera de Servicio</span>';
        if (item.destinoIngreso === 'reparacion') {
          targetBadge = '<span class="badge" style="background:#ff9800; color:white; font-size:10px;">En Reparación</span>';
        } else if (item.destinoIngreso === 'servicios_pendientes') {
          targetBadge = '<span class="badge" style="background:#2196f3; color:white; font-size:10px;">Servicios Pendientes</span>';
        }

        const ingresarBtn = `<button class="btn btn-success btn-xs" onclick="ingresarUnidadTransito('${internoPT}')" style="background:#16a34a; color:#fff; border:none; padding:4px 8px; font-weight:600; font-size:11px; border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:4px;" title="Marcar que la unidad llegó al taller">
          <span class="material-icons" style="font-size:14px;">login</span> Ingresó Unidad
        </button>`;

        return `<tr>
          <td><div style="display:flex; align-items:center; gap:4px; line-height:1.2;">${displayLabel} ${getEditBtnHtml(internoPT, 'transito')}</div></td>
          <td><span style="font-size:11px;">${item.tipo || '—'}</span></td>
          <td style="min-width:220px;">${getChecklistHtml(item, internoPT)}</td>
          <td>${targetBadge}</td>
          <td style="white-space:nowrap; color:var(--text-muted); font-size:12px;">${desde}</td>
          <td style="white-space:nowrap;">${ingresarBtn}</td>
        </tr>`;
      }).join('');
    }
  }
  // HOME (Inicio): compact En Tránsito - just Interno, Novedad, Acción, reusing the same
  // `transito` list and the same ingresarUnidadTransito() action as the full Parte Taller table.
  if (el('home-trans-count')) el('home-trans-count').textContent = transito.length;
  if (el('home-transito-tbody')) {
    if (transito.length === 0) {
      el('home-transito-tbody').innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px; color:var(--text-muted);">No hay unidades en tránsito.</td></tr>';
    } else {
      el('home-transito-tbody').innerHTML = transito.map(item => {
        const internoPT = String(item.interno || '');
        const items = Array.isArray(item.novedad_items) && item.novedad_items.length > 0
          ? item.novedad_items
          : (item.novedad || '').split('\n').map(l => l.replace(/^\[\s*[xX]?\s*\]\s*/, '').trim()).filter(Boolean).map(texto => ({ texto, hecho: false }));
        const novedadText = items.filter(x => !x.hecho).map(x => x.texto).join(', ') || '—';
        const ingresarBtn = `<button class="btn btn-success btn-xs" onclick="ingresarUnidadTransito('${internoPT}')" style="background:#16a34a; color:#fff; border:none; padding:4px 8px; font-weight:600; font-size:11px; border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:4px; white-space:nowrap;" title="Marcar que la unidad llegó al taller">
          <span class="material-icons" style="font-size:14px;">login</span> Ingresó
        </button>`;
        return `<tr>
          <td><strong>${internoPT}</strong></td>
          <td style="font-size:12px; color:var(--text-muted);">${novedadText}</td>
          <td>${ingresarBtn}</td>
        </tr>`;
      }).join('');
    }
  }
  const homeTransMobile = el('home-transito-mobile-cards');
  if (homeTransMobile) {
    homeTransMobile.innerHTML = transito.length === 0
      ? '<p style="text-align:center;color:var(--text-muted);padding:12px 0;">No hay unidades en tránsito.</p>'
      : transito.map(item => {
          const internoPT = String(item.interno || '');
          const items = Array.isArray(item.novedad_items) && item.novedad_items.length > 0
            ? item.novedad_items
            : (item.novedad || '').split('\n').map(l => l.replace(/^\[\s*[xX]?\s*\]\s*/, '').trim()).filter(Boolean).map(texto => ({ texto, hecho: false }));
          const novedadText = items.filter(x => !x.hecho).map(x => x.texto).join(', ') || '—';
          return `<div class="pt-mobile-card">
            <div class="pt-mobile-card-header">
              <strong style="font-size:15px;">${internoPT}</strong>
              <button class="btn btn-success btn-xs" onclick="ingresarUnidadTransito('${internoPT}')" style="background:#16a34a; color:#fff; border:none; padding:5px 10px; font-weight:600; font-size:11px; border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:4px;" title="Marcar que la unidad llegó al taller">
                <span class="material-icons" style="font-size:14px;">login</span> Ingresó
              </button>
            </div>
            <div class="pt-mobile-card-row"><span style="color:var(--text-muted); font-size:12px;">${novedadText}</span></div>
          </div>`;
        }).join('');
  }

  // Mobile cards for En Tránsito
  const transMobile = el('pt-trans-mobile-cards');
  if (transMobile) {
    transMobile.innerHTML = transito.length === 0
      ? '<p style="text-align:center;color:var(--text-muted);padding:12px 0;">No hay unidades en tránsito.</p>'
      : transito.map(item => {
          const internoPT = String(item.interno || '');
          const desde = item.dia_parado || item.fecha_ingreso || item.ingreso || '—';
          let targetBadge = '<span class="badge" style="background:#ef4444; color:white; font-size:10px;">Fuera de Servicio</span>';
          if (item.destinoIngreso === 'reparacion') {
            targetBadge = '<span class="badge" style="background:#ff9800; color:white; font-size:10px;">En Reparación</span>';
          } else if (item.destinoIngreso === 'servicios_pendientes') {
            targetBadge = '<span class="badge" style="background:#2196f3; color:white; font-size:10px;">Servicios Pendientes</span>';
          }
          return `<div class="pt-mobile-card" style="padding:12px; margin-bottom:10px; background:var(--card-bg); border-radius:8px; border:1px solid #e2e8f0; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
            <div class="pt-mobile-card-header" style="display:flex; justify-content:space-between; align-items:center;">
              <div><strong style="font-size:16px;">${internoPT}</strong>${item.tipo ? `<span style="font-size:12px; color:var(--text-muted); margin-left:6px;">(${item.tipo})</span>` : ''}</div>
              ${targetBadge}
            </div>
            <div class="pt-mobile-card-row" style="margin-top:4px; font-size:12px; color:var(--text-muted);"><span>En ruta desde: <strong>${desde}</strong></span></div>
            <div style="margin:10px 0; padding:8px; background:var(--card-bg); border-radius:6px; border:1px solid #e2e8f0;">
              <div style="font-weight:600; font-size:11px; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">Novedad en Ruta:</div>
              ${getChecklistHtml(item, internoPT)}
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; align-items:center; justify-content:space-between;">
              <button class="btn btn-success btn-xs" onclick="ingresarUnidadTransito('${internoPT}')" style="background:#16a34a; color:#fff; border:none; padding:6px 12px; font-weight:600; font-size:12px; border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:4px;">
                <span class="material-icons" style="font-size:15px;">login</span> Ingresó Unidad
              </button>
              ${getEditBtnHtml(internoPT, 'transito')}
            </div>
          </div>`;
        }).join('');
  }

  // The 4 stat cards up top (Compactador/Volquete/Roll-Off/Plancha) and their tables are meant
  // to be truck-only - a Herrería/Edilicio work bucket ("12 verde", "Acoplado nuevo", etc.)
  // mixed into "Fuera de Servicio" made it hard to tell fleet problems from shop-internal jobs
  // at a glance. Anything whose tipo isn't one of the 4 tracked fleet types gets pulled out of
  // every list below and shown together instead, in its own "Herrería / Edilicio" section.
  function esUnidadDeFlotaTrackeada(item) {
    const t = String((item && item.tipo) || '').trim().toUpperCase();
    return t.includes('COMPAC') || t.includes('VOLQ') || t.includes('ROLL') || t.includes('PLANCHA');
  }
  const otrosItems = [];
  function separarOtros(lista, origenLista) {
    const deFlota = [];
    (lista || []).forEach(item => {
      if (esUnidadDeFlotaTrackeada(item)) deFlota.push(item);
      else otrosItems.push({ item, origenLista });
    });
    return deFlota;
  }

  // 1. Fuera de servicio
  const fueraDeServicio = separarOtros((displayState.fuera_de_servicio || []).filter(matchesPtSector).filter(unitMatchesSearch), 'fuera_de_servicio')
    .sort((a, b) => getDaysValue(b) - getDaysValue(a));
  if (el('pt-out-count')) el('pt-out-count').textContent = fueraDeServicio.length;
  if (el('stat-total-taller')) el('stat-total-taller').textContent = fueraDeServicio.length;
  if (el('pt-fuera-tbody')) {
    if (fueraDeServicio.length === 0) {
      el('pt-fuera-tbody').innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-muted);">No hay unidades fuera de servicio.</td></tr>';
    } else {
      el('pt-fuera-tbody').innerHTML = fueraDeServicio.map(item => {
        const internoPT = String(item.interno || '');
        const hasRodadoDesc = item.rodado && String(item.rodado).trim().toUpperCase() !== internoPT.trim().toUpperCase();
        const displayLabel = (currentSelectedSector === 'Herrería' && hasRodadoDesc)
          ? `<strong>${internoPT}</strong><div style="font-size:11px; color:var(--text-muted); font-weight:normal; margin-top:2px;">${item.rodado}</div>`
          : `<strong>${internoPT}</strong>`;
        const desde = item.dia_parado || item.fecha_ingreso || item.ingreso || '—';
        return `<tr>
          <td><div style="display:flex; align-items:center; gap:4px; line-height:1.2;">${displayLabel} ${getEstadoTrabajoBadgeHtml(item)} ${getEditBtnHtml(internoPT, 'fuera_de_servicio')}</div></td>
          <td><span style="font-size:11px;">${item.tipo || '—'}</span></td>
          <td style="min-width:220px;">${getChecklistHtml(item, internoPT)}</td>
          <td style="white-space:nowrap;">${getOrdenBtnHtml(internoPT)}</td>
          <td style="white-space:nowrap;">${getDiasParadoHtml(item, desde)}</td>
          <td style="white-space:nowrap; color:var(--text-muted); font-size:12px;">${desde}</td>
        </tr>`;
      }).join('');
    }
  }
  // Mobile cards for Fuera de Servicio
  const fueraMobile = el('pt-fuera-mobile-cards');
  if (fueraMobile) {
    fueraMobile.innerHTML = fueraDeServicio.length === 0
      ? '<p style="text-align:center;color:var(--text-muted);padding:12px 0;">No hay unidades fuera de servicio.</p>'
      : fueraDeServicio.map(item => {
          const internoPT = String(item.interno || '');
          const desde = item.dia_parado || item.fecha_ingreso || item.ingreso || '—';
          return `<div class="pt-mobile-card" style="padding:12px; margin-bottom:10px; background:var(--card-bg); border-radius:8px; border:1px solid #e2e8f0; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
            <div class="pt-mobile-card-header" style="display:flex; justify-content:space-between; align-items:center;">
              <div><strong style="font-size:16px;">${internoPT}</strong>${item.tipo ? `<span style="font-size:12px; color:var(--text-muted); margin-left:6px;">(${item.tipo})</span>` : ''}${getEstadoTrabajoBadgeHtml(item)}</div>
              ${getDiasParadoHtml(item, desde)}
            </div>
            <div class="pt-mobile-card-row" style="margin-top:4px; font-size:12px; color:var(--text-muted);"><span>Ingreso: <strong>${desde}</strong></span></div>
            <div style="margin:10px 0; padding:8px; background:var(--card-bg); border-radius:6px; border:1px solid #e2e8f0;">
              <div style="font-weight:600; font-size:11px; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">Novedades / Tareas Pendientes:</div>
              ${getChecklistHtml(item, internoPT)}
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; align-items:center; justify-content:space-between;">
              ${getOrdenBtnHtml(internoPT)}
              ${getEditBtnHtml(internoPT, 'fuera_de_servicio')}
            </div>
          </div>`;
        }).join('');
  }

  // 2. En reparación
  const reparacion = separarOtros((displayState.reparacion || []).filter(matchesPtSector).filter(unitMatchesSearch), 'reparacion')
    .sort((a, b) => getDaysValue(b) - getDaysValue(a));
  if (el('pt-rep-count')) el('pt-rep-count').textContent = reparacion.length;
  if (el('stat-active-orders')) el('stat-active-orders').textContent = reparacion.length;
  if (el('pt-reparacion-tbody')) {
    if (reparacion.length === 0) {
      el('pt-reparacion-tbody').innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-muted);">No hay unidades en reparación.</td></tr>';
    } else {
      el('pt-reparacion-tbody').innerHTML = reparacion.map(item => {
        const internoPT = String(item.interno || '');
        const hasRodadoDesc = item.rodado && String(item.rodado).trim().toUpperCase() !== internoPT.trim().toUpperCase();
        const displayLabel = (currentSelectedSector === 'Herrería' && hasRodadoDesc)
          ? `<strong>${internoPT}</strong><div style="font-size:11px; color:var(--text-muted); font-weight:normal; margin-top:2px;">${item.rodado}</div>`
          : `<strong>${internoPT}</strong>`;
        const desde = item.dia_parado || item.fecha_ingreso || item.ingreso || '—';
        return `<tr>
          <td><div style="display:flex; align-items:center; gap:4px; line-height:1.2;">${displayLabel} ${getEstadoTrabajoBadgeHtml(item)} ${getEditBtnHtml(internoPT, 'reparacion')}</div></td>
          <td><span style="font-size:11px;">${item.tipo || '—'}</span></td>
          <td style="min-width:220px;">${getChecklistHtml(item, internoPT)}</td>
          <td style="white-space:nowrap;">${getOrdenBtnHtml(internoPT)}</td>
          <td style="white-space:nowrap;">${getDiasParadoHtml(item, desde)}</td>
          <td style="white-space:nowrap; color:var(--text-muted); font-size:12px;">${desde}</td>
        </tr>`;
      }).join('');
    }
  }
  // Mobile cards for En Reparación
  const repMobile = el('pt-rep-mobile-cards');
  if (repMobile) {
    repMobile.innerHTML = reparacion.length === 0
      ? '<p style="text-align:center;color:var(--text-muted);padding:12px 0;">No hay unidades en reparación.</p>'
      : reparacion.map(item => {
          const internoPT = String(item.interno || '');
          const desde = item.dia_parado || item.fecha_ingreso || item.ingreso || '—';
          return `<div class="pt-mobile-card" style="padding:12px; margin-bottom:10px; background:var(--card-bg); border-radius:8px; border:1px solid #e2e8f0; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
            <div class="pt-mobile-card-header" style="display:flex; justify-content:space-between; align-items:center;">
              <div><strong style="font-size:16px;">${internoPT}</strong>${item.tipo ? `<span style="font-size:12px; color:var(--text-muted); margin-left:6px;">(${item.tipo})</span>` : ''}${getEstadoTrabajoBadgeHtml(item)}</div>
              ${getDiasParadoHtml(item, desde)}
            </div>
            <div class="pt-mobile-card-row" style="margin-top:4px; font-size:12px; color:var(--text-muted);"><span>Ingreso: <strong>${desde}</strong></span></div>
            <div style="margin:10px 0; padding:8px; background:var(--card-bg); border-radius:6px; border:1px solid #e2e8f0;">
              <div style="font-weight:600; font-size:11px; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">Tareas / Novedades Pendientes:</div>
              ${getChecklistHtml(item, internoPT)}
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; align-items:center; justify-content:space-between;">
              ${getOrdenBtnHtml(internoPT)}
              ${getEditBtnHtml(internoPT, 'reparacion')}
            </div>
          </div>`;
        }).join('');
  }

  // 3. Servicios pendientes
  const pendientes = separarOtros((displayState.servicios_pendientes || []).filter(matchesPtSector).filter(unitMatchesSearch), 'servicios_pendientes');
  if (el('pt-pend-count')) el('pt-pend-count').textContent = pendientes.length;
  if (el('pt-pendientes-tbody')) {
    if (pendientes.length === 0) {
      el('pt-pendientes-tbody').innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">No hay servicios pendientes.</td></tr>';
    } else {
      el('pt-pendientes-tbody').innerHTML = pendientes.map(item => {
        const internoPT = String(item.interno || '');
        const hasRodadoDesc = item.rodado && String(item.rodado).trim().toUpperCase() !== internoPT.trim().toUpperCase();
        const displayLabel = (currentSelectedSector === 'Herrería' && hasRodadoDesc)
          ? `<strong>${internoPT}</strong><div style="font-size:11px; color:var(--text-muted); font-weight:normal; margin-top:2px;">${item.rodado}</div>`
          : `<strong>${internoPT}</strong>`;
        const servicio = item.servicio || item.tipo_servicio || '—';
        return `<tr>
          <td><div style="display:flex; align-items:center; gap:4px; line-height:1.2;">${displayLabel} ${getEditBtnHtml(internoPT, 'servicios_pendientes')}</div></td>
          <td><span style="font-size:11px;">${item.tipo || '—'}</span></td>
          <td style="min-width:220px;">${getChecklistHtml(item, internoPT)}</td>
          <td style="white-space:nowrap;">${getOrdenBtnHtml(internoPT)}</td>
          <td><span style="font-size:12px;">${servicio}</span></td>
        </tr>`;
      }).join('');
    }
  }
  // Mobile cards for Servicios Pendientes
  const pendMobile = el('pt-pend-mobile-cards');
  if (pendMobile) {
    pendMobile.innerHTML = pendientes.length === 0
      ? '<p style="text-align:center;color:var(--text-muted);padding:12px 0;">No hay servicios pendientes.</p>'
      : pendientes.map(item => {
          const internoPT = String(item.interno || '');
          const servicio = item.servicio || item.tipo_servicio || '—';
          return `<div class="pt-mobile-card" style="padding:12px; margin-bottom:10px; background:var(--card-bg); border-radius:8px; border:1px solid #e2e8f0; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
            <div class="pt-mobile-card-header" style="display:flex; justify-content:space-between; align-items:center;">
              <div><strong style="font-size:16px;">${internoPT}</strong>${item.tipo ? `<span style="font-size:12px; color:var(--text-muted); margin-left:6px;">(${item.tipo})</span>` : ''}</div>
              <span class="badge" style="background:#2196f3;color:white;font-size:11px;">${servicio}</span>
            </div>
            <div style="margin:10px 0; padding:8px; background:var(--card-bg); border-radius:6px; border:1px solid #e2e8f0;">
              <div style="font-weight:600; font-size:11px; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">Tareas / Novedades Pendientes:</div>
              ${getChecklistHtml(item, internoPT)}
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; align-items:center; justify-content:space-between;">
              ${getOrdenBtnHtml(internoPT)}
              ${getEditBtnHtml(internoPT, 'servicios_pendientes')}
            </div>
          </div>`;
        }).join('');
  }

  // 4. En Preparación (unidades recién compradas, todavía no tocaron la calle)
  const enPreparacion = separarOtros((displayState.inversiones || []).filter(matchesPtSector).filter(unitMatchesSearch), 'inversiones')
    .sort((a, b) => getDaysValue(b) - getDaysValue(a));
  if (el('pt-inversiones-count')) el('pt-inversiones-count').textContent = enPreparacion.length;
  if (el('pt-inversiones-tbody')) {
    if (enPreparacion.length === 0) {
      el('pt-inversiones-tbody').innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-muted);">No hay unidades en preparación.</td></tr>';
    } else {
      el('pt-inversiones-tbody').innerHTML = enPreparacion.map(item => {
        const internoPT = String(item.interno || '');
        const desde = item.dia_parado || item.fecha_ingreso || item.ingreso || '—';
        return `<tr>
          <td><div style="display:flex; align-items:center; gap:4px; line-height:1.2;">${getEditBtnHtml(internoPT, 'inversiones')} <strong>${internoPT}</strong></div></td>
          <td><span style="font-size:11px;">${item.tipo || '—'}</span></td>
          <td style="min-width:220px;">${getChecklistHtmlWithProgress(item, internoPT)}</td>
          <td style="white-space:nowrap;">${getOrdenBtnHtml(internoPT)}</td>
          <td style="white-space:nowrap;">${getDiasParadoHtml(item, desde)}</td>
          <td style="white-space:nowrap; color:var(--text-muted); font-size:12px;">${desde}</td>
        </tr>`;
      }).join('');
    }
  }
  // Mobile cards for En Preparación
  const invMobile = el('pt-inversiones-mobile-cards');
  if (invMobile) {
    invMobile.innerHTML = enPreparacion.length === 0
      ? '<p style="text-align:center;color:var(--text-muted);padding:12px 0;">No hay unidades en preparación.</p>'
      : enPreparacion.map(item => {
          const internoPT = String(item.interno || '');
          const desde = item.dia_parado || item.fecha_ingreso || item.ingreso || '—';
          return `<div class="pt-mobile-card" style="padding:12px; margin-bottom:10px; background:var(--card-bg); border-radius:8px; border:1px solid #e2e8f0; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
            <div class="pt-mobile-card-header" style="display:flex; justify-content:space-between; align-items:center;">
              <div><strong style="font-size:16px;">${internoPT}</strong>${item.tipo ? `<span style="font-size:12px; color:var(--text-muted); margin-left:6px;">(${item.tipo})</span>` : ''}</div>
              ${getDiasParadoHtml(item, desde)}
            </div>
            <div style="margin-top:4px; font-size:12px; color:var(--text-muted);">Ingresó el: <strong>${desde}</strong></div>
            <div style="margin:10px 0; padding:8px; background:var(--card-bg); border-radius:6px; border:1px solid #e2e8f0;">
              <div style="font-weight:600; font-size:11px; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">Detalles de Preparación:</div>
              ${getChecklistHtmlWithProgress(item, internoPT)}
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; align-items:center; justify-content:space-between;">
              ${getOrdenBtnHtml(internoPT)}
              ${getEditBtnHtml(internoPT, 'inversiones')}
            </div>
          </div>`;
        }).join('');
  }

  // 5. Herrería / Edilicio - everything pulled out of the 4 lists above by separarOtros()
  // because it isn't one of the 4 tracked fleet types. Shown all mixed together in one place
  // instead of scattered across (and cluttering) the truck-focused tables.
  const origenLabels = {
    fuera_de_servicio: 'Fuera de Servicio',
    reparacion: 'En Reparación',
    servicios_pendientes: 'Servicios Pendientes',
    inversiones: 'En Preparación'
  };
  if (el('pt-otros-count')) el('pt-otros-count').textContent = otrosItems.length;
  if (el('pt-otros-tbody')) {
    if (otrosItems.length === 0) {
      el('pt-otros-tbody').innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">No hay items de Herrería/Edilicio.</td></tr>';
    } else {
      el('pt-otros-tbody').innerHTML = otrosItems.map(({ item, origenLista }) => {
        const internoPT = String(item.interno || '');
        const desde = item.dia_parado || item.fecha_ingreso || item.ingreso || '—';
        return `<tr>
          <td><div style="display:flex; align-items:center; gap:4px; line-height:1.2;">${getEditBtnHtml(internoPT, origenLista)} <strong>${internoPT}</strong></div></td>
          <td><span style="font-size:11px;">${item.tipo || 'Otro'}</span></td>
          <td style="min-width:220px;">${getChecklistHtml(item, internoPT)}</td>
          <td><span class="badge" style="background:#e2e8f0; color:#334155; font-size:11px;">${origenLabels[origenLista] || origenLista}</span></td>
          <td style="white-space:nowrap; color:var(--text-muted); font-size:12px;">${desde}</td>
        </tr>`;
      }).join('');
    }
  }
}

// Which real person is actually working right now - drives the "Supervisor de Taller" field
// on the PDF automatically instead of picking it by hand every time. The logged-in browser
// account isn't a reliable signal here (paniol@ is a shared pañol login several different
// people use), but the "Responsable" of whichever order was created most recently reflects who
// is genuinely at the wheel at this moment.
const SUPERVISOR_USERNAME_MAP = {
  'paniol@contenedoreshugo.com.ar': 'Belocures Cèsar Hernàn',
  'a.brahim@contenedoreshugo.com.ar': 'Brahim Adrian',
  'sergios@contenedoreshugo.com.ar': 'Schirripa Sergio',
  'n.rodriguez@contenedoreshugo.com.ar': 'Rodriguez Nicolas'
};

function resolveSupervisorFromUsername() {
  const username = String(localStorage.getItem('currentUserUsername') || '').trim().toLowerCase();
  return SUPERVISOR_USERNAME_MAP[username] || null;
}

function resolveSupervisorFromLatestOrder() {
  if (!Array.isArray(activeOrders) || activeOrders.length === 0) return null;
  let latest = null;
  activeOrders.forEach(o => {
    if (!o || !o.createdAt || !o.responsable) return;
    if (!latest || new Date(o.createdAt).getTime() > new Date(latest.createdAt).getTime()) {
      latest = o;
    }
  });
  return latest ? latest.responsable : null;
}

function resolveCurrentSupervisor() {
  return resolveSupervisorFromLatestOrder() || resolveSupervisorFromUsername();
}

// An order's Responsable is stored as "Apellido, Nombre" (e.g. "Brahim, Hugo Adrian"), which
// doesn't match the sheet's dropdown value ("Brahim Adrian") character-for-character - a
// Data Validation dropdown set to reject invalid input silently discards a non-matching write,
// which is exactly why the cell kept showing the old name after a successful-looking sync.
// This maps any raw name to the one the dropdown actually accepts, or null if it isn't one of
// the 4 known supervisors at all (in which case the sheet sync should just skip, not overwrite
// it with something the dropdown will reject anyway).
function normalizeToCanonicalSupervisor(rawName) {
  const clean = String(rawName || '').toUpperCase();
  if (!clean) return null;
  if (clean.includes('BELOCURES')) return 'Belocures Cèsar Hernàn';
  if (clean.includes('BRAHIM')) return 'Brahim Adrian';
  if (clean.includes('SCHIRRIPA')) return 'Schirripa Sergio';
  if (clean.includes('RODRIGUEZ') && clean.includes('NICOLAS')) return 'Rodriguez Nicolas';
  return null;
}

// Keeps the supervisor selector in sync with whoever is actually working - only falls back
// to leaving it on manual selection when neither signal above resolves to anything.
function autoSetPtSupervisorSelect() {
  const select = document.getElementById('pt-supervisor-select');
  if (!select) return;
  const resolved = resolveCurrentSupervisor();
  if (!resolved) return;
  // The order's Responsable can be anyone, not just the 4 hardcoded options - setting
  // select.value to a name with no matching <option> silently deselects everything (blank
  // dropdown), so add it as an option first if it isn't already one of the fixed 4.
  const hasOption = Array.from(select.options).some(opt => opt.value === resolved);
  if (!hasOption) {
    const opt = document.createElement('option');
    opt.value = resolved;
    opt.textContent = resolved;
    select.appendChild(opt);
  }
  select.value = resolved;
}

// Pushes the resolved supervisor to the Google Sheet's Responsable cell independent of any
// task/novedad activity - syncTaskStartToParteTaller only fires (and only carries a
// responsable) when a task's description isn't already recorded there, which meant an order
// from a different person than last time never refreshed this if its task text happened to
// match something already synced. actualizar_responsable only touches that one cell, so it's
// safe to call on every Parte Taller refresh (including the 60s auto-refresh) without risk of
// duplicating or disturbing any novedad.
let lastSyncedResponsable = null;
async function syncResponsableToParteTaller() {
  try {
    const canonical = normalizeToCanonicalSupervisor(resolveCurrentSupervisor());
    if (!canonical || canonical === lastSyncedResponsable) return;
    lastSyncedResponsable = canonical;
    await fetch('/api/parte-taller/novedad', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: 'actualizar_responsable', responsable: canonical })
    });
  } catch (e) {
    console.error('Error sincronizando responsable a Parte Taller:', e);
  }
}

// Builds a print-ready copy of the currently-rendered dashboard cards + Transito/Fuera de
// Servicio/Reparacion/En Preparacion tables (Servicios Pendientes is deliberately left out -
// it's an operative-unit annotator, not part of what goes out of service) and sends it to the
// server to be rendered into a PDF via headless Chromium.
async function generarPdfParteTaller() {
  const btn = document.getElementById('pt-download-pdf-btn');
  const restoreBtn = () => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-icons" style="font-size: 16px;">picture_as_pdf</span><span>Descargar PDF</span>';
    }
  };
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-icons" style="font-size: 16px;">hourglass_top</span><span>Generando...</span>';
  }

  try {
    const cssRes = await fetch('style.css');
    const css = await cssRes.text();

    const statCardsEl = document.querySelector('.pt-stat-grid');
    const statCardsHtml = statCardsEl ? statCardsEl.outerHTML : '';
    const supervisorSelect = document.getElementById('pt-supervisor-select');
    const supervisorName = resolveCurrentSupervisor() || (supervisorSelect ? supervisorSelect.value : '');

    function sectionHtml(title, badgeColor, tbodyId, countBadgeId) {
      const tbody = document.getElementById(tbodyId);
      const table = tbody ? tbody.closest('table') : null;
      if (!table) return '';
      // Read the already-correct count off the section's own badge instead of counting <tr>
      // elements in the tbody - an empty list still renders one "No hay unidades..." row,
      // which would otherwise get counted as if it were a real item.
      const countBadge = countBadgeId ? document.getElementById(countBadgeId) : null;
      const count = countBadge ? countBadge.textContent.trim() : tbody.querySelectorAll('tr').length;

      // Clone (not mutate the live table) and paint the header row in the section's own
      // accent color - the cloned prev-table markup otherwise inherits the app's plain
      // light-gray header, which reads flat on a printed report.
      const tableClone = table.cloneNode(true);
      tableClone.querySelectorAll('thead th').forEach(th => {
        th.style.background = badgeColor;
        th.style.color = '#ffffff';
      });

      return `
        <h3 style="font-size:14px; font-weight:700; margin:18px 0 8px; display:flex; align-items:center; gap:8px;">
          ${title} <span style="background:${badgeColor}; color:white; font-size:11px; padding:2px 8px; border-radius:10px;">${count}</span>
        </h3>
        ${tableClone.outerHTML}`;
    }

    const now = new Date();
    const weekday = now.toLocaleDateString('es-AR', { weekday: 'long', timeZone: 'America/Argentina/Buenos_Aires' });
    const weekdayCap = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    const dateStr = now.toLocaleDateString('es-AR', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'America/Argentina/Buenos_Aires' });
    const timeStr = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' });

    const reportHtml = `
      <table style="width:100%; border-collapse:collapse; margin-bottom:14px;">
        <tr><td style="background:#1e293b; color:#fff; text-align:center; font-weight:700; font-size:18px; padding:10px;">PARTE DIARIO DE TALLER</td></tr>
        <tr><td style="background:#3b82f6; padding:2px;"></td></tr>
      </table>
      <table style="width:100%; border-collapse:collapse; margin-bottom:16px;">
        <tr>
          <td style="background:#eff6ff; padding:10px 14px; width:50%;">
            <div style="font-size:11px; font-weight:700; color:#2563eb; letter-spacing:0.05em;">RESPONSABLE DEL PARTE</div>
            <div style="font-size:16px; font-weight:800; color:#0f172a; margin-top:2px;">${(supervisorName || '—').toUpperCase()}</div>
          </td>
          <td style="background:#ecfdf5; padding:10px 14px; width:50%;">
            <div style="font-size:11px; font-weight:700; color:#059669; letter-spacing:0.05em;">FECHA Y HORA DE EMISIÓN</div>
            <div style="font-size:16px; font-weight:800; color:#0f172a; margin-top:2px;">${weekdayCap}, ${dateStr} - ${timeStr}</div>
          </td>
        </tr>
      </table>
      ${statCardsHtml}
      ${sectionHtml('En Tránsito', '#2563eb', 'pt-transito-tbody', 'pt-trans-count')}
      ${sectionHtml('Fuera de Servicio', '#ef4444', 'pt-fuera-tbody', 'pt-out-count')}
      ${sectionHtml('En Reparación', '#f97316', 'pt-reparacion-tbody', 'pt-rep-count')}
      ${sectionHtml('Unidades en Preparación', '#f59e0b', 'pt-inversiones-tbody', 'pt-inversiones-count')}
    `;

    const fullHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
      ${css}
      body { background: #fff; padding: 10px; }
      table { width: 100%; }
      .col-acciones, .action-cell, button { display: none !important; }
    </style></head><body>${reportHtml}</body></html>`;

    const res = await fetch('/api/parte-taller/generar-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: fullHtml })
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Error al generar el PDF.');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Parte_Taller_${new Date().toISOString().split('T')[0]}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('PDF generado correctamente', 'success');
  } catch (e) {
    console.error('Error generando PDF de Parte Taller:', e);
    showToast('Error al generar el PDF: ' + e.message, 'danger');
  } finally {
    restoreBtn();
  }
}

// Toggle Parte Taller section expand/collapse on mobile
function togglePtSection(sectionId) {
  const cards = document.getElementById(`pt-${sectionId}-mobile-cards`);
  const icon = document.getElementById(`pt-${sectionId}-toggle-icon`);
  if (!cards) return;
  const isVisible = cards.style.display !== 'none' && cards.style.display !== '';
  cards.style.display = isVisible ? 'none' : 'flex';
  if (icon) icon.textContent = isVisible ? 'expand_more' : 'expand_less';
}


// ============================================================
// PARTE TALLER — Orden helpers
// ============================================================

// Resolve Taxes interno from Parte Taller interno (standalone version used outside renderParteTallerDashboard scope)
function resolvePtTaxesInterno(internoPT) {
  const up = String(internoPT).trim().toUpperCase();
  if (up.includes('IRINEO')) return 'IRINEO GRAL.';
  if (up.startsWith('NICO ') || up === 'NICO') return 'VOLQUETE NICO';
  return internoPT;
}

// Opens the new-order modal pre-filled with an interno from Parte Taller
function ptCrearOrden(internoPT) {
  // Resolve the Taxes interno (Irineo -> IRINEO GRAL., Nico -> VOLQUETE NICO)
  const taxesInterno = resolvePtTaxesInterno(internoPT);

  switchView('orders');
  openNewOrderModal();
  const isHerreria = (getSectorByUsername(localStorage.getItem('currentUserUsername')) === 'Herrería');
  const internoSelect = document.getElementById('form-interno');
  const internoText  = document.getElementById('form-interno-text');
  if (internoSelect) {
    let optionExists = Array.from(internoSelect.options).some(opt => opt.value === taxesInterno);
    if (!optionExists) {
      const newOpt = document.createElement('option');
      newOpt.value = taxesInterno;
      newOpt.textContent = taxesInterno;
      internoSelect.appendChild(newOpt);
    }
    internoSelect.value = taxesInterno;
    if (internoSelect.rebuildSearchable) internoSelect.rebuildSearchable();
    internoSelect.dispatchEvent(new Event('change'));
  }
  if (internoText) {
    internoText.value = taxesInterno;
    internoText.dispatchEvent(new Event('change'));
  }
  const rodadoOpt = cachedCatalogs.rodados
    ? cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === String(taxesInterno).trim())
    : null;
  if (rodadoOpt) {
    const rodadoSelect = document.getElementById('form-rodado');
    const rodadoText   = document.getElementById('form-rodado-text');
    if (isHerreria) {
      if (rodadoText) { rodadoText.value = rodadoOpt.label; rodadoText.dispatchEvent(new Event('change')); }
    } else {
      if (rodadoSelect) {
        rodadoSelect.value = rodadoOpt.value;
        if (rodadoSelect.rebuildSearchable) rodadoSelect.rebuildSearchable();
        rodadoSelect.dispatchEvent(new Event('change'));
      }
    }
  }
  const clasificacionEl = document.getElementById('form-clasificacion');
  if (clasificacionEl) {
    clasificacionEl.value = 'Correctivo';
    if (clasificacionEl.rebuildSearchable) clasificacionEl.rebuildSearchable();
  }
}


// Reads checked items for a given interno and opens/creates an order with them as a task
// Reads checked items for a given interno, updates the checklist in Google Sheets (disappearing items/unit if completed), and assigns tasks to the order.
async function ptAsignarSeleccionados(interno) {
  const checkedBoxes = document.querySelectorAll(`.pt-item-checkbox[data-interno="${interno}"]:checked`);
  if (checkedBoxes.length === 0) {
    showToast('Seleccioná al menos un ítem para asignar.', 'warning');
    return;
  }
  const selectedTexts = Array.from(checkedBoxes).map(cb => cb.value);
  const combinedDesc  = selectedTexts.join('\n');

  // 1. Update the checklist in Google Sheets
  // Re-fetch the current state right before saving instead of reusing the possibly-stale
  // window._ptState snapshot: this save writes back the ENTIRE state, so if another user
  // added/edited units in the sheet after this browser last loaded the dashboard, saving the
  // old snapshot would silently erase their changes.
  let state = null;
  try {
    const freshRes = await fetch('/api/parte-taller/estado');
    const freshData = await freshRes.json();
    state = (freshData && freshData.state) ? freshData.state : freshData;
  } catch (err) {
    console.error('Error fetching fresh Parte Taller state before saving checklist selection:', err);
  }
  if (state) {
    const lists = ['fuera_de_servicio', 'reparacion', 'servicios_pendientes', 'inversiones'];
    let foundList = null;
    let foundUnit = null;
    let foundIdx = -1;

    for (const listName of lists) {
      if (state[listName]) {
        const idx = state[listName].findIndex(u => String(u.interno).trim() === String(interno).trim());
        if (idx !== -1) {
          foundList = listName;
          foundUnit = state[listName][idx];
          foundIdx = idx;
          break;
        }
      }
    }

    if (foundUnit) {
      let lines = [];
      if (Array.isArray(foundUnit.novedad_items)) {
        foundUnit.novedad_items.forEach(x => {
          const textClean = x.texto.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim();
          if (selectedTexts.includes(textClean)) {
            x.hecho = true;
          }
        });
        lines = foundUnit.novedad_items.map(x => {
          const prefix = x.hecho ? '[X]' : '[ ]';
          return `${prefix} ${x.texto.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim()}`;
        });
      } else {
        const rawLines = (foundUnit.novedad || '').split('\n');
        lines = rawLines.map(line => {
          const l = line.trim();
          if (!l) return '';
          const cleanText = l.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim();
          if (selectedTexts.includes(cleanText)) {
            return `[X] ${cleanText}`;
          }
          return l;
        }).filter(Boolean);
      }

      foundUnit.novedad = lines.join('\n');

      let pendingCount = 0;
      if (Array.isArray(foundUnit.novedad_items)) {
        pendingCount = foundUnit.novedad_items.filter(x => !x.hecho).length;
      } else {
        pendingCount = lines.filter(l => l.trim().startsWith('[ ]') || (!l.trim().startsWith('[X]') && !l.trim().startsWith('[x]'))).length;
      }

      if (pendingCount === 0) {
        state[foundList].splice(foundIdx, 1);
        showToast(`Unidad ${interno} quedó operativa al resolverse todos sus ítems pendientes ✓`, 'success');
      } else {
        state[foundList][foundIdx] = foundUnit;
      }

      try {
        const res = await fetch('/api/parte-taller/novedad', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accion: 'save_state',
            state: state
          })
        });
        if (res.ok) {
          fetchParteTallerEstado(); // Refresh table view to reflect item/unit disappearance
        }
      } catch (err) {
        console.error('Error saving state after checklist selection:', err);
      }
    }
  }

  // 2. Open or create the work order in Taxes
  const taxesInterno = resolvePtTaxesInterno(interno);
  const existingOrder = activeOrders && activeOrders.find(o =>
    String(o.interno || '').trim() === String(taxesInterno).trim() &&
    (!o.estado || o.estado.toLowerCase() !== 'cerrada')
  );


  if (existingOrder) {
    editOrder(existingOrder.id);
    setTimeout(() => {
      addTaskField({ descripcion: combinedDesc, centroCosto: '15', status: 'Pendiente' });
      showToast(`Ítem(s) agregado(s) a la Orden de Trabajo del Interno ${interno} ✓`, 'success');
    }, 200);
  } else {
    ptCrearOrden(interno);
    setTimeout(() => {
      addTaskField({ descripcion: combinedDesc, centroCosto: '15', status: 'Pendiente' });
      showToast(`Orden creada con los ítems seleccionados para Interno ${interno} ✓`, 'success');
    }, 200);
  }
}

// Variable to keep track of the current interno being edited in the modal
let currentEditingPtInterno = null;
let currentEditingPtOriginalList = null;


// Opens the modal for adding a new unit
function openPtAddUnitModal() {
  currentEditingPtInterno = null;
  currentEditingPtOriginalList = null;
  window._ptDuplicateEditInterno = null;
  window._ptDuplicateEditList = null;
  
  document.getElementById('pt-unit-modal-title').textContent = 'Agregar Unidad a Taller';
  document.getElementById('pt-unit-empresa').value = 'hugo';
  document.getElementById('pt-unit-interno').value = '';
  document.getElementById('pt-unit-interno').disabled = false;
  document.getElementById('pt-unit-tipo').value = 'COMPACTADOR';
  document.getElementById('pt-unit-estado').value = 'transito';
  document.getElementById('pt-unit-destino').value = 'fuera_de_servicio';
  document.getElementById('pt-unit-novedad').value = '';
  
  // Hide checklist editor, show plain textarea label
  const checkSection = document.getElementById('pt-unit-checklist-section');
  if (checkSection) checkSection.style.display = 'none';
  const novedadLabel = document.getElementById('pt-unit-novedad-label');
  if (novedadLabel) novedadLabel.textContent = 'Novedad / Diagnóstico / Servicio';

  ptOnEstadoChange();

  const saveBtn = document.getElementById('btn-save-pt-unit');
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Guardar Unidad';
  }

  document.getElementById('pt-unit-modal').classList.add('open');
}

function ptOnEstadoChange() {
  const estado = document.getElementById('pt-unit-estado').value;
  const destContainer = document.getElementById('pt-unit-destino-container');
  if (destContainer) {
    destContainer.style.display = (estado === 'transito') ? 'block' : 'none';
  }
}

// Opens the modal for editing an existing unit
function openPtEditUnitModal(interno, listName) {
  if (!window._ptState) return;
  const list = window._ptState[listName] || [];
  const item = list.find(u => String(u.interno).trim() === String(interno).trim());
  if (!item) return;

  currentEditingPtInterno = String(interno).trim();
  currentEditingPtOriginalList = listName;
  window._ptDuplicateEditInterno = null;
  window._ptDuplicateEditList = null;
  
  document.getElementById('pt-unit-modal-title').textContent = `Editar Unidad #${interno}`;
  
  // Detect company anywhere in the name (case-insensitive)
  let inputInternoVal = String(interno).trim();
  let empresaVal = 'hugo';
  const upperVal = inputInternoVal.toUpperCase();
  if (upperVal.includes('IRINEO')) {
    empresaVal = 'irineo';
    inputInternoVal = inputInternoVal.replace(/irineo/gi, '').replace(/[-_]/g, '').trim();
  } else if (upperVal.includes('NICO')) {
    empresaVal = 'nico';
    inputInternoVal = inputInternoVal.replace(/volquete\s+nico/gi, '').replace(/nico/gi, '').replace(/[-_]/g, '').trim();
  }

  document.getElementById('pt-unit-empresa').value = empresaVal;
  document.getElementById('pt-unit-interno').value = inputInternoVal;
  document.getElementById('pt-unit-interno').disabled = false;
  document.getElementById('pt-unit-tipo').value = item.tipo || 'COMPACTADOR';
  document.getElementById('pt-unit-estado').value = listName;
  document.getElementById('pt-unit-destino').value = item.destinoIngreso || 'fuera_de_servicio';
  ptOnEstadoChange();

  // --- Build interactive checklist editor with ALL items (pending + done) ---
  let allItems = []; // { texto, hecho }
  if (Array.isArray(item.novedad_items) && item.novedad_items.length > 0) {
    allItems = item.novedad_items.map(x => ({
      texto: x.texto.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim(),
      hecho: !!x.hecho
    }));
  } else if (item.novedad) {
    item.novedad.split('\n').forEach(line => {
      const l = line.trim();
      if (!l) return;
      const hecho = l.startsWith('[X]') || l.startsWith('[x]');
      const texto = l.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim();
      if (texto) allItems.push({ texto, hecho });
    });
  }

  const checkSection = document.getElementById('pt-unit-checklist-section');
  const checkEditor = document.getElementById('pt-unit-checklist-editor');
  if (allItems.length > 0 && checkSection && checkEditor) {
    checkEditor.innerHTML = allItems.map((it, idx) => {
      const safeId = `ptck_edit_${idx}`;
      const safeTxt = it.texto.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const doneStyle = it.hecho
        ? 'text-decoration:line-through; color:var(--text-muted);'
        : '';
      return `<label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; padding:4px 0; border-bottom:1px solid var(--border);">
        <input type="checkbox" class="pt-edit-item-checkbox" id="${safeId}" data-texto="${safeTxt}"
          ${it.hecho ? 'checked' : ''}
          style="margin-top:2px; accent-color:var(--primary); flex-shrink:0; width:16px; height:16px;"
          onchange="ptToggleEditItem(this)">
        <span id="${safeId}_lbl" style="font-size:13px; ${doneStyle}">${it.texto}</span>
      </label>`;
    }).join('');
    checkSection.style.display = 'block';
  } else if (checkSection) {
    checkSection.style.display = 'none';
  }

  // Clear the textarea (used for adding NEW items only)
  document.getElementById('pt-unit-novedad').value = '';
  const novedadLabel = document.getElementById('pt-unit-novedad-label');
  if (novedadLabel) novedadLabel.textContent = 'Agregar nuevos ítems (opcional)';

  document.getElementById('pt-unit-modal').classList.add('open');
}

// Closes the unit modal
function closePtUnitModal() {
  document.getElementById('pt-unit-modal').classList.remove('open');
}

async function markPtUnitOperativo() {
  const interno = document.getElementById('pt-unit-interno').value.trim();
  if (!interno) {
    showToast('El número de interno es obligatorio.', 'warning');
    return;
  }
  const empresa = document.getElementById('pt-unit-empresa').value;
  let saveInterno = interno;
  if (empresa === 'irineo') saveInterno = 'Irineo ' + interno;
  else if (empresa === 'nico') saveInterno = 'Nico ' + interno;

  // "Sin Novedades" discards ALL items of this unit (checked and unchecked alike) — nothing
  // moves to Servicios Pendientes. Warn before wiping if there's still an unchecked item or
  // unsaved text in "Agregar nuevos ítems", so it isn't used by mistake when there really is
  // something pending.
  const uncheckedCount = document.querySelectorAll('#pt-unit-checklist-editor .pt-edit-item-checkbox:not(:checked)').length;
  const newItemsText = (document.getElementById('pt-unit-novedad')?.value || '').trim();
  if (uncheckedCount > 0 || newItemsText) {
    const pieces = [];
    if (uncheckedCount > 0) pieces.push(`${uncheckedCount} ítem${uncheckedCount === 1 ? '' : 's'} sin marcar como realizado`);
    if (newItemsText) pieces.push(`el texto nuevo que escribiste en "Agregar nuevos ítems"`);
    const warnMsg = `Esta unidad todavía tiene ${pieces.join(' y ')}.\n\nMarcarla como "Operativo (Sin Novedades)" BORRA esos ítems — no los mueve a Servicios Pendientes.\n\n¿Continuar de todas formas?`;
    if (!confirm(warnMsg)) return;
  }

  const btn = document.getElementById('btn-pt-unit-operativo');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

  try {
    // Si la unidad ya estaba registrada en alguna lista de Parte Taller, sacarla (queda resuelta)
    // Re-fetch fresh instead of reusing window._ptState: this write replaces the ENTIRE state,
    // so a stale snapshot would silently erase units another user added/edited meanwhile.
    let state = null;
    if (currentEditingPtInterno) {
      try {
        const freshRes = await fetch('/api/parte-taller/estado');
        const freshData = await freshRes.json();
        state = (freshData && freshData.state) ? freshData.state : freshData;
      } catch (err) {
        console.error('Error fetching fresh Parte Taller state before marking operativo:', err);
      }
    }
    if (state) {
      const lists = ['transito', 'servicios_pendientes', 'reparacion', 'fuera_de_servicio', 'inversiones'];
      let removed = false;
      lists.forEach(listName => {
        if (state[listName]) {
          const idx = state[listName].findIndex(u => String(u.interno).trim() === currentEditingPtInterno);
          if (idx !== -1) { state[listName].splice(idx, 1); removed = true; }
        }
      });
      if (removed) {
        await fetch('/api/parte-taller/novedad', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accion: 'save_state', state: state })
        }).catch(() => {});
      }
    }

    showToast(`Unidad ${saveInterno} marcada como Operativa ✓`, 'success');
    closePtUnitModal();
    fetchParteTallerEstado();

    if (window._ptLinkedOrderId) {
      const linkedId = window._ptLinkedOrderId;
      window._ptLinkedOrderId = null;
      const targetOrder = (typeof activeOrders !== 'undefined' && Array.isArray(activeOrders)) ? activeOrders.find(o => o.id === linkedId) : null;
      try {
        await fetch(`/api/orders/${linkedId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-user-username': localStorage.getItem('currentUserUsername') || ''
          },
          body: JSON.stringify(targetOrder ? { ...targetOrder, estadoUnidad: 'operativo' } : { estadoUnidad: 'operativo' })
        }).catch(() => {});
      } catch (e) {}
      if (typeof fetchOrders === 'function') fetchOrders();
    }
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Error al marcar la unidad como operativa.', 'danger');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✅ Operativo (Sin Novedades)'; }
  }
}

// Toggles visual style when user checks/unchecks an item in the edit checklist
function ptToggleEditItem(checkbox) {
  const idx = checkbox.id.replace('ptck_edit_', '');
  const lbl = document.getElementById(`ptck_edit_${idx}_lbl`);
  if (!lbl) return;
  if (checkbox.checked) {
    lbl.style.textDecoration = 'line-through';
    lbl.style.color = 'var(--text-muted)';
  } else {
    lbl.style.textDecoration = '';
    lbl.style.color = '';
  }
}

// Moves a unit from En Tránsito to its target state (Fuera de Servicio / En Reparación / Servicios Pendientes) upon arrival
async function ingresarUnidadTransito(interno) {
  // Fetch the current state fresh instead of reusing window._ptState (which can be minutes
  // stale) and save the full result back with save_state: actualizar_estado_flota only knows
  // how to ADD a unit to its target list on the server, it has no idea "transito" exists, so
  // it never removed the entry there - the unit reappeared in Tránsito on the next refresh
  // because the server's own transito array was never told to drop it.
  let state = null;
  try {
    const freshRes = await fetch('/api/parte-taller/estado');
    const freshData = await freshRes.json();
    state = (freshData && freshData.state) ? freshData.state : freshData;
  } catch (err) {
    console.error('Error fetching fresh Parte Taller state before ingreso:', err);
  }
  if (!state) {
    showToast('No se pudo leer el estado actual del Parte Taller. No se realizó el ingreso.', 'danger');
    return;
  }
  const transList = state.transito || [];
  const unit = transList.find(u => String(u.interno).trim() === String(interno).trim());
  if (!unit) return;

  const targetEstado = unit.destinoIngreso || 'fuera_de_servicio';
  let targetLabel = 'Fuera de Servicio';
  if (targetEstado === 'reparacion') targetLabel = 'En Reparación';
  if (targetEstado === 'servicios_pendientes') targetLabel = 'Servicios Pendientes';

  if (!confirm(`¿Confirmás que la unidad Interno ${interno} ingresó al taller?\n\nPasará a la tabla "${targetLabel}".`)) {
    return;
  }

  const currentUser = localStorage.getItem('currentUserUsername') || 'Rodriguez Nicolas';
  const targetIntStr = String(interno).trim().toUpperCase();

  // 1. Remove ALL occurrences of this interno from transito array
  state.transito = (state.transito || []).filter(u => String(u.interno).trim().toUpperCase() !== targetIntStr);

  // 2. Set entry date & new state
  unit.estado = targetEstado;
  unit.dia_parado = new Date().toLocaleDateString('es-AR');
  unit.dias_en_reparacion = 0;
  unit.fecha_ingreso = new Date().toLocaleDateString('es-AR');
  delete unit.destinoIngreso;

  // 3. Add to target state list (removing any existing duplicate in target list first)
  if (!state[targetEstado]) state[targetEstado] = [];
  state[targetEstado] = state[targetEstado].filter(u => String(u.interno).trim().toUpperCase() !== targetIntStr);
  state[targetEstado].push(unit);

  window._ptState = state;
  // Re-render UI immediately
  renderParteTallerDashboard(state);

  // 4. Persist the full state (transito removal + target list addition together) - see the
  // comment above on why this can't be a targeted actualizar_estado_flota call.
  try {
    await fetch('/api/parte-taller/novedad', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: 'save_state', state })
    });
  } catch (e) {
    console.error('Error updating Parte Taller state on unit arrival:', e);
  }

  // 5. If moving to fuera_de_servicio or reparacion, auto-create Correctivo work order in Taxes if none exists
  if (targetEstado === 'reparacion' || targetEstado === 'fuera_de_servicio') {
    try {
      const cleanInterno = String(interno).replace(/^(Irineo|Nico)\s+/i, '');
      const hasOpenOrder = activeOrders && activeOrders.some(o =>
        String(o.interno || '').trim() === cleanInterno &&
        (!o.estado || o.estado.toLowerCase() !== 'cerrada')
      );
      if (!hasOpenOrder) {
        const today = new Date().toISOString().split('T')[0];
        let incidentDesc = unit.novedad || 'Ingreso desde En Tránsito';
        if (Array.isArray(unit.novedad_items)) {
          incidentDesc = unit.novedad_items.map(x => x.texto).join(', ');
        }
        incidentDesc = incidentDesc.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim();

        let rodadoLabel = `Interno ${cleanInterno}`;
        const rodadoOpt = cachedCatalogs.rodados
          ? cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === String(cleanInterno).trim())
          : null;
        if (rodadoOpt) rodadoLabel = rodadoOpt.label;

        const orderPayload = {
          rodado: rodadoLabel,
          responsable: "AUTO",
          interno: cleanInterno,
          clasificacion: "Correctivo",
          fechaEntrega: today,
          horario: "12:00",
          incidente: incidentDesc,
          tasks: [],
          // This block only runs for targetEstado 'reparacion' or 'fuera_de_servicio' (see the
          // `if` above) - both mean the unit isn't operational, so the order always has to
          // start Fuera de Servicio. The same COMPACTADOR/'operativo'-style literal-string bug
          // as savePtUnit() had: checking only 'fuera_de_servicio' let 'reparacion' fall through
          // to 'operativo' by mistake.
          estadoUnidad: 'fuera_de_servicio'
        };

        await fetch('/api/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-username': currentUser
          },
          body: JSON.stringify(orderPayload)
        });
      }
    } catch(err) {
      console.error('Error auto-creating work order on arrival:', err);
    }
  }

  showToast(`Unidad Interno ${interno} ingresó al taller y pasó a ${targetLabel} ✓`, 'success');
  renderParteTallerDashboard(state);
}


function ptCheckForDuplicateUnit() {
  if (currentEditingPtInterno !== null) return; // Ignore if we specifically clicked edit pencil

  const empresa = document.getElementById('pt-unit-empresa').value;
  const interno = document.getElementById('pt-unit-interno').value.trim();
  if (!interno) return;

  let searchInterno = interno;
  if (empresa === 'irineo') {
    searchInterno = 'Irineo ' + interno;
  } else if (empresa === 'nico') {
    searchInterno = 'Nico ' + interno;
  }

  if (!window._ptState) return;
  const state = window._ptState;
  const lists = ['transito', 'servicios_pendientes', 'reparacion', 'fuera_de_servicio', 'inversiones'];
  let foundUnit = null;
  let foundList = null;

  for (const listName of lists) {
    if (state[listName]) {
      const item = state[listName].find(u => String(u.interno).trim().toUpperCase() === searchInterno.trim().toUpperCase());
      if (item) {
        foundUnit = item;
        foundList = listName;
        break;
      }
    }
  }

  if (foundUnit) {
    // Found registered duplicate! Load its values and switch modal state to Editing
    document.getElementById('pt-unit-modal-title').textContent = `Editar Unidad #${searchInterno} (Ya registrada)`;
    document.getElementById('pt-unit-tipo').value = foundUnit.tipo || 'COMPACTADOR';
    document.getElementById('pt-unit-estado').value = foundList;
    ptOnEstadoChange();

    let rawNovedadText = '';
    if (Array.isArray(foundUnit.novedad_items)) {
      rawNovedadText = foundUnit.novedad_items.map(x => {
        const prefix = x.hecho ? '[X]' : '[ ]';
        return `${prefix} ${x.texto.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim()}`;
      }).join('\n');
    } else {
      rawNovedadText = foundUnit.novedad || '';
    }
    document.getElementById('pt-unit-novedad').value = rawNovedadText;
    
    window._ptDuplicateEditInterno = searchInterno;
    window._ptDuplicateEditList = foundList;
    showToast(`La unidad #${searchInterno} ya está registrada. Cargando novedades existentes...`, 'info');
  } else {
    // Clean if we previously auto-switched
    if (window._ptDuplicateEditInterno) {
      document.getElementById('pt-unit-modal-title').textContent = 'Agregar Unidad a Taller';
      document.getElementById('pt-unit-novedad').value = '';
      window._ptDuplicateEditInterno = null;
      window._ptDuplicateEditList = null;
    }
  }
}


// Handles change of company in the modal
function ptOnEmpresaChange() {
  const empresa = document.getElementById('pt-unit-empresa').value;
  const tipoSelect = document.getElementById('pt-unit-tipo');
  if (empresa === 'irineo' || empresa === 'nico') {
    tipoSelect.value = 'VOLQUETE';
  } else {
    ptOnInternoChange();
  }
  ptCheckForDuplicateUnit();
}

// Auto-fills unit type from interno selection (only for Hugo)
function ptOnInternoChange() {
  ptCheckForDuplicateUnit();

  const empresa = document.getElementById('pt-unit-empresa').value;
  if (empresa !== 'hugo') return;

  const interno = document.getElementById('pt-unit-interno').value.trim();
  if (!interno) return;
  const rodadoOpt = cachedCatalogs.rodados
    ? cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === String(interno).trim())
    : null;
  // Ground truth is Base_Datos' own "equipo" column (via getUnitTipoForInterno, the same
  // resolver used everywhere else in Parte Taller) - not a keyword guess off the rodado LABEL
  // (brand/model, e.g. "MERCEDES BENZ ATEGO 1725"), which almost never contains "VOLQ"/"ROLL"/
  // "PLANCHA" and so always fell through to the hardcoded COMPACTADOR default.
  if (rodadoOpt) {
    // The <select>'s own "Otro" option is spelled "OTRO" - getUnitTipoForInterno returns
    // title-case 'Otro', and `select.value = X` silently selects nothing on a case mismatch
    // (no matching <option>), leaving the dropdown showing whatever was there before.
    const resolvedTipo = getUnitTipoForInterno(interno);
    document.getElementById('pt-unit-tipo').value = (resolvedTipo === 'Otro') ? 'OTRO' : resolvedTipo;
  }
}

// Submits the unit add/edit data
async function savePtUnit() {
  const saveBtn = document.getElementById('btn-save-pt-unit');
  const empresa = document.getElementById('pt-unit-empresa').value;
  const interno = document.getElementById('pt-unit-interno').value.trim();
  const tipo = document.getElementById('pt-unit-tipo').value;
  const estado = document.getElementById('pt-unit-estado').value;
  const destinoIngreso = document.getElementById('pt-unit-destino').value;
  const novedadText = document.getElementById('pt-unit-novedad').value.trim();
  const currentUser = localStorage.getItem('currentUserUsername') || 'Rodriguez Nicolas';

  if (!interno) {
    showToast('El número de interno es obligatorio.', 'warning');
    return;
  }

  // In EDIT mode: read from interactive checklist + textarea (new items)
  // In ADD mode: only textarea — require at least 1 item
  let novedadFormatted = '';

  if (currentEditingPtInterno || window._ptDuplicateEditInterno) {
    // EDIT MODE: combine checklist checkbox states + new items from textarea
    const checkboxes = document.querySelectorAll('#pt-unit-checklist-editor .pt-edit-item-checkbox');
    const existingLines = Array.from(checkboxes).map(cb => {
      const txt = cb.dataset.texto || '';
      const prefix = cb.checked ? '[X]' : '[ ]';
      return `${prefix} ${txt}`;
    });

    const newLinesRaw = document.getElementById('pt-unit-novedad').value.trim();
    const newLines = newLinesRaw ? newLinesRaw.split('\n').map(line => {
      const l = line.trim();
      if (!l) return '';
      if (!l.startsWith('[ ]') && !l.startsWith('[X]') && !l.startsWith('[x]')) {
        return '[ ] ' + l;
      }
      return l;
    }).filter(Boolean) : [];

    const allLines = [...existingLines, ...newLines];
    // Filter out fully empty or whitespace-only lines
    novedadFormatted = allLines.filter(Boolean).join('\n');

    // If no items at all remain, that's allowed in edit mode (unit will be cleaned up)
    if (!novedadFormatted) novedadFormatted = '';
  } else {
    // ADD MODE: require at least 1 novedad in the textarea
    const novedadText = document.getElementById('pt-unit-novedad').value.trim();
    if (!novedadText) {
      showToast('Debe ingresar al menos una novedad.', 'warning');
      return;
    }
    novedadFormatted = novedadText.split('\n').map(line => {
      const l = line.trim();
      if (!l) return '';
      if (!l.startsWith('[ ]') && !l.startsWith('[X]') && !l.startsWith('[x]')) {
        return '[ ] ' + l;
      }
      return l;
    }).filter(Boolean).join('\n');
  }

  // Prevent duplicate submits (disabling button)
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Guardando...';
  }

  // Auto-switch to edit mode if we found a duplicate via auto-detection
  if (!currentEditingPtInterno && window._ptDuplicateEditInterno) {
    currentEditingPtInterno = window._ptDuplicateEditInterno;
    currentEditingPtOriginalList = window._ptDuplicateEditList;
  }

  // Format saved interno with prefix if Irineo or Volquete Nico
  let saveInterno = interno;
  if (empresa === 'irineo') {
    saveInterno = 'Irineo ' + interno;
  } else if (empresa === 'nico') {
    saveInterno = 'Nico ' + interno;
  }

  try {
    // If ADDING a unit
    if (!currentEditingPtInterno) {

      // 1. Save to Google Sheets state
      const res = await fetch('/api/parte-taller/novedad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accion: 'actualizar_estado_flota',
          interno: saveInterno,
          estado: estado,
          destinoIngreso: (estado === 'transito' ? destinoIngreso : null),
          motivo: novedadFormatted,
          responsable: currentUser,
          sector: (getSectorByUsername(currentUser) === 'Herrería') ? 'herreria' : 'taller'
        })
      });
      if (!res.ok) throw new Error('Error al registrar la novedad en el Parte Taller.');

      // 2. Automatically generate a Correctivo work order in Taxes if reparación or fuera_de_servicio
      if (estado === 'reparacion' || estado === 'fuera_de_servicio') {
        let rodadoLabel = '';
        let internoVal = '';
        if (empresa === 'irineo') {
          rodadoLabel = 'IRINEO GRAL. IRINEO GRAL. Interno IRINEO GRAL.';
          internoVal = 'IRINEO GRAL.';
        } else if (empresa === 'nico') {
          rodadoLabel = 'VOLQUETE NICO VOLQUETE NICO Interno VOLQUETE NICO';
          internoVal = 'VOLQUETE NICO';
        } else {
          const rodadoOpt = cachedCatalogs.rodados
            ? cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === String(interno).trim())
            : null;
          rodadoLabel = rodadoOpt ? rodadoOpt.label : `Interno ${interno}`;
          internoVal = interno;
        }

        const today = new Date().toISOString().split('T')[0];
        const incidentDesc = novedadFormatted.split('\n').map(l => l.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim()).filter(Boolean).join(', ');

        const autoSectorHerreria = (getSectorByUsername(currentUser) === 'Herrería');

        const orderPayload = {
          rodado: rodadoLabel,
          responsable: "AUTO",
          interno: internoVal,
          clasificacion: autoSectorHerreria ? "Herrería" : "Correctivo",
          fechaEntrega: today,
          horario: "12:00",
          incidente: incidentDesc || "Revisión en taller",
          // No se auto-generan tareas: el empleado/horas quedaban con un valor de relleno
          // (el primer empleado del catálogo, 1hs fija) que no era real. La orden se crea
          // vacía de tareas, igual que en el modo edición, y el usuario las carga a mano.
          tasks: [],
          // This block only runs for estado 'reparacion' or 'fuera_de_servicio' (see the `if`
          // above) - both mean the unit is NOT operational, so the auto-created order always
          // has to start Fuera de Servicio. Checking only the literal string 'fuera_de_servicio'
          // here left 'reparacion' falling through to 'operativo' by mistake - the order's own
          // switch showed Operativo for a unit that was actually down for repair.
          estadoUnidad: 'fuera_de_servicio'
        };

        const orderRes = await fetch('/api/orders', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-user-username': localStorage.getItem('currentUserUsername') || ''
          },
          body: JSON.stringify(orderPayload)
        });
        if (!orderRes.ok) {
          console.error('Error auto-creating work order in Taxes.');
        } else {
          showToast(`Unidad registrada y Orden de Trabajo Correctiva creada ✓`, 'success');
        }
      } else if (estado === 'transito') {
        showToast(`Unidad #${saveInterno} agregada a En Tránsito ✓`, 'success');
      } else {
        showToast('Unidad agregada con éxito a Servicios Pendientes.', 'success');
      }
    } 
    // If EDITING an existing unit
    else {
      // Re-fetch the current state right before saving instead of reusing the possibly-stale
      // window._ptState snapshot captured whenever this dashboard was last loaded: this save
      // writes back the ENTIRE state, so an old snapshot would silently erase any units
      // another user added/edited in the sheet since then.
      let state = null;
      try {
        const freshRes = await fetch('/api/parte-taller/estado');
        const freshData = await freshRes.json();
        state = (freshData && freshData.state) ? freshData.state : freshData;
      } catch (err) {
        console.error('Error fetching fresh Parte Taller state before saving edit:', err);
      }
      if (!state) {
        showToast('No se pudo leer el estado actual del Parte Taller. No se guardó nada.', 'danger');
        return;
      }

      // 1. Remove from all lists to start clean (using original internally stored interno)
      const lists = ['transito', 'servicios_pendientes', 'reparacion', 'fuera_de_servicio', 'inversiones'];
      let foundUnitObj = null;

      lists.forEach(listName => {
        if (state[listName]) {
          const idx = state[listName].findIndex(u => String(u.interno).trim() === currentEditingPtInterno);
          if (idx !== -1) {
            foundUnitObj = state[listName][idx];
            state[listName].splice(idx, 1);
          }
        }
      });

      // If all items are done and no new items were added → unit is fully resolved, remove it
      const hasNoItems = !novedadFormatted || novedadFormatted.trim() === '';
      const hasPendingItems = novedadFormatted && novedadFormatted.split('\n').some(l => l.trim().startsWith('[ ]'));

      if (!hasNoItems) {
        // Items remain — update and re-add to the target list
        if (!foundUnitObj) {
          foundUnitObj = { interno: saveInterno, tipo, dia_parado: new Date().toLocaleDateString('es-AR') };
        }

        // 2. Update properties
        foundUnitObj.interno = saveInterno;
        foundUnitObj.tipo = tipo;
        foundUnitObj.novedad = novedadFormatted;
        foundUnitObj.destinoIngreso = (estado === 'transito' ? destinoIngreso : null);
        // Also update novedad_items so the checklist re-renders correctly
        foundUnitObj.novedad_items = novedadFormatted.split('\n').map(line => {
          const hecho = line.startsWith('[X]') || line.startsWith('[x]');
          const texto = line.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim();
          return { texto, hecho };
        }).filter(x => x.texto);
        // Preserve sector tag
        const userSectorForSave = getSectorByUsername(currentUser);
        if (userSectorForSave === 'Herrería') foundUnitObj.sector = 'herreria';
        else if (!foundUnitObj.sector) foundUnitObj.sector = 'taller';
        
        // If moved from operative to inoperative, update dia_parado
        const oldWasOperative = (currentEditingPtOriginalList === 'servicios_pendientes');
        const newIsOperative = (estado === 'servicios_pendientes');
        if (oldWasOperative && !newIsOperative) {
          foundUnitObj.dia_parado = new Date().toLocaleDateString('es-AR');
          foundUnitObj.dias_en_reparacion = 0;
        }

        // Add to new list
        if (!state[estado]) state[estado] = [];
        state[estado].push(foundUnitObj);
      }
      // else: unit is fully done, it was already removed from all lists above — leave it out

      // Recalculate totals client-side
      state.resumen = state.resumen || {};
      state.resumen.responsable = currentUser;

      // 3. Save entire state to Google Sheet
      const res = await fetch('/api/parte-taller/novedad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accion: 'save_state',

          state: state
        })
      });
      if (!res.ok) throw new Error('Error al guardar los cambios en el Parte Taller.');

      // 4. Auto-create work order if state changed to reparación or fuera_de_servicio and there's no open order
      if (hasNoItems) {
        showToast(`Unidad ${saveInterno} quedó operativa al resolverse todos sus ítems pendientes ✓`, 'success');
      } else if (estado === 'reparacion' || estado === 'fuera_de_servicio') {
        let internoVal = (empresa === 'irineo') ? 'IRINEO GRAL.' : (empresa === 'nico' ? 'VOLQUETE NICO' : interno);
        const hasOpenOrder = activeOrders && activeOrders.some(o =>
          String(o.interno || '').trim() === internoVal &&
          (!o.estado || o.estado.toLowerCase() !== 'cerrada')
        );
        if (!hasOpenOrder) {
          let rodadoLabel = '';
          if (empresa === 'irineo') {
            rodadoLabel = 'IRINEO GRAL. IRINEO GRAL. Interno IRINEO GRAL.';
          } else if (empresa === 'nico') {
            rodadoLabel = 'VOLQUETE NICO VOLQUETE NICO Interno VOLQUETE NICO';
          } else {
            const rodadoOpt = cachedCatalogs.rodados
              ? cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === String(interno).trim())
              : null;
            rodadoLabel = rodadoOpt ? rodadoOpt.label : `Interno ${interno}`;
          }

          const today = new Date().toISOString().split('T')[0];
          const incidentDesc = novedadFormatted.split('\n').map(l => l.replace(/^\[\s*\]\s*/, '').replace(/^\[X\]\s*/i, '').trim()).filter(Boolean).join(', ');

          const orderPayload = {
            rodado: rodadoLabel,
            responsable: "AUTO",
            interno: internoVal,
            clasificacion: "Correctivo",
            fechaEntrega: today,
            horario: "12:00",
            incidente: incidentDesc,
            tasks: [],
            // This only runs for estado 'reparacion' or 'fuera_de_servicio' (see the `else if`
            // above) - both mean the unit is NOT operational, so the auto-created order always
            // has to start Fuera de Servicio. Checking only the literal string
            // 'fuera_de_servicio' left 'reparacion' falling through to 'operativo' by mistake -
            // same bug already fixed for the "brand-new unit" path above.
            estadoUnidad: 'fuera_de_servicio'
          };

          await fetch('/api/orders', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'x-user-username': localStorage.getItem('currentUserUsername') || ''
            },
            body: JSON.stringify(orderPayload)
          });
          showToast(`Unidad actualizada y Orden de Trabajo Correctiva creada ✓`, 'success');
        } else {
          showToast('Unidad actualizada con éxito.', 'success');
        }
      } else {
        showToast('Unidad actualizada con éxito.', 'success');
      }
    }

    closePtUnitModal();
    // Refresh activeOrders BEFORE re-rendering the Parte Taller dashboard - otherwise the
    // "Abrir Orden / Crear Orden" button on this unit still doesn't see the OT that was just
    // auto-created above, and a supervisor clicking "Crear Orden" right after ends up creating
    // a duplicate instead of opening the one that already exists.
    if (typeof fetchOrders === 'function') await fetchOrders();
    fetchParteTallerEstado();

    if (window._ptLinkedOrderId) {
      const linkedId = window._ptLinkedOrderId;
      window._ptLinkedOrderId = null;
      const targetOrder = (typeof activeOrders !== 'undefined' && Array.isArray(activeOrders)) ? activeOrders.find(o => o.id === linkedId) : null;
      const nuevoEstadoOrden = (estado === 'servicios_pendientes' || estado === 'transito') ? 'operativo' : 'fuera_de_servicio';
      
      if (targetOrder) {
        try {
          await fetch(`/api/orders/${linkedId}`, {
            method: 'PUT',
            headers: { 
              'Content-Type': 'application/json',
              'x-user-username': localStorage.getItem('currentUserUsername') || ''
            },
            body: JSON.stringify({
              ...targetOrder,
              estadoUnidad: nuevoEstadoOrden
            })
          }).catch(() => {});
        } catch (e) {}
      } else {
        try {
          await fetch(`/api/orders/${linkedId}`, {
            method: 'PUT',
            headers: { 
              'Content-Type': 'application/json',
              'x-user-username': localStorage.getItem('currentUserUsername') || ''
            },
            body: JSON.stringify({ estadoUnidad: nuevoEstadoOrden })
          }).catch(() => {});
        } catch (e) {}
      }
    }

    if (typeof fetchOrders === 'function') fetchOrders();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Error al guardar la unidad.', 'danger');
  } finally {
    // Re-enable save button
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Guardar Unidad';
    }
    // Clean duplicate edit state variables
    window._ptDuplicateEditInterno = null;
    window._ptDuplicateEditList = null;
  }
}

// ============================================================
// AGENT VERIFICATION SYSTEM FUNCTIONS
// ============================================================

function getVerificationBadgeHtml(order) {
  // Once an order has a real OT number in Taxes, the "Sin Controlar"/"Controlado" badge
  // stops being relevant - pedido explicito del usuario.
  if (order.taxesOrderNumber) return '';
  if (order.syncStatus !== 'success') return '';

  const count = order.verifiedCount || 0;

  if (order.verifiedStatus === 'success') {
    return `
      <span class="badge-status verified-success" onclick="event.stopPropagation(); triggerOrderVerification('${order.id}')" title="Controlado por el agente. Clic para volver a controlar." style="background-color: #eff6ff; color: #1d4ed8; border: 1px solid rgba(29,78,216,0.15); display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; font-size: 11px; font-weight: 600; border-radius: 4px; cursor: pointer; user-select: none;">
        <span class="material-icons" style="font-size: 13px; color: #1d4ed8; font-weight: bold;">check_circle</span>
        <span>Controlado x${count || 1}</span>
      </span>
    `;
  } else if (order.verifiedStatus === 'error') {
    const errorEscaped = String(order.verifiedError || 'Error desconocido').replace(/"/g, '&quot;').replace(/'/g, "\\'");
    return `
      <span class="badge-status verified-error" onclick="event.stopPropagation(); openVerificationErrorModal('${errorEscaped}', '${order.id}')" title="Fallo de control. Haga clic para ver errores." style="background-color: #fef2f2; color: #dc2626; border: 1px solid rgba(220,38,38,0.15); display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; font-size: 11px; font-weight: 600; border-radius: 4px; cursor: pointer; user-select: none;">
        <span class="material-icons" style="font-size: 13px; color: #dc2626; font-weight: bold;">cancel</span>
        <span>Error Control x${count || 1}</span>
      </span>
    `;
  } else if (order.verifiedStatus === 'checking') {
    return `
      <span class="badge-status verified-checking" style="background-color: #f9fafb; color: #4b5563; border: 1px solid rgba(75,85,99,0.15); display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; font-size: 11px; font-weight: 600; border-radius: 4px;">
        <span class="material-icons spinner" style="font-size: 13px; animation: spin 1.5s linear infinite; display: inline-block;">autorenew</span>
        <span>Controlando...</span>
      </span>
    `;
  } else {
    // Default idle state
    return `
      <span class="badge-status verified-idle" onclick="event.stopPropagation(); triggerOrderVerification('${order.id}')" title="Sin controlar. Haga clic para iniciar control en Taxes." style="background-color: #f3f4f6; color: #4b5563; border: 1px solid rgba(75,85,99,0.15); display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; font-size: 11px; font-weight: 600; border-radius: 4px; cursor: pointer; user-select: none;">
        <span class="material-icons" style="font-size: 13px; color: #4b5563;">help_outline</span>
        <span>Sin Controlar</span>
      </span>
    `;
  }
}

async function triggerOrderVerification(orderId) {
  try {
    const res = await fetch(`/api/orders/verify/${orderId}`, { 
      method: 'POST'
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'No se pudo iniciar el control');
    }
    showToast("Control encolado. El agente verificará los datos en Taxes en breve.", "info");
    
    // Set status to checking locally for instant UI update
    const order = activeOrders.find(o => o.id === orderId);
    if (order) {
      order.verifiedStatus = 'checking';
      renderOrders();
    }
    fetchOrders(); // Refresh in background
  } catch (error) {
    showToast(error.message, "danger");
  }
}

async function verifyAllOrders() {
  // Only verify orders that are synced (have a taxesOrderNumber) and not already checking
  const toVerify = activeOrders.filter(o =>
    o.taxesOrderNumber && o.verifiedStatus !== 'checking'
  );

  if (toVerify.length === 0) {
    showToast("No hay órdenes sincronizadas para controlar.", "info");
    return;
  }

  const btn = document.getElementById('btn-verify-all');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-icons" style="font-size:16px; animation: spin 1s linear infinite;">sync</span> Controlando...';
  }

  try {
    const res = await fetch('/api/orders/verify-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds: toVerify.map(o => o.id) })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showToast(data.error || 'Error al iniciar control masivo', 'danger');
    } else {
      // Mark locally as checking for instant UI update
      for (const order of toVerify) {
        order.verifiedStatus = 'checking';
      }
      renderOrders();
      showToast(`✅ ${data.queued} orden(es) enviadas al agente verificador. Los resultados aparecerán en breve.`, 'success');
      // Auto-refresh every 15s for up to 3 minutes to pick up results
      let polls = 0;
      const maxPolls = 12;
      const pollInterval = setInterval(async () => {
        await fetchOrders();
        polls++;
        if (polls >= maxPolls) clearInterval(pollInterval);
      }, 15000);
    }
  } catch (err) {
    showToast('Error de conexión al controlar: ' + err.message, 'danger');
  }

  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-icons" style="font-size:16px;">fact_check</span> Controlar Todas';
  }
}

// Clears every order stuck with a sync error back to 'pending' in one shot. This does NOT
// force Puppeteer to run immediately for each one - it just re-queues them, and the
// background worker (10s poll, one order at a time) syncs them at its own pace, so it
// doesn't fire a pile of browsers all at once.
async function retryAllFailedOrders() {
  const btn = document.getElementById('btn-retry-all-errors');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-icons" style="font-size:16px; animation: spin 1s linear infinite;">sync</span> Reintentando...';
  }

  try {
    const res = await fetch('/api/orders/retry-all-errors', { method: 'POST' });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showToast(data.error || 'Error al reintentar órdenes', 'danger');
    } else if (data.queued === 0) {
      showToast('No hay órdenes con error para reintentar.', 'info');
    } else {
      await fetchOrders();
      showToast(`✅ ${data.queued} orden(es) encoladas para resincronizar. Se irán procesando de a una.`, 'success');
    }
  } catch (err) {
    showToast('Error de conexión al reintentar: ' + err.message, 'danger');
  }

  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-icons" style="font-size:16px;">restart_alt</span> Reintentar Fallidas';
  }
}

let currentVerifyOrderId = null;

// Parses "Tarea #N (Empleado): No encontrada en el listado de tareas" out of the verifier's
// error text and builds step-by-step instructions (with the task's real data) for adding that
// task manually to the OT on taxes.com.ar — the same steps a person would otherwise have to ask
// for one at a time.
function buildMissingTaskGuide(errorMsg, order) {
  if (!order || !Array.isArray(order.tasks)) return '';
  const regex = /Tarea #(\d+)\s*\(([^)]*)\)\s*:\s*No encontrada en el listado de tareas/gi;
  const missing = [];
  let m;
  while ((m = regex.exec(String(errorMsg || ''))) !== null) {
    const task = order.tasks[parseInt(m[1], 10) - 1];
    if (task) missing.push({ empName: m[2].trim(), task });
  }
  if (missing.length === 0) return '';

  const ccLabel = (val) => {
    const opt = (cachedCatalogs.centrosCosto || []).find(c => String(c.value) === String(val));
    return opt ? opt.label : (val || '-');
  };

  const rows = missing.map(({ empName, task }) => {
    const hours = parseFloat(String(task.horasEstimadas || 0).replace(',', '.')) || 0;
    const desc = String(task.descripcion || '').replace(/</g, '&lt;').replace(/\n/g, '<br>');
    const insumos = task.insumos ? `<br><em>Insumos: ${String(task.insumos).replace(/</g, '&lt;')}</em>` : '';
    return `<tr>
      <td style="padding:6px 8px; border-bottom:1px solid #e0f2fe;"><strong>${empName}</strong></td>
      <td style="padding:6px 8px; border-bottom:1px solid #e0f2fe;">${ccLabel(task.centroCosto)}</td>
      <td style="padding:6px 8px; border-bottom:1px solid #e0f2fe;">${hours.toFixed(2)}</td>
      <td style="padding:6px 8px; border-bottom:1px solid #e0f2fe; font-size:12px;">${desc}${insumos}</td>
    </tr>`;
  }).join('');

  const otNum = order.taxesOrderNumber ? `#${String(order.taxesOrderNumber).replace(/^#/, '')}` : '(sin número de OT todavía)';

  return `
    <div style="margin-top:14px; padding:12px; background:#f0f9ff; border:1px solid #bae6fd; border-radius:8px;">
      <p style="margin:0 0 8px; font-weight:700; color:#0369a1; display:flex; align-items:center; gap:6px;">
        <span class="material-icons" style="font-size:18px;">build</span> Cómo agregar la${missing.length === 1 ? '' : 's'} tarea${missing.length === 1 ? '' : 's'} faltante${missing.length === 1 ? '' : 's'} en Taxes
      </p>
      <ol style="margin:0 0 10px; padding-left:20px; font-size:13px; color:#0c4a6e;">
        <li>Andá a <strong>Producción &gt; OT</strong>, buscá la OT <strong>${otNum}</strong> y hacé click en el lápiz de editar.</li>
        <li>Hacé click en <strong>"Agregar Tarea"</strong> ${missing.length} ${missing.length === 1 ? 'vez' : 'veces'} (una por cada fila de abajo).</li>
        <li>Completá cada tarjeta con estos datos y marcá <strong>Realizada</strong>:</li>
      </ol>
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:12px; background:#fff; border-radius:6px; overflow:hidden;">
          <thead>
            <tr style="background:#e0f2fe; text-align:left;">
              <th style="padding:6px 8px;">Empleado</th>
              <th style="padding:6px 8px;">Centro de Costo</th>
              <th style="padding:6px 8px;">Horas</th>
              <th style="padding:6px 8px;">Descripción</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p style="margin:8px 0 0; font-size:12px; color:#0369a1;">4. Guardá en Taxes y después tocá "Volver a Controlar" acá.</p>
    </div>
  `;
}

function openVerificationErrorModal(errorMsg, orderId) {
  currentVerifyOrderId = orderId;
  const formattedMsg = String(errorMsg || '').split(' | ').join('\n');
  document.getElementById('verify-error-modal-log').textContent = formattedMsg || 'No hay detalles de error.';

  const howtoEl = document.getElementById('verify-error-howto');
  if (howtoEl) {
    const order = (typeof activeOrders !== 'undefined' && Array.isArray(activeOrders) ? activeOrders.find(o => o.id === orderId) : null)
      || (typeof archivedOrders !== 'undefined' && Array.isArray(archivedOrders) ? archivedOrders.find(o => o.id === orderId) : null);
    howtoEl.innerHTML = buildMissingTaskGuide(errorMsg, order);
  }

  document.getElementById('verification-error-modal').classList.add('open');
}

function closeVerificationErrorModal() {
  document.getElementById('verification-error-modal').classList.remove('open');
  currentVerifyOrderId = null;
}

async function reverifyOrderFromModal() {
  if (currentVerifyOrderId) {
    const orderId = currentVerifyOrderId;
    closeVerificationErrorModal();
    await triggerOrderVerification(orderId);
  }
}

async function openDeletedLogModal() {
  const modal = document.getElementById('deleted-log-modal');
  const container = document.getElementById('deleted-log-table-container');
  if (!modal || !container) return;

  container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">Cargando registros de auditoría...</div>';
  modal.classList.add('open');

  try {
    const res = await fetch('/api/orders/deleted-log');
    if (!res.ok) throw new Error('Error al cargar registros');
    const logs = await res.json();

    if (!logs || logs.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:30px;color:var(--text-muted);">
          <span class="material-icons" style="font-size:36px;opacity:0.5;">assignment_turned_in</span>
          <p style="margin-top:8px;font-size:13px;">No hay registros de órdenes borradas por el agente aún.</p>
        </div>
      `;
      return;
    }

    let html = `
      <table class="data-table" style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:var(--bg-secondary);text-align:left;border-bottom:2px solid var(--border-color);">
            <th style="padding:8px 10px;">Fecha Borrado</th>
            <th style="padding:8px 10px;">N° O.T.</th>
            <th style="padding:8px 10px;">Interno</th>
            <th style="padding:8px 10px;">Empleado</th>
            <th style="padding:8px 10px;">Horas</th>
            <th style="padding:8px 10px;">Descripción</th>
            <th style="padding:8px 10px;text-align:center;">Taxes Realizada</th>
            <th style="padding:8px 10px;text-align:center;">Acción</th>
          </tr>
        </thead>
        <tbody>
    `;

    logs.slice().reverse().forEach(item => {
      const fechaStr = item.deletedAt ? new Date(item.deletedAt).toLocaleString('es-AR') : 'N/A';
      const orderIdTarget = item.id || item.numeroOrden || '';
      html += `
        <tr style="border-bottom:1px solid var(--border-color);">
          <td style="padding:8px 10px;white-space:nowrap;">${fechaStr}</td>
          <td style="padding:8px 10px;font-weight:600;color:#0ea5e9;">${item.numeroOrden || item.id || 'N/A'}</td>
          <td style="padding:8px 10px;">${item.interno || 'N/A'}</td>
          <td style="padding:8px 10px;">${item.empleado || 'N/A'}</td>
          <td style="padding:8px 10px;">${item.horas ? item.horas + ' hs' : '0 hs'}</td>
          <td style="padding:8px 10px;max-width:250px;word-break:break-word;">${item.descripcion || 'N/A'}</td>
          <td style="padding:8px 10px;text-align:center;">
            <span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:12px;font-weight:700;font-size:11px;">SI</span>
          </td>
          <td style="padding:8px 10px;text-align:center;">
            <button onclick="restoreOrderFromDeletedLog('${orderIdTarget}')" class="btn" style="background:#10b981;color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:4px;border:none;cursor:pointer;" title="Restaurar al Historial para re-sincronizar y controlar">
              <span class="material-icons" style="font-size:12px;vertical-align:middle;">restore</span> Restaurar
            </button>
          </td>
        </tr>
      `;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (err) {
    console.error('Error fetching deleted log:', err);
    container.innerHTML = `<div style="color:var(--danger-color);padding:16px;">Error al cargar registros: ${err.message}</div>`;
  }
}

async function restoreOrderFromDeletedLog(orderId) {
  if (!confirm('¿Restaurar esta orden al Historial para volver a sincronizarla y ver sus tareas?')) return;
  try {
    const res = await fetch(`/api/orders/${orderId}/restore`, { method: 'POST' });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    showToast('Orden restaurada exitosamente al Historial ✓', 'success');
    closeDeletedLogModal();
    await fetchArchivedOrders();
  } catch (err) {
    showToast('Error al restaurar orden: ' + err.message, 'danger');
  }
}

function closeDeletedLogModal() {
  const modal = document.getElementById('deleted-log-modal');
  if (modal) modal.classList.remove('open');
}

async function verifyAllHistoryOrders() {
  const btn = document.getElementById('btn-verify-history');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-icons" style="font-size:16px;">sync</span> Iniciando Control...';
  }

  try {
    const historyOrders = getFilteredArchivedOrders();
    const eligibleIds = historyOrders.map(o => o.id);

    if (eligibleIds.length === 0) {
      showToast('No hay órdenes archivadas en el historial para controlar.', 'warning');
      return;
    }

    const res = await fetch('/api/orders/verify-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds: eligibleIds })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al iniciar control');

    showToast(`✅ Control iniciado para ${data.queued || eligibleIds.length} orden(es) del historial. El agente las verificará en Taxes en breve.`, 'success');
    
    let polls = 0;
    const pollInterval = setInterval(() => {
      polls++;
      fetchOrders();
      if (polls >= 12) clearInterval(pollInterval);
    }, 5000);

  } catch (err) {
    showToast('Error de conexión al iniciar control: ' + err.message, 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-icons" style="font-size:16px;">fact_check</span> Ejecutar Control de Historial Ahora';
    }
  }
}

// ============================================================
// HUGO AI CHAT ASSISTANT FRONTEND LOGIC
// ============================================================

let hugoAIHistory = [];

function toggleHugoAIChat(show) {
  const modal = document.getElementById('hugo-ai-chat-modal');
  if (modal) {
    modal.style.display = show ? 'flex' : 'none';
  }
  if (show) {
    const input = document.getElementById('hugo-ai-input-message');
    if (input) input.focus();
  }
}

async function sendHugoAIMessage() {
  const input = document.getElementById('hugo-ai-input-message');
  const messagesList = document.getElementById('hugo-ai-messages-list');
  if (!input || !messagesList) return;

  const text = input.value.trim();
  if (!text) return;

  // Render user message
  const userMsgDiv = document.createElement('div');
  userMsgDiv.style.alignSelf = 'flex-end';
  userMsgDiv.style.maxWidth = '85%';
  userMsgDiv.style.background = '#2563eb';
  userMsgDiv.style.color = '#fff';
  userMsgDiv.style.padding = '12px 16px';
  userMsgDiv.style.borderRadius = '14px 14px 2px 14px';
  userMsgDiv.style.fontSize = '13.5px';
  userMsgDiv.style.lineHeight = '1.5';
  userMsgDiv.style.boxShadow = '0 2px 4px rgba(0,0,0,0.15)';
  userMsgDiv.style.fontFamily = "'Inter', sans-serif";
  userMsgDiv.innerText = text;
  messagesList.appendChild(userMsgDiv);

  // Clear input
  input.value = '';
  messagesList.scrollTop = messagesList.scrollHeight;

  // Render typing indicator
  const typingDiv = document.createElement('div');
  typingDiv.id = 'hugo-ai-typing-indicator';
  typingDiv.style.alignSelf = 'flex-start';
  typingDiv.style.maxWidth = '85%';
  typingDiv.style.background = '#1e293b';
  typingDiv.style.color = '#94a3b8';
  typingDiv.style.padding = '10px 14px';
  typingDiv.style.borderRadius = '12px 12px 12px 2px';
  typingDiv.style.fontSize = '13px';
  typingDiv.style.fontFamily = "'Inter', sans-serif";
  typingDiv.innerText = 'Escribiendo...';
  messagesList.appendChild(typingDiv);
  messagesList.scrollTop = messagesList.scrollHeight;

  try {
    const response = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: hugoAIHistory
      })
    });

    // Remove typing indicator
    const typingIndicator = document.getElementById('hugo-ai-typing-indicator');
    if (typingIndicator) typingIndicator.remove();

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Error en el asistente');
    }

    // Render assistant response
    const assistantMsgDiv = document.createElement('div');
    assistantMsgDiv.style.alignSelf = 'flex-start';
    assistantMsgDiv.style.maxWidth = '85%';
    assistantMsgDiv.style.background = '#1e293b';
    assistantMsgDiv.style.color = '#cbd5e1';
    assistantMsgDiv.style.padding = '12px 16px';
    assistantMsgDiv.style.borderRadius = '14px 14px 14px 2px';
    assistantMsgDiv.style.fontSize = '13.5px';
    assistantMsgDiv.style.lineHeight = '1.5';
    assistantMsgDiv.style.boxShadow = '0 2px 4px rgba(0,0,0,0.15)';
    assistantMsgDiv.style.fontFamily = "'Inter', sans-serif";
    
    // Support basic Markdown newlines
    assistantMsgDiv.innerHTML = data.response.replace(/\n/g, '<br>');
    messagesList.appendChild(assistantMsgDiv);

    // Save to conversation history
    hugoAIHistory.push({ role: 'user', text: text });
    hugoAIHistory.push({ role: 'model', text: data.response });
    
    // Limit local history to last 10 messages to save context overhead
    if (hugoAIHistory.length > 10) {
      hugoAIHistory = hugoAIHistory.slice(-10);
    }

  } catch (err) {
    // Remove typing indicator
    const typingIndicator = document.getElementById('hugo-ai-typing-indicator');
    if (typingIndicator) typingIndicator.remove();

    // Render error message
    const errorDiv = document.createElement('div');
    errorDiv.style.alignSelf = 'flex-start';
    errorDiv.style.maxWidth = '85%';
    errorDiv.style.background = '#7f1d1d';
    errorDiv.style.color = '#fca5a5';
    errorDiv.style.padding = '10px 14px';
    errorDiv.style.borderRadius = '12px 12px 12px 2px';
    errorDiv.style.fontSize = '13px';
    errorDiv.style.fontFamily = "'Inter', sans-serif";
    errorDiv.innerText = '⚠️ Error al conectar con Hugo AI: ' + err.message;
    messagesList.appendChild(errorDiv);
  }

  messagesList.scrollTop = messagesList.scrollHeight;
}

// NOTE: app init (checkUserSession, fetchSettings/fetchCatalogs/fetchOrders/fetchActiveMechanics)
// already happens in the main DOMContentLoaded handler near the top of this file, guarded behind
// an actual logged-in check. A second, unconditional DOMContentLoaded handler used to duplicate
// this here - besides fetching data even when logged out, it called checkUserSession() a second
// time on every load, which consumed the one-shot post-logout flag before the user ever saw the
// login screen long enough to use it, making "Cerrar Sesión" look like it logged back in on its
// own after a few seconds.
