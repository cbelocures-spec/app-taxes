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
let cachedNovelties = [];
let activeOrders = [];
let currentRetryOrderId = null;
let currentEditingOrderId = null;
let catalogSyncInterval = null;
let activeMechanicsList = [];
let selectedOrderIds = new Set();
let selectedHistoryOrderIds = new Set();
let isCurrentUserSupervisor = false;
let editModalHasRenderingError = false;

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
  "Federico",
  "Luciano",
  "Digno"
];

function populateDatalist(datalistId, options) {
  const el = document.getElementById(datalistId);
  if (!el) return;
  el.innerHTML = options.map(opt => `<option value="${opt.value}">${opt.label}</option>`).join('');
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

  // If logged in, fetch initial data
  if (localStorage.getItem('currentUserUsername')) {
    fetchSettings();
    fetchCatalogs();
    fetchOrders();
    fetchActiveMechanics();
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

          const taskInfo = {
            interno: internoVal,
            rodado: rodadoVal,
            empleado: empName,
            centroCosto: ccName,
            descripcion: descVal
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
          });
        }
      }
    });
  }

  // Poll for orders sync status in real time (1.5s so changes between supervisors appear fast)
  setInterval(fetchOrders, 1500);
  setInterval(checkWorkerStatus, 5000);
  setInterval(fetchSettingsPolling, 5000);

  // Fetch novelties from Google Sheet on startup
  fetchNovelties();

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
          showNoveltiesForInterno("");
        } else {
          // Taller / Admin / Edilicio: auto-populate Interno from rodado catalog data!
          const rodadoVal = rodadoSelect.value;
          const rodadoOpt = cachedCatalogs.rodados.find(r => String(r.value) === String(rodadoVal));
          if (rodadoOpt && rodadoOpt.interno) {
            internoInput.value = rodadoOpt.interno;
            showNoveltiesForInterno(rodadoOpt.interno);
          } else {
            internoInput.value = "";
            showNoveltiesForInterno("");
          }
        }
      }
    });
  }

function findRodadoForInterno(intVal) {
  const cleanInt = String(intVal || '').trim();
  if (!cleanInt) return null;
  return (cachedCatalogs.rodados || []).find(r => 
    String(r.interno || '').trim() === cleanInt ||
    String(r.value || '').trim() === cleanInt ||
    String(r.label || '').toUpperCase().includes(`INTERNO ${cleanInt}`)
  );
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
          if (rodadoOpt && rodadoSelect.value !== rodadoOpt.value) {
            rodadoSelect.value = rodadoOpt.value;
            rodadoSelect.dispatchEvent(new Event('change', { bubbles: true }));
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

  // Restore free mechanics visibility from localStorage
  applyFreeMechanicsVisibility();

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

// 1. SPA ROUTING
function switchView(viewId) {
  // Deactivate all views and nav items
  document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));

  // Activate selected
  const viewEl = document.getElementById(`view-${viewId}`);
  if (viewEl) viewEl.classList.add('active');

  const navEl = document.getElementById(`nav-${viewId}`);
  if (navEl) navEl.classList.add('active');

  // Clear selections when changing views to avoid floating bar leaks
  if (viewId !== 'orders') {
    selectedOrderIds.clear();
    updateBulkSyncActionBar();
    document.querySelectorAll('.order-select-checkbox').forEach(chk => chk.checked = false);
  }
  if (viewId !== 'history') {
    selectedHistoryOrderIds.clear();
    updateHistoryBulkDeleteActionBar();
    document.querySelectorAll('.history-order-select-checkbox').forEach(chk => chk.checked = false);
  }

  if (viewId === 'settings') {
    renderEmployeeHoursSummary();
  }

  if (viewId === 'bulk') {
    const container = document.getElementById('bulk-tasks-container');
    if (container && container.querySelectorAll('.bulk-task-item-card').length === 0) {
      addBulkTaskField();
    }
    // Always re-render vehicle selector to ensure it's populated (in case catalogs loaded after initial render)
    renderBulkVehicleSelector();
  }

  if (viewId === 'preventivos') {
    fetchPreventivoFlota();
  }

  if (viewId === 'partetaller') {
    fetchParteTallerEstado();
  }

  if (viewId === 'historial') {
    fetchArchivedOrders();
  }
}

// 2. MODAL CONTROLLERS
function openPreOrderModal() {
  setupAllFieldsForSector();

  // Reset the searchable select for Interno by repopulating and rebuilding it
  const preInternoSelect = document.getElementById('pre-form-interno');
  if (preInternoSelect) {
    if (cachedInternoOptions && cachedInternoOptions.length > 0) {
      populateSelect('pre-form-interno', cachedInternoOptions, "Seleccionar Interno...");
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
        if (labelSpan) labelSpan.textContent = 'Seleccionar Interno...';
      }
    }
  }
  const preInternoText = document.getElementById('pre-form-interno-text');
  if (preInternoText) {
    preInternoText.value = "";
  }

  // Ensure classification options match the current selected sector tab
  updateClassificationSelectOptions();

  // Reset the clasificacion select
  const clsEl = document.getElementById('pre-form-clasificacion');
  if (clsEl) {
    clsEl.value = "";
    if (clsEl.rebuildSearchable) {
      clsEl.rebuildSearchable();
    } else {
      const wrapper = clsEl.closest ? clsEl.closest('.searchable-select-container') : null;
      if (wrapper) {
        const searchInput = wrapper.querySelector('.searchable-select-search-input');
        if (searchInput) searchInput.value = '';
        const labelSpan = wrapper.querySelector('.trigger-label');
        if (labelSpan) labelSpan.textContent = 'Seleccionar Clasificación...';
      }
    }
  }

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

function updateDiagStatusLabel(isOperativo) {
  const label = document.getElementById('diag-status-label');
  if (!label) return;
  if (isOperativo) {
    label.textContent = 'Operativo';
    label.style.color = '#22c55e';
  } else {
    label.textContent = 'Fuera de Servicio';
    label.style.color = '#ef4444';
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

    // Reset collapsible insumos section to closed by default
    toggleDiagInsumosCollapse(false);
    updateDiagInsumosBadge();

    // Set up unit status toggle switch
    const statusSwitch = document.getElementById('diag-status-switch');
    let isOperativo = true;
    if (taskInfo && taskInfo.estadoUnidad) {
      isOperativo = (taskInfo.estadoUnidad === 'operativo');
    }
    if (statusSwitch) {
      statusSwitch.checked = isOperativo;
      updateDiagStatusLabel(isOperativo);
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
      const newUnitStatus = statusSwitch && statusSwitch.checked ? 'operativo' : 'fuera_de_servicio';

      closeModal();
      resolve({
        diagnosis: val || null,
        insumos: insumosVal || null,
        estadoUnidad: newUnitStatus
      });
    });

    newBtnSkip.addEventListener('click', () => {
      closeModal();
      resolve(null);
    });
  });
}


async function submitPreOrderCheck() {
  const currentUser = localStorage.getItem('currentUserUsername');
  const userSector = getSectorByUsername(currentUser);
  const isHerreria = (userSector === 'Herrería');

  const preInternoSelect = document.getElementById('pre-form-interno');
  const preInternoText = document.getElementById('pre-form-interno-text');
  
  let interno = preInternoSelect.value.trim();
  
  // Fallback if they typed in search box but didn't click/confirm (works for all sectors)
  if (!interno && preInternoSelect.closest) {
    const wrapper = preInternoSelect.closest('.searchable-select-container');
    const searchInput = wrapper ? wrapper.querySelector('.searchable-select-search-input') : null;
    if (searchInput && searchInput.value.trim()) {
      interno = searchInput.value.trim();
    }
  }

  const clasificacion = document.getElementById('pre-form-clasificacion').value;

  if (!interno || !clasificacion) {
    showToast("Por favor complete el Interno y la Clasificación", "danger");
    return;
  }

  const isCarmona = currentUser === 'jcarmona@contenedoreshugo.com.ar' || currentUser === 'j.carmona@contenedoreshugo.com.ar';

  let existingOrder = null;
  if (!isCarmona && userSector !== 'Herrería') {
    // Taller/Other sectors: Only block duplication if there is an active order for this interno
    // which is currently 'fuera_de_servicio'. If it is 'operativo', duplicate creation is allowed.
    existingOrder = activeOrders.find(o => {
      const isSameInterno = String(o.interno).trim() === String(interno);
      if (!isSameInterno) return false;
      return o.estadoUnidad === 'fuera_de_servicio';
    });
  }

  if (existingOrder) {
    const orderCls = existingOrder.clasificacion || "Sin Clasificar";
    showToast(`Abriendo orden en curso del interno ${interno} (${orderCls})...`, "warning");
    closePreOrderModal();
    editOrder(existingOrder.id);
  } else {
    closePreOrderModal();
    openNewOrderModal(interno, clasificacion);
  }
}

function openNewOrderModal(presetInterno = "", presetClasificacion = "") {
  currentEditingOrderId = null;
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

  // Auto-select matching Rodado
  const rodadoSelect = document.getElementById('form-rodado');
  if (rodadoSelect) {
    if (rodadoOpt) {
      rodadoSelect.value = rodadoOpt.value;
      rodadoSelect.dispatchEvent(new Event('change', { bubbles: true }));
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
  
  // Auto-populate Interno
  const internoSelect = document.getElementById('form-interno');
  if (internoSelect) {
    if (cachedInternoOptions && cachedInternoOptions.length > 0) {
      populateSelect('form-interno', cachedInternoOptions, "Seleccionar Interno...");
    }
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

  // Auto-populate Clasificación
  const clasificacionEl = document.getElementById('form-clasificacion');
  if (clasificacionEl && presetClasificacion) {
    clasificacionEl.value = presetClasificacion;
  }
  
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
  
  // Hide novelties panel
  showNoveltiesForInterno("");
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
  const order = activeOrders.find(o => o.id === orderId);
  if (!order) return;

  currentEditingOrderId = orderId;

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
  document.getElementById('form-clasificacion').value = order.clasificacion;
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
  const currentUsername = localStorage.getItem('currentUserUsername') || '';

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-username': currentUsername  // Tell server which user is saving
      },
      body: JSON.stringify({ portalUrl, username, password, googleScriptUrl, googleActiveTasksUrl, preventivoScriptUrl, parteTallerScriptUrl, geminiApiKey })
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

    // Extract unique internal numbers from rodados catalog, active orders, and complete range 1-250
    const rawInternos = (data.rodados || []).map(r => String(r.interno || '').trim()).filter(Boolean);
    if (Array.isArray(activeOrders)) {
      activeOrders.forEach(o => {
        if (o.interno) rawInternos.push(String(o.interno).trim());
      });
    }
    for (let i = 1; i <= 250; i++) {
      rawInternos.push(String(i));
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

    const internoOptions = uniqueInternos.map(int => ({ value: int, label: int }));
    cachedInternoOptions = internoOptions;
    populateSelect('form-interno', internoOptions, "Seleccionar Interno...");
    populateSelect('pre-form-interno', internoOptions, "Seleccionar Interno...");

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

    const cleanName = (str) => {
      if (typeof str !== 'string') return '';
      return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
    };

    if (isHerreriaCC) {
      // Herrería filter
      const herreriaNamesCleaned = new Set(HERRERIA_EMPLOYEES.map(name => cleanName(name)));
      
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

      // Add Federico, Luciano, Digno if not present
      const customHerreriaNames = ["Federico", "Luciano", "Digno"];
      customHerreriaNames.forEach(name => {
        const exists = matchedEmployees.some(emp => emp && emp.label && emp.label.toLowerCase().trim() === name.toLowerCase());
        if (!exists) {
          matchedEmployees.push({ value: name, label: name });
        }
      });

      filteredEmployees = matchedEmployees;

    } else if (isMecanicaCC) { // MECANICA
      const mecanicaNamesCleaned = new Set(MECANICA_EMPLOYEES.map(name => cleanName(name)));
      filteredEmployees = (cachedCatalogs.empleados || []).filter(emp => {
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
    return `<span style="display: inline-flex; align-items: center; gap: 2px; background: #e2e8f0; padding: 2px 5px; border-radius: 4px; font-size: 10px; color: var(--text-color);"><span class="material-icons" style="font-size: 10px;">${icon}</span>${label}: <strong>${item.formatted}</strong></span>`;
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
    let defaultCcVal = "15"; // default to MECANICA
    if (userSector === 'Herrería') {
      const herrOpt = (cachedCatalogs.centrosCosto || []).find(opt => opt && (opt.value === "16" || opt.value === "HERRERIA" || (opt.label && String(opt.label).toLowerCase().includes("herrer"))));
      if (herrOpt) {
        defaultCcVal = herrOpt.value;
      }
    }

    // Build select option strings
    let ccOptions = `<option value="">Seleccionar Centro Costo...</option>`;
    (cachedCatalogs.centrosCosto || []).forEach(opt => {
      if (!opt) return;
      const isSelected = taskData ? (opt.value === taskData.centroCosto) : (opt.value === defaultCcVal);
      ccOptions += `<option value="${opt.value}" ${isSelected ? "selected" : ""}>${opt.label || opt.value}</option>`;
    });

    const isNew = taskData === null;
    const timerStarted = taskData && (taskData.timerStarted === true || taskData.timerStarted === 'true' || (Array.isArray(taskData.timerHistory) && taskData.timerHistory.length > 0)) ? 'true' : 'false';
    const timerHistoryJson = taskData && taskData.timerHistory ? JSON.stringify(taskData.timerHistory) : '[]';

    let displayHours = taskData ? parseFloat(String(taskData.horasEstimadas).replace(',', '.')) || 0 : 0;
    // Only fall back to timer-history calculation if there's no stored horasEstimadas value.
    // If the user manually set horasEstimadas (> 0), always use that instead of recalculating.
    if (displayHours === 0 && taskData && Array.isArray(taskData.timerHistory) && taskData.timerHistory.length > 0) {
      const totalSeconds = calculateTotalElapsedSeconds(taskData.timerHistory, null);
      displayHours = minutesToHmm(Math.round(totalSeconds / 60));
    }

    const cardHtml = `
      <div class="task-item-card ${isNew ? 'new-task' : ''}" id="${taskId}" data-timer-started="${timerStarted}" data-timer-history='${timerHistoryJson}'>
        <div class="task-item-header">
          <span class="task-item-title">Tarea #${taskIndex + 1}</span>
          <button type="button" class="task-delete-btn" onclick="removeTaskField('${taskId}')">
            <span class="material-icons">delete</span>
          </button>
        </div>

        <div class="form-group">
          <label>Centro de Costo *</label>
          <select class="task-cc" required>
            ${ccOptions}
          </select>
        </div>

        <div class="form-group">
          <label>Empleado Asignado *</label>
          <select class="task-emp" required>
            <option value="">Seleccionar Empleado...</option>
          </select>
        </div>

        <div class="form-row">
          <div class="form-group col-6">
            <label>Horas Estimadas</label>
            <input type="number" step="0.01" min="0" value="${displayHours.toFixed(2)}" class="task-hours" oninput="updateHoursReadable(this)">
            <small class="hours-readable" style="color:var(--primary);font-size:11px;margin-top:2px;display:block;">${displayHours > 0 ? formatDecimalHours(displayHours) : ''}</small>
          </div>
          <div class="form-group col-6">
            <label>Estado Inicial</label>
            <select class="task-status">
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
            <button type="button" class="btn btn-primary btn-xs btn-timer-toggle" id="timer-btn-${taskId}" onclick="toggleTaskTimer('${taskId}')">
              <span class="material-icons" style="font-size:14px;">play_arrow</span>
              <span class="btn-text">Iniciar</span>
            </button>
          </div>
        </div>

        <div class="form-group" style="margin-top: 12px;">
          <label>Descripción de Actividades</label>
          <textarea placeholder="Describe las actividades a realizar..." rows="2" class="task-desc">${taskData ? taskData.descripcion || '' : ''}</textarea>
        </div>

        <div class="form-group task-insumos-section" style="margin-top: 10px;">
          <label style="font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Insumos / Repuestos Utilizados</label>
          <div class="insumos-checkbox-grid">
            <div class="insumo-row">
              <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Aceite Motor" onchange="toggleInsumoRow(this)"> Aceite Motor</label>
              <input type="text" placeholder="ej: 5L" class="insumo-qty-input" style="display: none;">
            </div>
            <div class="insumo-row">
              <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Refrigerante" onchange="toggleInsumoRow(this)"> Refrigerante</label>
              <input type="text" placeholder="ej: 3L" class="insumo-qty-input" style="display: none;">
            </div>
            <div class="insumo-row">
              <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Grasa Diferencial" onchange="toggleInsumoRow(this)"> Grasa Diferencial</label>
              <input type="text" placeholder="ej: 1Kg" class="insumo-qty-input" style="display: none;">
            </div>
            <div class="insumo-row">
              <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Grasa Caja" onchange="toggleInsumoRow(this)"> Grasa Caja</label>
              <input type="text" placeholder="ej: 2L" class="insumo-qty-input" style="display: none;">
            </div>
            <div class="insumo-row">
              <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Hco Equipo" onchange="toggleInsumoRow(this)"> Hco Equipo</label>
              <input type="text" placeholder="ej: 10L" class="insumo-qty-input" style="display: none;">
            </div>
            <div class="insumo-row">
              <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Hco Direccion" onchange="toggleInsumoRow(this)"> Hco Direccion</label>
              <input type="text" placeholder="ej: 1L" class="insumo-qty-input" style="display: none;">
            </div>
            <div class="insumo-row">
              <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Grasa Engrase x KG" onchange="toggleInsumoRow(this)"> Grasa Engrase x KG</label>
              <input type="text" placeholder="ej: 2Kg" class="insumo-qty-input" style="display: none;">
            </div>
            <div class="insumo-row">
              <label class="insumo-check-label"><input type="checkbox" class="insumo-check" value="Otros" onchange="toggleInsumoRow(this)"> Otros</label>
              <input type="text" placeholder="ej: Filtro de aire" class="insumo-qty-input" style="display: none;">
            </div>
          </div>
          <button type="button" class="btn btn-secondary btn-xs btn-agregar-insumos" style="margin-top: 8px; display: flex; align-items: center; gap: 4px;" onclick="agregarCantidadesInsumos(this)">
            <span class="material-icons" style="font-size: 14px;">add_circle_outline</span> Agregar cantidades a la tarea
          </button>
          <input type="hidden" class="task-insumos" value="${taskData && taskData.insumos ? taskData.insumos : ''}">
        </div>

        <div class="timer-history-log" style="font-size: 11px; color: var(--text-muted); margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center;">
          ${renderTimerHistoryHtml(taskData ? taskData.timerHistory : [])}
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

      if (isMecanicaCC) {
        const mecanicaNamesCleaned = new Set(MECANICA_EMPLOYEES.map(name => cleanName(name)));
        filteredEmployees = (cachedCatalogs.empleados || []).filter(emp => {
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
      } else if (isHerreriaCC) {
        const herreriaNamesCleaned = new Set(HERRERIA_EMPLOYEES.map(name => cleanName(name)));
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
        const customHerreriaNames = ["Federico", "Luciano", "Digno"];
        customHerreriaNames.forEach(name => {
          const exists = matchedEmployees.some(emp => emp && emp.label && emp.label.toLowerCase().trim() === name.toLowerCase());
          if (!exists) {
            matchedEmployees.push({ value: name, label: name });
          }
        });
        filteredEmployees = matchedEmployees;
      }
      let empOptions = `<option value="">Seleccionar Empleado...</option>`;
      filteredEmployees.forEach(opt => {
        if (!opt) return;
        const optVal = opt.value || "";
        const optLabel = opt.label || opt.value || "";
        const isSelected = optVal === taskData.empleado;
        empOptions += `<option value="${optVal}" ${isSelected ? "selected" : ""}>${optLabel}</option>`;
      });
      empSelect.innerHTML = empOptions;
      empSelect.value = taskData.empleado;
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

function removeTaskField(cardId) {
  const card = document.getElementById(cardId);
  if (card) {
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
async function fetchOrders() {
  try {
    const res = await fetch(`/api/orders?_=${Date.now()}`);
    if (!res.ok) throw new Error("Error fetching orders");
    const data = await res.json();
    
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
            <div class="order-card-title" style="font-size:16px; font-weight:700; color:var(--primary);">${order.rodado}</div>
            <div class="order-card-subtitle" style="font-size:13px; color:var(--text-muted); margin-top:2px;">Interno: <strong style="color:var(--text-color);">${order.interno}</strong> | Clasificación: <strong>${order.clasificacion || 'Preventivo'}</strong></div>
          </div>
        </div>
        ${order.taxesOrderNumber ? `
          <span class="badge-status success" style="display: inline-flex; align-items: center; gap: 4px; padding:4px 10px; font-size:13px; font-weight:600;">
            <span class="material-icons" style="font-size:16px;">check_circle</span>
            <span>Sincronizado O.T.: ${order.taxesOrderNumber}</span>
          </span>
        ` : `
          <span class="badge-status warning" style="display: inline-flex; align-items: center; gap: 4px; background-color:#fff7ed; color:#c2410c; border:1px solid rgba(194,65,12,0.2); padding:4px 10px; font-size:12px;" title="Esta orden no tiene número de O.T. asignado en Taxes">
            <span class="material-icons" style="font-size:14px;">warning</span>
            <span>Sin O.T. Asignada</span>
          </span>
        `}
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
          <button class="icon-btn" onclick="unarchiveOrder('${order.id}')" title="Re-sincronizar (volver a pendientes)" style="background:linear-gradient(135deg,#0ea5e9,#0284c7);color:#fff;border:none;">
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
  if (order.syncStatus === 'pending') {
    statusBadge = `<span class="badge-status pending"><span class="material-icons">hourglass_empty</span> Pendiente</span>`;
  } else if (order.syncStatus === 'syncing') {
    statusBadge = `<span class="badge-status syncing"><span class="material-icons spinner">autorenew</span> Sincronizando</span>`;
  } else if (order.syncStatus === 'success') {
    const otText = order.taxesOrderNumber ? ` O.T.: ${order.taxesOrderNumber}` : '';
    statusBadge = `
      <span class="badge-status success" style="display: inline-flex; align-items: center; gap: 4px;">
        <span class="material-icons">check_circle</span> 
        <span>Sincronizado${otText}</span>
        <button onclick="event.stopPropagation(); retrySync('${order.id}')" title="Volver a Sincronizar con Taxes" style="background: none; border: none; padding: 2px; margin-left: 4px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: #065f46; outline: none;" onmouseover="this.style.color='#047857'" onmouseout="this.style.color='#065f46'">
          <span class="material-icons" style="font-size: 14px; font-weight: bold;">sync</span>
        </button>
      </span>
    `;
  } else if (order.syncStatus === 'error') {
    if (order.taxesOrderNumber) {
      // Already synced before (has an OT number) — keep showing that, plus a small
      // extra badge indicating the latest re-sync attempt failed.
      statusBadge = `
        <span style="display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;">
          <span class="badge-status success" style="display: inline-flex; align-items: center; gap: 4px;">
            <span class="material-icons">check_circle</span>
            <span>Sincronizado O.T.: ${order.taxesOrderNumber}</span>
            <button onclick="event.stopPropagation(); retrySync('${order.id}')" title="Volver a Sincronizar con Taxes" style="background: none; border: none; padding: 2px; margin-left: 4px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: #065f46; outline: none;" onmouseover="this.style.color='#047857'" onmouseout="this.style.color='#065f46'">
              <span class="material-icons" style="font-size: 14px; font-weight: bold;">sync</span>
            </button>
          </span>
          <span class="badge-status error" onclick="event.stopPropagation(); openErrorModal(null, '${order.id}')" title="Fall\u00f3 el \u00faltimo reintento de sincronizaci\u00f3n. Clic para ver el detalle."><span class="material-icons">error</span> Error al resincronizar${order.autoSyncRetryCount ? ` x${order.autoSyncRetryCount}` : ''}</span>
        </span>
      `;
    } else {
      statusBadge = `<span class="badge-status error" onclick="event.stopPropagation(); openErrorModal(null, '${order.id}')"><span class="material-icons">error</span> Error</span>`;
    }
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
            <div class="order-card-title">${order.rodado}</div>
            <div class="order-card-subtitle" style="display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 4px;">
              <span>Interno: <strong>${order.interno}</strong> | Clasificación: <strong>${order.clasificacion || 'Sin Clasificar'}</strong></span>
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
          </div>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0;">
          ${statusBadge}
          ${getVerificationBadgeHtml(order)}
        </div>
      </div>

      <div class="order-card-footer">
        <div class="tasks-summary" onclick="toggleTaskEmployees(event, '${order.id}')" style="cursor:pointer;" title="Ver personal asignado">
          <span class="material-icons">format_list_bulleted</span>
          <span>${(order.tasks || []).filter(t => t !== null && t !== undefined).length} Tareas asignadas</span>
          <span class="material-icons" style="font-size:14px; margin-left:2px; color:var(--text-muted);">expand_more</span>
        </div>
        <div class="task-employees-detail" id="task-emp-${order.id}" style="display:none; width:100%; margin-top:6px; padding:6px 8px; background:var(--bg-secondary); border-radius:6px; font-size:12px;"></div>
        <div class="card-actions">
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
            const _cu = localStorage.getItem('currentUserUsername') || '';
            const isAdmin = getSectorByUsername(_cu) === 'Admin';
            const isPaniolU = _cu.toLowerCase().includes('paniol') || _cu.toLowerCase().includes('panol') || _cu.toLowerCase().includes('pañol');
            if (!isAdmin && !isPaniolU) return ''; // Solo Admin y Paniol pueden archivar/borrar
            if (order.syncStatus === 'success') {
              // For synced orders: show Archive button (moves to history)
              return `
                <button class="icon-btn" onclick="archiveOrder('${order.id}')" title="Archivar (pasa al Historial)" style="background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;border:none;">
                  <span class="material-icons">archive</span>
                </button>
              `;
            } else {
              // For local/error orders: show Delete button
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
    const statusIcon = t.status === 'Finalizada' ? '✅' : (t.timerStart > 0 ? '⚡' : (t.timerStarted || (t.timerHistory && t.timerHistory.length > 0) ? '⏸' : '⏳'));
    const desc = t.descripcion ? t.descripcion.split('\n')[0].substring(0, 40) : 'Sin descripción';
    html += `<div style="display:flex; align-items:center; gap:6px; padding:3px 0; border-bottom:1px solid var(--border-color);">
      <span style="font-size:13px;">${statusIcon}</span>
      <strong style="font-size:12px;">${empName}</strong>
      <span style="color:var(--text-muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">— ${desc}</span>
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

// 8. CREATE AND SUBMIT WORK ORDER
async function submitWorkOrder() {
  const rodadoEl = document.getElementById('form-rodado');
  const responsableEl = document.getElementById('form-responsable');
  const internoEl = document.getElementById('form-interno');
  const clasificacionEl = document.getElementById('form-clasificacion');
  const fechaEl = document.getElementById('form-fecha');
  const horaEl = document.getElementById('form-hora');
  const incidenteEl = document.getElementById('form-incidente');

  // Auto-set current date and time on submission to ensure freshness (only for new orders)
  if (!currentEditingOrderId) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    fechaEl.value = `${yyyy}-${mm}-${dd}`;
    
    const hh = String(today.getHours()).padStart(2, '0');
    const min = String(today.getMinutes()).padStart(2, '0');
    horaEl.value = `${hh}:${min}`;
  }
 
  const isHerreria = (getSectorByUsername(localStorage.getItem('currentUserUsername')) === 'Herrería');
  const rodadoVal = rodadoEl.value;

  const internoTextEl = document.getElementById('form-interno-text');
  const internoVal = isHerreria ? (internoTextEl ? internoTextEl.value.trim() : '') : internoEl.value;

  // Manual validations for touch optimization
  if (!rodadoVal) return showToast("Por favor, selecciona un Rodado.", "danger");
  if (!internoVal) return showToast("Por favor, selecciona el Interno de Unidad.", "danger");
  if (!clasificacionEl.value) return showToast("Por favor, selecciona una Clasificación.", "danger");

  const rodadoLabel = rodadoEl.options[rodadoEl.selectedIndex]?.text || rodadoVal;
 
  // Collect tasks
  const tasks = [];
  const container = document.getElementById('modal-tasks-list');
  const taskCards = container.querySelectorAll('.task-item-card');
 
  let tasksValid = true;
  taskCards.forEach(card => {
    const cc = card.querySelector('.task-cc').value;
    const emp = card.querySelector('.task-emp').value;
    const hours = card.querySelector('.task-hours').value;
    const status = card.querySelector('.task-status').value;
    const desc = card.querySelector('.task-desc').value;
    const insumosInput = card.querySelector('.task-insumos');
    const insumos = insumosInput ? insumosInput.value.trim() : '';
 
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
    const timerHistoryVal = JSON.parse(card.dataset.timerHistory || '[]');
 
    tasks.push({
      id: taskId,
      centroCosto: cc,
      empleado: emp,
      horasEstimadas: hours,
      status: status,
      descripcion: desc,
      insumos: insumos,
      timerStart: timerStartVal,
      timerStarted: card.dataset.timerStarted === 'true',
      timerHistory: timerHistoryVal
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
  if (currentEditingOrderId) {
    const originalOrder = activeOrders.find(o => o.id === currentEditingOrderId);
    if (originalOrder && Array.isArray(originalOrder.tasks) && originalOrder.tasks.length > 0 && tasks.length === 0) {
      const confirmDelete = confirm("ATENCIÓN: La orden original tenía tareas, pero ahora se guardará con 0 tareas (se borrarán permanentemente). ¿Está seguro de que desea continuar?");
      if (!confirmDelete) {
        return;
      }
    }
  }
 
  const payload = {
    rodado: rodadoLabel,
    responsable: "AUTO", // Always send AUTO so the worker resolves it from the logged-in user
    interno: internoVal,
    clasificacion: clasificacionEl.value,
    fechaEntrega: fechaEl.value,
    horario: horaEl.value,
    incidente: incidenteEl.value,
    tasks: tasks,
    estadoUnidad: currentEditingOrderId ? (activeOrders.find(o => o.id === currentEditingOrderId)?.estadoUnidad || 'fuera_de_servicio') : 'fuera_de_servicio',
    combustibleReset: currentCombustibleReset
  };
 
  const url = currentEditingOrderId ? `/api/orders/${currentEditingOrderId}` : '/api/orders';
  const method = currentEditingOrderId ? 'PUT' : 'POST';
 
  try {
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
      if (card.querySelector('.task-status').value === 'Finalizada') {
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
    switchView('home'); // Go to dashboard (Inicio) to see the tasks and stopwatch
  } catch (error) {
    const prefixMsg = currentEditingOrderId ? "Fallo al actualizar la orden" : "Fallo al crear la orden";
    showToast(`${prefixMsg}: ${error.message}`, "danger");
    console.error(error);
  }
}

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
      if (!task) return;
      const localStart = localStorage.getItem(`timer_start_${task.id}`);
      const isRunning = (localStart !== null) || (task.timerStart !== null && task.timerStart > 0);
      if (isRunning && task.status !== 'Finalizada' && task.empleado) {
        if (!runningByEmployee[task.empleado]) {
          runningByEmployee[task.empleado] = [];
        }
        runningByEmployee[task.empleado].push({
          order: order,
          task: task,
          timerStart: localStart ? parseInt(localStart) : task.timerStart
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

        task.timerStart = null;
        task.horasEstimadas = newHours;

        const updatedTasks = order.tasks.map(t => {
          if (t.id === task.id) {
            return {
              ...t,
              timerStart: null,
              horasEstimadas: newHours
            };
          }
          return t;
        });

        try {
          await fetch(`/api/orders/${order.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
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

      const localStart = localStorage.getItem(`timer_start_${task.id}`);
      const isRunning = (localStart !== null) || (task.timerStart !== null && task.timerStart > 0);
      if (isRunning && task.status !== 'Finalizada') {
        running.push({
          source: 'order',
          orderId: order.id,
          orderInterno: order.interno,
          orderRodado: order.rodado,
          taskId: task.id,
          empleado: task.empleado,
          timerStart: localStart ? parseInt(localStart) : task.timerStart
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
        
        const tasks = order.tasks.map(t => {
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
            headers: { 'Content-Type': 'application/json' },
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
  let totalMs = 0;
  if (Array.isArray(timerHistory) && timerHistory.length > 0) {
    const sorted = [...timerHistory].sort((a, b) => a.timestamp - b.timestamp);
    let currentStart = null;
    sorted.forEach(event => {
      const type = String(event.type || '').trim().toLowerCase();
      if (type.startsWith('inici') || type.startsWith('reanud')) {
        currentStart = event.timestamp;
      } else if (type.startsWith('paus') || type.startsWith('fin')) {
        if (currentStart !== null) {
          totalMs += (event.timestamp - currentStart);
          currentStart = null;
        }
      }
    });
  }
  if (timerStart !== null && timerStart > 0) {
    totalMs += (Date.now() - timerStart);
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

function renderDashboard() {
  try {
    const gridWorking = document.getElementById('grid-working');
    const gridPaused = document.getElementById('grid-paused');
    const listFree = document.getElementById('list-free-employees');

    if (!gridWorking || !gridPaused || !listFree) return;

    // IMPORTANT: Clear ALL existing dashboard timer intervals before re-rendering
    // This prevents ghost intervals from keeping dead timers alive after pause/finish
    for (const key in activeDashboardIntervals) {
      clearInterval(activeDashboardIntervals[key]);
      delete activeDashboardIntervals[key];
    }

    // Active tasks from all orders (including local, error, pending, syncing, success)
    const activeLocalOrders = getFilteredActiveOrders();
    
    const workingTasks = [];
    const pausedTasks = [];

    const workingEmployeeLabels = new Set();
    const pausedEmployeeLabels = new Set();

    activeLocalOrders.forEach(order => {
      (order.tasks || []).forEach(task => {
        if (task && task.status !== 'Finalizada') {
          const empOpt = (cachedCatalogs && cachedCatalogs.empleados)
            ? cachedCatalogs.empleados.find(e => e.value === task.empleado)
            : null;
          const empLabel = (empOpt ? empOpt.label : task.empleado) || 'Desconocido';
          const isTimerRunning = task.timerStart !== null && task.timerStart > 0;

          const taskInfo = {
            orderId: order.id,
            interno: order.interno || '',
            rodado: order.rodado || '',
            clasificacion: order.clasificacion || '',
            taskId: task.id,
            empleadoValue: task.empleado || '',
            empleadoLabel: empLabel,
            centroCosto: task.centroCosto || '',
            horasEstimadas: parseFloat(String(task.horasEstimadas).replace(',', '.')) || 0,
            descripcion: task.descripcion || '(Sin descripción)',
            timerStart: task.timerStart,
            isTimerRunning: isTimerRunning,
            timerHistory: task.timerHistory || [],
            taxesOrderNumber: order.taxesOrderNumber || null
          };

          if (isTimerRunning) {
            workingTasks.push(taskInfo);
            workingEmployeeLabels.add(String(empLabel).toLowerCase().trim());
          } else {
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
      gridWorking.innerHTML = workingTasks.map(t => {
        const elapsedSeconds = calculateTotalElapsedSeconds(t.timerHistory, t.timerStart);
        const hh = Math.floor(elapsedSeconds / 3600);
        const mm = Math.floor((elapsedSeconds % 3600) / 60);
        const ss = elapsedSeconds % 60;
        const displayTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;

        return `
          <div class="dashboard-card working" id="dash-card-${t.taskId}">
            <button type="button" class="dashboard-card-add-task-btn" onclick="editOrder('${t.orderId}')" title="Agregar tarea a esta orden">
              <span class="material-icons" style="font-size:18px;">add</span>
            </button>
            <div class="dashboard-card-ot-badge" style="font-size: 11px; font-weight: 700; color: var(--primary); margin-bottom: 4px;">
              OT #${t.interno}${t.taxesOrderNumber ? ` (Taxes: #${t.taxesOrderNumber})` : ''}
            </div>
            <div class="dashboard-card-title" title="${t.empleadoLabel}">${t.empleadoLabel}</div>
            <div class="dashboard-card-subtitle">Interno ${t.interno} ${t.clasificacion ? ' - ' + t.clasificacion : ''}</div>
            <div class="dashboard-card-desc">${t.descripcion}</div>
            <div class="dashboard-card-history" style="font-size: 10px; color: var(--text-muted); margin-top: 4px; margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 4px;">
              ${renderTimerHistoryHtml(t.timerHistory)}
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
      gridPaused.innerHTML = pausedTasks.map(t => {
        let displayHours = parseFloat(String(t.horasEstimadas || 0).replace(',', '.')) || 0;
        if (Array.isArray(t.timerHistory) && t.timerHistory.length > 0) {
          const totalSeconds = calculateTotalElapsedSeconds(t.timerHistory, null);
          displayHours = minutesToHmm(Math.round(totalSeconds / 60));
        }
        return `
          <div class="dashboard-card paused">
            <button type="button" class="dashboard-card-add-task-btn" onclick="editOrder('${t.orderId}')" title="Agregar tarea a esta orden">
              <span class="material-icons" style="font-size:18px;">add</span>
            </button>
            <div class="dashboard-card-ot-badge" style="font-size: 11px; font-weight: 700; color: var(--text-muted); margin-bottom: 4px;">
              OT #${t.interno}${t.taxesOrderNumber ? ` (Taxes: #${t.taxesOrderNumber})` : ''}
            </div>
            <div class="dashboard-card-title" title="${t.empleadoLabel}">${t.empleadoLabel}</div>
            <div class="dashboard-card-subtitle">Interno ${t.interno} ${t.clasificacion ? ' - ' + t.clasificacion : ''}</div>
            <div class="dashboard-card-desc">${t.descripcion}</div>
            <div class="dashboard-card-history" style="font-size: 10px; color: var(--text-muted); margin-top: 4px; margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 4px;">
              ${renderTimerHistoryHtml(t.timerHistory)}
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
        `;
      }).join('');
    }

    // 3. Render Free Mechanics
    const cleanName = (str) => {
      if (!str) return '';
      return String(str).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
    };

    const currentUser = localStorage.getItem('currentUserUsername');
    const userSector = getSectorByUsername(currentUser);
    let baseList = MECANICA_EMPLOYEES;
    if (userSector === 'Herrería') {
      baseList = HERRERIA_EMPLOYEES;
    }
    const activeBaseList = (activeMechanicsList && activeMechanicsList.length > 0 && userSector !== 'Herrería') ? activeMechanicsList : baseList;

    const freeMechanics = activeBaseList.filter(name => {
      const cleaned = cleanName(name);
      let isWorking = false;
      workingEmployeeLabels.forEach(label => {
        if (cleanName(label).includes(cleaned) || cleaned.includes(cleanName(label))) {
          isWorking = true;
        }
      });

      let isPaused = false;
      pausedEmployeeLabels.forEach(label => {
        if (cleanName(label).includes(cleaned) || cleaned.includes(cleanName(label))) {
          isPaused = true;
        }
      });

      return !isWorking && !isPaused;
    });

    const countFreeEl = document.getElementById('count-free');
    if (countFreeEl) countFreeEl.textContent = freeMechanics.length;

    if (freeMechanics.length === 0) {
      listFree.innerHTML = `<div class="empty-dashboard-state">Todos los mecánicos están ocupados.</div>`;
    } else {
      listFree.innerHTML = freeMechanics.map(name => {
        const shortName = name.split(',')[0].trim();
        return `
          <div class="free-employee-tag">
            <span class="material-icons">check_circle</span>
            <span>${shortName}</span>
          </div>
        `;
      }).join('');
    }
    applyFreeMechanicsVisibility();
    renderEmployeeHoursSummary();
  } catch (err) {
    console.error("Error rendering dashboard:", err);
  }
}

function toggleFreeMechanicsVisibility(checked) {
  localStorage.setItem('hideFreeMechanicsList', checked ? 'true' : 'false');
  applyFreeMechanicsVisibility();
}

function applyFreeMechanicsVisibility() {
  const isHidden = localStorage.getItem('hideFreeMechanicsList') === 'true';
  const listFree = document.getElementById('list-free-employees');
  const chkHide = document.getElementById('chk-hide-free-dashboard');

  if (listFree) {
    listFree.style.display = isHidden ? 'none' : 'flex';
  }
  if (chkHide) {
    chkHide.checked = isHidden;
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

async function toggleDashboardTaskTimer(orderId, taskId) {
  const order = activeOrders.find(o => o.id === orderId);
  if (!order) return;

  // Find the actual task object inside order.tasks (by reference)
  const task = order.tasks.find(t => t.id === taskId);
  if (!task) return;

  const isRunning = task.timerStart !== null && task.timerStart > 0;

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
    localStorage.setItem(`timer_start_${taskId}`, task.timerStart);
    showToast("Cronómetro iniciado", "info");
  } else {
    // --- PAUSE TIMER ---
    const elapsedMs = Date.now() - task.timerStart;
    const elapsedMinutes = Math.round(elapsedMs / (1000 * 60));
    const addedHoursHmm = minutesToHmm(elapsedMinutes);

    task.timerStart = null;
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
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rodado: order.rodado,
        responsable: order.responsable,
        fechaEntrega: order.fechaEntrega,
        horario: order.horario,
        interno: order.interno,
        clasificacion: order.clasificacion,
        incidente: order.incidente,
        tasks: order.tasks
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Error al comunicarse con el servidor");
    }
    fetchOrders();
  } catch (error) {
    showToast(`Error al guardar el cronómetro: ${error.message}`, "danger");
    console.error(error);
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
  const order = activeOrders.find(o => o.id === orderId);
  if (!order) return;

  if (!confirm("¿Estás seguro de marcar esta tarea como FINALIZADA?")) return;

  // Find the actual task object inside order.tasks (by reference)
  const task = order.tasks.find(t => t.id === taskId);
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
    estadoUnidad: order.estadoUnidad || 'operativo'
  };

  // Prompt for optional diagnosis and insumos
  const result = await promptDiagnosis(taskInfo);
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

  task.timerStart = null;
  clearLocalStorageTimerKeys(taskId);

  addTimerEventToTask(task, 'Fin');

  const totalMinutes = Math.round(calculateTotalElapsedSeconds(task.timerHistory, null) / 60);
  task.horasEstimadas = minutesToHmm(totalMinutes);

  task.status = "Finalizada";

  // Check if there are other pending tasks in this order
  const hasOtherPendingTasks = (order.tasks || []).some(t => t.id !== taskId && t.status !== 'Finalizada');

  if (result) {
    if (result.estadoUnidad === 'operativo') {
      if (!hasOtherPendingTasks) {
        order.estadoUnidad = 'operativo';
      } else {
        order.estadoUnidad = 'fuera_de_servicio';
        showToast("La unidad sigue Fuera de Servicio porque hay otras tareas pendientes.", "warning");
      }
    } else {
      order.estadoUnidad = 'fuera_de_servicio';
    }
  }

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
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rodado: order.rodado,
        responsable: order.responsable,
        fechaEntrega: order.fechaEntrega,
        horario: order.horario,
        interno: order.interno,
        clasificacion: order.clasificacion,
        incidente: order.incidente,
        tasks: order.tasks,
        estadoUnidad: order.estadoUnidad || 'operativo'
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Error al comunicarse con el servidor");
    }
    fetchOrders();
    
    if (allCompleted) {
      showToast("¡Todas las tareas finalizadas! Puedes subir la orden a Taxes manualmente desde el listado de órdenes.", "success");
    }
  } catch (error) {
    showToast(`Error al finalizar la tarea: ${error.message}`, "danger");
    console.error(error);
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

function openActiveMechanicsModal() {
  const container = document.getElementById('active-mechanics-checklist-container');
  if (!container) return;

  const currentUser = localStorage.getItem('currentUserUsername');
  const userSector = getSectorByUsername(currentUser);
  const baseList = userSector === 'Herrería' ? HERRERIA_EMPLOYEES : MECANICA_EMPLOYEES;

  // Render checklist items
  container.innerHTML = baseList.map((name, index) => {
    const isChecked = activeMechanicsList.includes(name);
    return `
      <label class="mechanic-check-item">
        <input type="checkbox" name="active_mechanic" value="${name}" ${isChecked ? 'checked' : ''}>
        <span>${name}</span>
      </label>
    `;
  }).join('');

  const chkHide = document.getElementById('chk-hide-free-dashboard');
  if (chkHide) {
    chkHide.checked = localStorage.getItem('hideFreeMechanicsList') === 'true';
  }

  document.getElementById('active-mechanics-modal').classList.add('open');
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

    const cleanName = (str) => {
      if (typeof str !== 'string') return '';
      return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
    };

    if (isHerreriaCC) {
      // Herrería filter
      const herreriaNamesCleaned = new Set(HERRERIA_EMPLOYEES.map(name => cleanName(name)));
      
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

      // Add Federico, Luciano, Digno if not present
      const customHerreriaNames = ["Federico", "Luciano", "Digno"];
      customHerreriaNames.forEach(name => {
        const exists = matchedEmployees.some(emp => emp && emp.label && emp.label.toLowerCase().trim() === name.toLowerCase());
        if (!exists) {
          matchedEmployees.push({ value: name, label: name });
        }
      });

      // Fallback to full list if filter returns too few results
      filteredEmployees = matchedEmployees.length >= 3 ? matchedEmployees : (cachedCatalogs.empleados || []);

    } else if (isMecanicaCC) { // MECANICA
      const mecanicaNamesCleaned = new Set(MECANICA_EMPLOYEES.map(name => cleanName(name)));
      const mecFiltered = (cachedCatalogs.empleados || []).filter(emp => {
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
      // Fallback to full list if filter returns too few results (catalog names may not match)
      filteredEmployees = mecFiltered.length >= 3 ? mecFiltered : (cachedCatalogs.empleados || []);
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
      tasks: vehicleTasks
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
  
  if (matches.length === 0) {
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
  const toggleIcon = input.nextElementSibling;
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

let currentSelectedSector = 'Taller';

function switchSector(sector) {
  currentSelectedSector = sector;
  
  // Update active class on tab buttons
  const tabs = document.querySelectorAll('.sector-tab');
  tabs.forEach(tab => {
    if (tab.textContent.trim() === sector) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  // Hide/show Preventivos nav tab based on sector
  const navPrev = document.getElementById('nav-preventivos');
  if (navPrev) navPrev.style.display = (sector === 'Herrer\u00eda') ? 'none' : '';
  // If currently on preventivos view and switching to Herrería, go home
  const activeViewEl = document.querySelector('.app-view.active');
  if (sector === 'Herrer\u00eda' && activeViewEl && activeViewEl.id === 'view-preventivos') {
    switchView('home');
  }

  // Re-filter and render
  renderOrders();
  renderHistoryOrders();
  renderDashboard();
  updateStats();
  updateClassificationSelectOptions();
  setupAllFieldsForSector();
  
  if (window._ptState) {
    renderParteTallerDashboard(window._ptState);
  }
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
    } else if (sector === 'Edilicio') {
      html = `
        <option value="Edilicio" selected>Edilicio</option>
      `;
    } else {
      // Taller / Admin
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

function getFilteredActiveOrders() {
  const currentUser = localStorage.getItem('currentUserUsername');
  const userSector = getSectorByUsername(currentUser);

  if (!activeOrders || !Array.isArray(activeOrders)) return [];

  // Determine active sector filter
  let sectorFilter = currentSelectedSector;
  if (userSector !== 'Admin') {
    sectorFilter = userSector;
  }

  return activeOrders.filter(o => {
    const cls = o.clasificacion;
    if (sectorFilter === 'Herrería') {
      return cls === 'Herrería';
    }
    if (sectorFilter === 'Edilicio') {
      return cls === 'Edilicio';
    }
    // Taller sees everything EXCEPT Herrería and Edilicio
    return cls !== 'Herrería' && cls !== 'Edilicio';
  });
}

function getFilteredArchivedOrders() {
  const currentUser = localStorage.getItem('currentUserUsername');
  const userSector = getSectorByUsername(currentUser);

  if (!archivedOrders || !Array.isArray(archivedOrders)) return [];

  // Determine active sector filter
  let sectorFilter = currentSelectedSector;
  if (userSector !== 'Admin') {
    sectorFilter = userSector;
  }

  return archivedOrders.filter(o => {
    const cls = o.clasificacion;
    if (sectorFilter === 'Herrería') {
      return cls === 'Herrería';
    }
    if (sectorFilter === 'Edilicio') {
      return cls === 'Edilicio';
    }
    // Taller sees everything EXCEPT Herrería and Edilicio
    return cls !== 'Herrería' && cls !== 'Edilicio';
  });
}

function checkUserSession() {
  const username = localStorage.getItem('currentUserUsername');
  const loginOverlay = document.getElementById('login-overlay');
  
  if (!username) {
    if (loginOverlay) loginOverlay.classList.remove('hidden');
  } else {
    if (loginOverlay) loginOverlay.classList.add('hidden');
    const userDisplay = document.getElementById('current-user');
    if (userDisplay) {
      userDisplay.textContent = username;
    }
    
    // Check role and update tabs bar
    const sector = getSectorByUsername(username);
    const tabsBar = document.getElementById('sector-tabs-bar');
    if (tabsBar) {
      if (sector === 'Admin') {
        tabsBar.style.display = 'flex';
      } else {
        tabsBar.style.display = 'none';
        currentSelectedSector = sector; // Lock to their sector
      }
    }
    
    // Show/hide nav Historial button — Admin only
    const navHistorial = document.getElementById('nav-historial');
    if (navHistorial) {
      navHistorial.style.display = (sector === 'Admin') ? 'flex' : 'none';
    }

    updateClassificationSelectOptions();
  }
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
    const res = await originalFetch('/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'bypass-tunnel-reminder': 'true',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify({ username, password })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Usuario o contraseña inválidos");
    }

    const data = await res.json();
    
    // Save to localStorage
    localStorage.setItem('currentUserUsername', data.username);
    localStorage.setItem('currentUserPassword', password);
    showToast("Sesión iniciada correctamente", "success");
    
    // Hide overlay & refresh everything
    checkUserSession();
    
    // Trigger initial data fetches
    fetchSettings();
    fetchCatalogs();
    fetchOrders();
    fetchActiveMechanics();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Error al iniciar sesión", "danger");
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

function logoutUser() {
  if (confirm("¿Está seguro que desea cerrar sesión?")) {
    localStorage.removeItem('currentUserUsername');
    localStorage.removeItem('currentUserPassword');
    location.reload();
  }
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
            const elapsedMs = Date.now() - timerStartVal;
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
          const elapsedMs = Date.now() - task.timerStart;
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
            runningMins = (Date.now() - timerStartVal) / (1000 * 60);
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
          runningMins = (Date.now() - task.timerStart) / (1000 * 60);
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
  const info = getTaskInfoForAlert(taskId);
  if (!info || !info.empleadoValue) return;

  const employeeValue = info.empleadoValue;
  const totalMinutes = getEmployeeTotalHours(employeeValue);
  const totalHours = totalMinutes / 60;

  // Prevent opening overlapping modals
  const modal = document.getElementById('supervisor-auth-modal');
  if (modal && modal.classList.contains('open')) {
    if (currentAlertTaskId === taskId) {
      return;
    }
    return;
  }

  const dateStr = getTodayDateString();
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));

  if (totalHours >= 8 && totalHours < 12) {
    const warnedKey = `warned_8h_${employeeValue}_${taskId}_${dateStr}`;
    if (localStorage.getItem(warnedKey) !== 'true') {
      localStorage.setItem(warnedKey, 'true');
      showSupervisorAuthModal(taskId, 8, elapsedSeconds, totalMinutes);
    }
  } else if (totalHours >= 12) {
    const authKey = `authorized_12h_${employeeValue}_${taskId}_${dateStr}`;
    if (localStorage.getItem(authKey) !== 'true') {
      showSupervisorAuthModal(taskId, 12, elapsedSeconds, totalMinutes);
    }
  }
}

function showSupervisorAuthModal(taskId, hoursThreshold, elapsedSeconds, totalMinutes) {
  const info = getTaskInfoForAlert(taskId);
  if (!info) return;

  currentAlertTaskId = taskId;

  const modal = document.getElementById('supervisor-auth-modal');
  const titleEl = document.getElementById('supervisor-auth-title');
  const msgEl = document.getElementById('supervisor-auth-message');
  const headerEl = document.getElementById('supervisor-auth-header');
  const btnAuth = document.getElementById('btn-supervisor-authorize');

  if (!modal || !titleEl || !msgEl || !headerEl || !btnAuth) return;

  const formattedSessionTime = formatElapsedSecondsToHMS(elapsedSeconds);
  const totalHmm = minutesToHmm(Math.round(totalMinutes));
  const formattedTotalTime = formatDecimalHours(totalHmm);

  const tasksDetails = getEmployeeTasksDetailsToday(info.empleadoValue);
  let tasksHtml = '';
  if (tasksDetails.length > 0) {
    tasksHtml = `
      <div style="margin-top: 10px; font-weight: bold; font-size: 12px; color: var(--text-color);">Detalle de tareas de hoy:</div>
      <ul style="margin: 6px 0 0 0; padding-left: 20px; font-size: 12px; max-height: 120px; overflow-y: auto; line-height: 1.5;">
        ${tasksDetails.map(t => `
          <li style="margin-bottom: 4px;">
            <strong>${t.rodado}</strong> (Int. ${t.interno}): ${t.descripcion} <span style="color: var(--primary); font-weight: 600;">(${t.durationFormatted})</span>
          </li>
        `).join('')}
      </ul>
    `;
  }

  if (hoursThreshold === 8) {
    headerEl.style.backgroundColor = '#f59e0b'; // warning orange
    titleEl.innerHTML = `<span class="material-icons" style="color: white;">warning</span> Advertencia de Tiempo (8h+)`;
    msgEl.innerHTML = `
      <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px; margin-bottom: 12px; border-radius: 4px; color: #b45309; font-weight: bold;">
        Advertencia de Tiempo Excedido
      </div>
      <p>El operario <strong>${info.empleado}</strong> ha superado las <strong>8 horas acumuladas</strong> de trabajo hoy:</p>
      <div style="background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid var(--border-color); font-size: 13px; line-height: 1.6;">
        <div><strong>Operario:</strong> ${info.empleado}</div>
        <div style="font-weight: bold; color: #d97706; font-size: 14px; margin-top: 4px;">Tiempo Total Acumulado Hoy: ${formattedTotalTime}</div>
        ${tasksHtml}
      </div>
    `;
    btnAuth.textContent = "Entendido";
    btnAuth.onclick = () => {
      closeSupervisorAuthModal();
    };
  } else {
    headerEl.style.backgroundColor = '#ef4444'; // danger red
    titleEl.innerHTML = `<span class="material-icons" style="color: white;">error</span> Alerta de Límite (12h+)`;
    msgEl.innerHTML = `
      <div style="background: #fee2e2; border-left: 4px solid #ef4444; padding: 12px; margin-bottom: 12px; border-radius: 4px; color: #991b1b; font-weight: bold;">
        Límite de 12 Horas Alcanzado
      </div>
      <p>El operario <strong>${info.empleado}</strong> ha alcanzado o superado las <strong>12 horas acumuladas</strong> de trabajo hoy:</p>
      <div style="background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid var(--border-color); font-size: 13px; line-height: 1.6;">
        <div><strong>Operario:</strong> ${info.empleado}</div>
        <div style="font-weight: bold; color: #dc2626; font-size: 14px; margin-top: 4px;">Tiempo Total Acumulado Hoy: ${formattedTotalTime}</div>
        ${tasksHtml}
      </div>
      <p style="margin-top: 12px; font-size: 13px; color: var(--text-muted);">
        El cronómetro no puede continuar sin la autorización expresa del supervisor.
      </p>
    `;
    btnAuth.textContent = "Autorizar Continuar";
    btnAuth.onclick = () => {
      approveSupervisorAuth(taskId);
    };
  }

  modal.classList.add('open');
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
      estadoUnidad: "fuera_de_servicio",
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

async function handlePlanillaOcrUpload(input) {
  const file = input.files[0];
  if (!file) return;

  const overlay = document.getElementById('ai-loading-overlay');
  if (overlay) {
    overlay.style.display = 'flex';
  }

  const reader = new FileReader();
  reader.onload = async function(e) {
    const base64 = e.target.result;
    try {
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
  };
  reader.readAsDataURL(file);
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
  const isHerreria = (userSector === 'Herrería');

  // 1. Main modal: Rodado
  const rodadoSelectGroup = document.getElementById('form-rodado-group-select');
  const rodadoTextGroup = document.getElementById('form-rodado-group-text');
  const rodadoSelect = document.getElementById('form-rodado');
  const rodadoText = document.getElementById('form-rodado-text');

  // Rodado: always use the searchable select for ALL sectors (Herrería included)
  if (rodadoSelectGroup) rodadoSelectGroup.style.display = 'block';
  if (rodadoTextGroup) rodadoTextGroup.style.display = 'none';
  if (rodadoSelect) rodadoSelect.setAttribute('required', 'true');
  if (rodadoText) rodadoText.removeAttribute('required');

  // 2. Pre-order modal: Interno — always show the searchable select (for all sectors including Herrería)
  const preInternoSelectGroup = document.getElementById('pre-form-interno-group-select');
  const preInternoTextGroup = document.getElementById('pre-form-interno-group-text');
  const preInternoSelect = document.getElementById('pre-form-interno');
  const preInternoText = document.getElementById('pre-form-interno-text');

  // Always show the select dropdown (ignore text alternative for pre-order modal)
  if (preInternoSelectGroup) preInternoSelectGroup.style.display = 'block';
  if (preInternoTextGroup) preInternoTextGroup.style.display = 'none';
  if (preInternoSelect) preInternoSelect.setAttribute('required', 'true');
  if (preInternoText) preInternoText.removeAttribute('required');

  // 3. Main modal: Interno — for Herrería show text field (free type), for others show select
  const internoSelectGroup = document.getElementById('form-interno-group-select');
  const internoTextGroup = document.getElementById('form-interno-group-text');
  const internoSelect = document.getElementById('form-interno');
  const internoText = document.getElementById('form-interno-text');

  if (isHerreria) {
    if (internoSelectGroup) internoSelectGroup.style.display = 'none';
    if (internoTextGroup) internoTextGroup.style.display = 'block';
    if (internoSelect) internoSelect.removeAttribute('required');
    if (internoText) internoText.setAttribute('required', 'true');
  } else {
    if (internoSelectGroup) internoSelectGroup.style.display = 'block';
    if (internoTextGroup) internoTextGroup.style.display = 'none';
    if (internoSelect) internoSelect.setAttribute('required', 'true');
    if (internoText) internoText.removeAttribute('required');
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
    const rest = item.restante ? Number(item.restante).toLocaleString('es-AR') : 0;
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
      return `<div class="prev-mobile-card">
        <div class="prev-mobile-card-header">
          <div><strong style="font-size:16px;">${item.interno}</strong><br><span style="font-size:12px; color:var(--text-muted);">${item.modelo}</span></div>
          <span class="badge-prev ${badgeClass}">${badgeText}</span>
        </div>
        <div class="prev-mobile-card-row"><span>KM Reales</span><strong>${Number(item.kmReales || 0).toLocaleString('es-AR')}</strong></div>
        <div class="prev-mobile-card-row"><span>Hs Reales</span><strong>${Number(item.hsReales || 0).toLocaleString('es-AR')}</strong></div>
        <div class="prev-mobile-card-row"><span>Restante</span><strong>${Number(item.restante || 0).toLocaleString('es-AR')}</strong></div>
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
  openPrevOdometerModal(item.originalRowIndex, item.interno, item.modelo, item.kmReales || 0, item.hsReales || 0);
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
function openPrevOdometerModal(rowIndex, interno, modelo, km, hs) {
  const isIveco = String(modelo || '').toLowerCase().includes('iveco');
  prevCurrentOdometerRow = { rowIndex, interno, modelo, vehicleType: isIveco ? 'iveco' : 'km' };
  document.getElementById('prev-odometer-modal-interno').textContent = `${interno} — ${modelo}`;
  // Show/hide the relevant field
  const kmGroup = document.getElementById('prev-odometer-modal-km-group');
  const hsGroup = document.getElementById('prev-odometer-modal-hs-group');
  if (kmGroup) kmGroup.style.display = isIveco ? 'none' : 'block';
  if (hsGroup) hsGroup.style.display = isIveco ? 'block' : 'none';
  document.getElementById('prev-odometer-modal-km').value = isIveco ? '' : (km || '');
  document.getElementById('prev-odometer-modal-hs').value = isIveco ? (hs || '') : '';
  document.getElementById('prev-odometer-modal').classList.add('open');
  setTimeout(() => {
    const focusEl = isIveco
      ? document.getElementById('prev-odometer-modal-hs')
      : document.getElementById('prev-odometer-modal-km');
    if (focusEl) focusEl.focus();
  }, 100);
}

function closePrevOdometerModal() {
  document.getElementById('prev-odometer-modal').classList.remove('open');
  prevCurrentOdometerRow = null;
}

async function savePrevOdometer() {
  if (!prevCurrentOdometerRow) return;
  const km = document.getElementById('prev-odometer-modal-km').value;
  const hs = document.getElementById('prev-odometer-modal-hs').value;
  const btn = document.getElementById('btn-save-prev-odometer');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-icons" style="animation:spin 1.5s linear infinite; font-size:16px; vertical-align:middle;">sync</span> Guardando...';
  try {
    const isIveco = prevCurrentOdometerRow.vehicleType === 'iveco';
    const km = isIveco ? '' : document.getElementById('prev-odometer-modal-km').value.trim();
    const hs = isIveco ? document.getElementById('prev-odometer-modal-hs').value.trim() : '';
    const res = await fetch('/api/preventivos/odometer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rowIndex: prevCurrentOdometerRow.rowIndex,
        km,
        hs,
        interno: prevCurrentOdometerRow.interno,
        vehicleType: isIveco ? 'iveco' : ''
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    showToast(`Kilómetros/Horas actualizados para interno ${prevCurrentOdometerRow.interno} ✓`, 'success');
    closePrevOdometerModal();
    await fetchPreventivoFlota();
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
  
  if (isHerreria) {
    if (internoText) {
      internoText.value = interno;
      const event = new Event('change');
      internoText.dispatchEvent(event);
    }
  } else {
    if (internoSelect) {
      internoSelect.value = interno;
      if (internoSelect.rebuildSearchable) {
        internoSelect.rebuildSearchable();
      }
      const event = new Event('change');
      internoSelect.dispatchEvent(event);
    }
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
    if (!data.ok) throw new Error(data.msg || 'Error al leer estado');
    renderParteTallerDashboard(data.state);
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

    // Find all open Herrería orders with active/paused tasks
    const herreriaOrders = activeOrders.filter(o => {
      const isClosed = o.estado && o.estado.toLowerCase() === 'cerrada';
      if (isClosed) return false;
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
        const labelUpper = String(rodadoOpt.label || '').toUpperCase();
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

  // 1. Find all open orders with active or paused sector-matching tasks
  const activeRepairOrders = activeOrders.filter(o => {
    const isClosed = o.estado && o.estado.toLowerCase() === 'cerrada';
    if (isClosed) return false;
    const tasks = (o.tasks || []).filter(t => t !== null && t !== undefined);
    return tasks.filter(taskMatchesSector).some(
      t => t.status !== 'Finalizada' && (t.timerStart > 0 || t.timerStarted || (t.timerHistory && t.timerHistory.length > 0))
    );
  });

  // Keep track of which internos are forced into "reparacion"
  const repairInternos = new Map();
  activeRepairOrders.forEach(o => {
    const taxInt = String(o.interno || '').trim().toUpperCase();
    if (taxInt) {
      repairInternos.set(taxInt, o);
    }
  });

  if (repairInternos.size === 0) return;

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

    state.reparacion.push(unit);
    const taxInt = String(matchingOrder.interno || '').trim().toUpperCase();
    repairInternos.delete(taxInt);
  });

  // 4. For any remaining repairInternos (units not currently in taller), create a temporary unit
  for (const [taxInt, order] of repairInternos.entries()) {
    let internoLabel = order.interno;
    
    let unitType = 'COMPACTADOR';
    const rodadoOpt = cachedCatalogs.rodados
      ? cachedCatalogs.rodados.find(r => String(r.interno || '').trim() === String(order.interno).trim())
      : null;
    if (rodadoOpt) {
      const labelUpper = String(rodadoOpt.label || '').toUpperCase();
      if (labelUpper.includes('VOLQ')) unitType = 'VOLQUETE';
      else if (labelUpper.includes('ROLL') || labelUpper.includes('OFF')) unitType = 'ROLL - OFF';
      else if (labelUpper.includes('PLANCHA')) unitType = 'PLANCHA';
      else if (labelUpper.includes('COMPAC')) unitType = 'COMPACTADOR';
      else if (labelUpper.includes('CONTENEDOR') || labelUpper.includes('CAJITA') || labelUpper.includes('CAJA')) unitType = 'CONTENEDOR';
      else if (labelUpper.includes('CAMION') || labelUpper.includes('CAMIÓN') || labelUpper.includes('TRACTO')) unitType = 'CAMIÓN';
      else if (labelUpper.includes('SEMI')) unitType = 'SEMI';
      else unitType = 'UNIDAD';
    } else {
      if (isNaN(Number(String(order.interno || '').trim()))) unitType = 'UNIDAD';
    }

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

  // 5. Recalculate totals
  const totales = (state.resumen || {}).totales || {};
  const types = ['COMPACTADOR', 'VOLQUETE', 'ROLL - OFF', 'PLANCHA'];
  types.forEach(t => {
    const origOp = parseInt((totales[t] || {}).operativos || '0') || 0;
    const origFs = parseInt((totales[t] || {}).fuera || '0') || 0;
    const totalFleet = origOp + origFs;

    const newFsCount = 
      (state.fuera_de_servicio || []).filter(u => String(u.tipo).trim().toUpperCase() === t).length +
      (state.reparacion || []).filter(u => String(u.tipo).trim().toUpperCase() === t).length;

    if (!totales[t]) totales[t] = {};
    totales[t].fuera = newFsCount;
    totales[t].operativos = Math.max(0, totalFleet - newFsCount);
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

  const el = id => document.getElementById(id);
  const resumen = displayState.resumen || {};
  const totales = resumen.totales || {};

  function parseCount(tipo, campo) {
    return parseInt((totales[tipo] || {})[campo] || '0') || 0;
  }

  // Fill totals for each vehicle type
  const types = [
    { key: 'COMPACTADOR', opId: 'pt-op-comp', fsId: 'pt-out-comp' },
    { key: 'VOLQUETE',    opId: 'pt-op-volq', fsId: 'pt-out-volq' },
    { key: 'ROLL - OFF',   opId: 'pt-op-roll', fsId: 'pt-out-roll' },
    { key: 'PLANCHA',    opId: 'pt-op-plancha', fsId: 'pt-out-plancha' }
  ];
  types.forEach(t => {
    if (el(t.opId)) el(t.opId).textContent = parseCount(t.key, 'operativos');
    if (el(t.fsId)) el(t.fsId).textContent = parseCount(t.key, 'fuera');
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

  function matchesPtSector(item) {
    // If item has no sector tag, show to everyone (legacy data)
    if (!item.sector) return true;
    return item.sector === currentPtSector;
  }

  // 1. Fuera de servicio
  const fueraDeServicio = (displayState.fuera_de_servicio || []).filter(matchesPtSector).sort((a, b) => getDaysValue(b) - getDaysValue(a));
  if (el('pt-out-count')) el('pt-out-count').textContent = fueraDeServicio.length;
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
          <td><div style="display:flex; align-items:center; gap:4px; line-height:1.2;">${displayLabel} ${getEditBtnHtml(internoPT, 'fuera_de_servicio')}</div></td>
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
          return `<div class="pt-mobile-card">
            <div class="pt-mobile-card-header">
              <div><strong style="font-size:15px;">${internoPT}</strong>${item.tipo ? `<br><span style="font-size:12px;color:var(--text-muted);">${item.tipo}</span>` : ''}</div>
              ${getDiasParadoHtml(item, desde)}
            </div>
            <div class="pt-mobile-card-row"><span>Desde</span><strong>${desde}</strong></div>
            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">${getOrdenBtnHtml(internoPT)} ${getEditBtnHtml(internoPT,'fuera_de_servicio')}</div>
          </div>`;
        }).join('');
  }

  // 2. En reparación
  const reparacion = (displayState.reparacion || []).filter(matchesPtSector).sort((a, b) => getDaysValue(b) - getDaysValue(a));
  if (el('pt-rep-count')) el('pt-rep-count').textContent = reparacion.length;
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
          <td><div style="display:flex; align-items:center; gap:4px; line-height:1.2;">${displayLabel} ${getEditBtnHtml(internoPT, 'reparacion')}</div></td>
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
          return `<div class="pt-mobile-card">
            <div class="pt-mobile-card-header">
              <div><strong style="font-size:15px;">${internoPT}</strong>${item.tipo ? `<br><span style="font-size:12px;color:var(--text-muted);">${item.tipo}</span>` : ''}</div>
              ${getDiasParadoHtml(item, desde)}
            </div>
            <div class="pt-mobile-card-row"><span>Desde</span><strong>${desde}</strong></div>
            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">${getOrdenBtnHtml(internoPT)} ${getEditBtnHtml(internoPT,'reparacion')}</div>
          </div>`;
        }).join('');
  }

  // 3. Servicios pendientes
  const pendientes = displayState.servicios_pendientes || [];
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
          return `<div class="pt-mobile-card">
            <div class="pt-mobile-card-header">
              <div><strong style="font-size:15px;">${internoPT}</strong>${item.tipo ? `<br><span style="font-size:12px;color:var(--text-muted);">${item.tipo}</span>` : ''}</div>
              <span class="badge" style="background:#2196f3;color:white;font-size:11px;">${servicio}</span>
            </div>
            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">${getOrdenBtnHtml(internoPT)} ${getEditBtnHtml(internoPT,'servicios_pendientes')}</div>
          </div>`;
        }).join('');
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
  if (isHerreria) {
    if (internoText) { internoText.value = taxesInterno; internoText.dispatchEvent(new Event('change')); }
  } else {
    if (internoSelect) {
      internoSelect.value = taxesInterno;
      if (internoSelect.rebuildSearchable) internoSelect.rebuildSearchable();
      internoSelect.dispatchEvent(new Event('change'));
    }
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
  if (window._ptState) {
    const state = window._ptState;
    const lists = ['fuera_de_servicio', 'reparacion', 'servicios_pendientes'];
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
  document.getElementById('pt-unit-estado').value = 'servicios_pendientes';
  document.getElementById('pt-unit-novedad').value = '';
  
  // Hide checklist editor, show plain textarea label
  const checkSection = document.getElementById('pt-unit-checklist-section');
  if (checkSection) checkSection.style.display = 'none';
  const novedadLabel = document.getElementById('pt-unit-novedad-label');
  if (novedadLabel) novedadLabel.textContent = 'Novedad / Diagnóstico / Servicio';

  document.getElementById('pt-unit-modal').classList.add('open');
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
  const lists = ['servicios_pendientes', 'reparacion', 'fuera_de_servicio'];
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
  if (rodadoOpt) {
    const labelUpper = String(rodadoOpt.label || '').toUpperCase();
    let guessedType = 'COMPACTADOR';
    if (labelUpper.includes('VOLQ')) guessedType = 'VOLQUETE';
    else if (labelUpper.includes('ROLL') || labelUpper.includes('OFF')) guessedType = 'ROLL - OFF';
    else if (labelUpper.includes('PLANCHA')) guessedType = 'PLANCHA';
    
    document.getElementById('pt-unit-tipo').value = guessedType;
  }
}

// Submits the unit add/edit data
async function savePtUnit() {
  const saveBtn = document.getElementById('btn-save-pt-unit');
  const empresa = document.getElementById('pt-unit-empresa').value;
  const interno = document.getElementById('pt-unit-interno').value.trim();
  const tipo = document.getElementById('pt-unit-tipo').value;
  const estado = document.getElementById('pt-unit-estado').value;
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

        const orderPayload = {
          rodado: rodadoLabel,
          responsable: "AUTO",
          interno: internoVal,
          clasificacion: "Correctivo",
          fechaEntrega: today,
          horario: "12:00",
          incidente: incidentDesc,
          tasks: [],
          estadoUnidad: (estado === 'fuera_de_servicio' ? 'fuera_de_servicio' : 'operativo')
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
      } else {
        showToast('Unidad agregada con éxito a Servicios Pendientes.', 'success');
      }
    } 
    // If EDITING an existing unit
    else {
      if (!window._ptState) return;
      const state = window._ptState;

      // 1. Remove from all three lists to start clean (using original internally stored interno)
      const lists = ['servicios_pendientes', 'reparacion', 'fuera_de_servicio'];
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
            estadoUnidad: (estado === 'fuera_de_servicio' ? 'fuera_de_servicio' : 'operativo')
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
    fetchParteTallerEstado();
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
  if (order.syncStatus !== 'success' && !(order.syncStatus === 'error' && order.taxesOrderNumber)) return '';

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

let currentVerifyOrderId = null;

function openVerificationErrorModal(errorMsg, orderId) {
  currentVerifyOrderId = orderId;
  const formattedMsg = String(errorMsg || '').split(' | ').join('\n');
  document.getElementById('verify-error-modal-log').textContent = formattedMsg || 'No hay detalles de error.';
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

