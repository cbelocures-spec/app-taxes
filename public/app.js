// Global State
let cachedCatalogs = { rodados: [], responsables: [], empleados: [], centrosCosto: [] };
let cachedNovelties = [];
let activeOrders = [];
let currentRetryOrderId = null;
let currentEditingOrderId = null;
let catalogSyncInterval = null;
let activeMechanicsList = [];

const MECANICA_EMPLOYEES = [
  "Canaviri Fernandez, Jesús",
  "Cuba Orosco, Kevín Genaro",
  "GERRY CRISTIAN MARCELO",
  "Gustavo Javier Benitez",
  "Monzon, Carlos Agustin",
  "Morel, Luis Maximiliano",
  "OJEDA FERNANDEZ JOSE ENRIQUE",
  "Ojeda Fernández, Miguel",
  "Olivera, Diego",
  "PANETTA ALBARRACIN FEDERICO",
  "Perino Martin Adrian",
  "Ríos, Cesar Damián",
  "Rocha, Ariel Maximiliano",
  "RODRIGUEZ CARLOS FERNANDO",
  "RODRIGUEZ NICOLAS",
  "Sosa, Alejandro Damian",
  "Vera, Domingo Sergio"
];

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

  // Initial Fetches
  fetchSettings();
  fetchCatalogs();
  fetchOrders();
  fetchActiveMechanics();

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
      }
    });
  }

  // Poll for orders sync status in real time
  setInterval(fetchOrders, 3000);
  setInterval(checkWorkerStatus, 3000);
  setInterval(fetchSettingsPolling, 3000);

  // Fetch novelties from Google Sheet on startup
  fetchNovelties();

  // Listen for changes on rodado field to auto-populate interno
  const rodadoSelect = document.getElementById('form-rodado');
  if (rodadoSelect) {
    rodadoSelect.addEventListener('change', () => {
      const selectedValue = rodadoSelect.value;
      const rodadoOpt = cachedCatalogs.rodados.find(r => r.value === selectedValue);
      if (rodadoOpt && rodadoOpt.interno) {
        const internoInput = document.getElementById('form-interno');
        if (internoInput) {
          internoInput.value = rodadoOpt.interno;
          showNoveltiesForInterno(rodadoOpt.interno.trim());
        }
      }
    });
  }

  // Listen for changes on interno field to show novelties sidebar
  const internoInput = document.getElementById('form-interno');
  if (internoInput) {
    internoInput.addEventListener('input', () => {
      showNoveltiesForInterno(internoInput.value.trim());
    });
    internoInput.addEventListener('change', () => {
      showNoveltiesForInterno(internoInput.value.trim());
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
}

// 2. MODAL CONTROLLERS
function openNewOrderModal() {
  currentEditingOrderId = null;
  document.getElementById('modal-order-title').textContent = "Nueva Orden de Trabajo";
  
  const modal = document.getElementById('new-order-modal');
  modal.classList.remove('readonly-mode');
  modal.classList.add('open');
  // Reset form
  document.getElementById('work-order-form').reset();
  
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

  // Find corresponding Rodado value in cachedCatalogs
  const rodadoSelect = document.getElementById('form-rodado');
  const rodadoOpt = cachedCatalogs.rodados.find(r => r.label === order.rodado);
  if (rodadoOpt) {
    rodadoSelect.value = rodadoOpt.value;
  } else {
    rodadoSelect.value = "";
  }
  if (rodadoSelect.rebuildSearchable) {
    rodadoSelect.rebuildSearchable();
  }

  // Populate basic inputs
  document.getElementById('form-interno').value = order.interno;
  document.getElementById('form-clasificacion').value = order.clasificacion;
  document.getElementById('form-incidente').value = order.incidente;
  document.getElementById('form-fecha').value = order.fechaEntrega;
  document.getElementById('form-hora').value = order.horario;

  // Clear modal tasks
  const container = document.getElementById('modal-tasks-list');
  container.innerHTML = "";

  // Populate tasks
  if (order.tasks && order.tasks.length > 0) {
    order.tasks.forEach(t => {
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
  const order = activeOrders.find(o => o.id === orderId);
  if (!order) return;

  // Open in read-only mode (no save, no edit)
  currentEditingOrderId = null;

  // Set modal title with sync date
  const syncDate = order.syncDate ? ` — Subida: ${new Date(order.syncDate).toLocaleDateString('es-AR')}` : '';
  document.getElementById('modal-order-title').textContent = `Ver Orden${syncDate}`;

  // Mark modal as readonly
  const modal = document.getElementById('new-order-modal');
  modal.classList.add('open', 'readonly-mode');

  // Find corresponding Rodado value in cachedCatalogs
  const rodadoSelect = document.getElementById('form-rodado');
  const rodadoOpt = cachedCatalogs.rodados.find(r => r.label === order.rodado);
  if (rodadoOpt) {
    rodadoSelect.value = rodadoOpt.value;
  } else {
    rodadoSelect.value = "";
  }
  if (rodadoSelect.rebuildSearchable) {
    rodadoSelect.rebuildSearchable();
  }

  // Populate basic inputs
  document.getElementById('form-interno').value = order.interno;
  document.getElementById('form-clasificacion').value = order.clasificacion;
  document.getElementById('form-incidente').value = order.incidente || '';
  document.getElementById('form-fecha').value = order.fechaEntrega;
  document.getElementById('form-hora').value = order.horario;

  // Clear modal tasks
  const container = document.getElementById('modal-tasks-list');
  container.innerHTML = "";

  // Populate tasks (read-only, no timers)
  if (order.tasks && order.tasks.length > 0) {
    order.tasks.forEach(t => {
      addTaskField(t);
    });
  } else {
    container.innerHTML = `
      <div class="tasks-empty-state">
        <span class="material-icons">assignment_late</span>
        <p>No hay tareas asignadas.</p>
      </div>
    `;
  }
  
  // Clear/Hide novelties side panel in read-only mode
  showNoveltiesForInterno("");
}

function openErrorModal(errorLog, orderId) {
  currentRetryOrderId = orderId;
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
    const res = await fetch(`/api/settings?_=${Date.now()}`);
    if (!res.ok) throw new Error("Error fetching settings");
    const data = await res.json();
    
    document.getElementById('set-portal-url').value = data.portalUrl || "https://taxes.com.ar";
    document.getElementById('set-username').value = data.username || "";
    document.getElementById('set-password').value = data.password || "";
    document.getElementById('set-google-script-url').value = data.googleScriptUrl || "";
    
    if (data.username) {
      document.getElementById('current-user').textContent = data.username;
    }
    
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
  const googleScriptUrl = document.getElementById('set-google-script-url').value;

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portalUrl, username, password, googleScriptUrl })
    });

    if (!res.ok) throw new Error("Failed to save settings");
    const data = await res.json();
    
    showToast("Ajustes guardados correctamente", "success");
    if (username) {
      document.getElementById('current-user').textContent = username;
    }
    
    // Automatically trigger catalog sync on credentials save to help user get started!
    triggerCatalogSync();
  } catch (error) {
    showToast("Error al guardar ajustes", "danger");
    console.error(error);
  }
}

async function testGoogleScriptConnection() {
  const url = document.getElementById('set-google-script-url').value.trim();
  if (!url) {
    showToast("Por favor, ingresa una URL primero", "warning");
    return;
  }

  const btn = document.getElementById('btn-test-google-script');
  const originalText = btn.textContent;
  btn.textContent = "...";
  btn.disabled = true;

  try {
    const res = await fetch('/api/settings/test-google-sheet', {
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
      showToast("¡Conexión con Google Sheets exitosa!", "success");
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
      updateCatalogSyncUI(data);
    }
  } catch (e) {}
}

let lastSyncStatus = "idle";

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
    statusText.style.color = "var(--text-muted)";
    statusText.innerHTML = `Catálogos locales listos (Mockup activado).`;
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
    
    cachedCatalogs = data;
    
    // Populate form dropdowns
    populateSelect('form-rodado', data.rodados, "Seleccionar Rodado...");
    populateSelect('form-responsable', data.responsables, "Seleccionar Responsable...");

    // Convert form-rodado to searchable select
    convertSelectToSearchable(document.getElementById('form-rodado'));

    // Populate bulk form dropdowns
    populateSelect('bulk-task-cc', data.centrosCosto, "Seleccionar Centro Costo...");
    populateSelect('bulk-task-emp', data.empleados, "Seleccionar Empleado...");
    
    // Set default CC for bulk task to "15" (Mecanica) and filter employee list
    const bulkCc = document.getElementById('bulk-task-cc');
    if (bulkCc) {
      bulkCc.value = "15";
      updateBulkEmployeeDropdown();
    }
    
    // Render the bulk vehicle selector list
    renderBulkVehicleSelector();

    // Update status text
    if (data.rodados && data.rodados.length > 5) {
      document.getElementById('catalog-status-text').textContent = "Catálogos cargados desde la web de Taxes.";
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
  const ccSelect = card.querySelector('.task-cc');
  const empSelect = card.querySelector('.task-emp');
  if (!ccSelect || !empSelect) return;

  const selectedCc = ccSelect.value;
  const currentValue = empSelect.value;

  let filteredEmployees = cachedCatalogs.empleados;
  if (selectedCc === "15") { // MECANICA
    const cleanName = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
    const mecanicaNamesCleaned = new Set(MECANICA_EMPLOYEES.map(name => cleanName(name)));
    filteredEmployees = cachedCatalogs.empleados.filter(emp => {
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
    const isSelected = opt.value === currentValue;
    empOptions += `<option value="${opt.value}" ${isSelected ? "selected" : ""}>${opt.label}</option>`;
  });
  empSelect.innerHTML = empOptions;

  // Rebuild the searchable select UI dropdown options
  if (empSelect.rebuildSearchable) {
    empSelect.rebuildSearchable();
  }
}

function addTaskField(taskData = null) {
  const container = document.getElementById('modal-tasks-list');
  const emptyState = document.getElementById('tasks-empty-state');
  if (emptyState) emptyState.style.display = 'none';

  const taskIndex = container.querySelectorAll('.task-item-card').length;
  // Use task ID from data if editing, else generate a unique card ID
  const taskId = taskData && taskData.id ? taskData.id : `task-card-${Date.now()}-${taskIndex}`;

  // Build select option strings
  let ccOptions = `<option value="">Seleccionar Centro Costo...</option>`;
  cachedCatalogs.centrosCosto.forEach(opt => {
    const isSelected = taskData ? (opt.value === taskData.centroCosto) : (opt.value === "15");
    ccOptions += `<option value="${opt.value}" ${isSelected ? "selected" : ""}>${opt.label}</option>`;
  });

  const cardHtml = `
    <div class="task-item-card" id="${taskId}">
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
          <input type="number" step="0.01" min="0" value="${taskData ? taskData.horasEstimadas : '0.00'}" class="task-hours" oninput="updateHoursReadable(this)">
          <small class="hours-readable" style="color:var(--primary);font-size:11px;margin-top:2px;display:block;">${taskData && taskData.horasEstimadas ? formatDecimalHours(taskData.horasEstimadas) : ''}</small>
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
        <textarea placeholder="Describe las actividades a realizar..." rows="2" class="task-desc">${taskData ? taskData.descripcion : ''}</textarea>
      </div>
    </div>
  `;

  // Append just before emptyState or at end
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = cardHtml;
  const cardElement = tempDiv.firstElementChild;
  container.appendChild(cardElement);

  // Set up the initial options inside the Employee dropdown (handles initial filtering if Mecanica)
  const empSelect = cardElement.querySelector('.task-emp');
  if (taskData) {
    const ccSelect = cardElement.querySelector('.task-cc');
    ccSelect.value = taskData.centroCosto;
    
    // We filter first and then assign the value
    let filteredEmployees = cachedCatalogs.empleados;
    if (taskData.centroCosto === "15") {
      const cleanName = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
      const mecanicaNamesCleaned = new Set(MECANICA_EMPLOYEES.map(name => cleanName(name)));
      filteredEmployees = cachedCatalogs.empleados.filter(emp => {
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
    let empOptions = `<option value="">Seleccionar Empleado...</option>`;
    filteredEmployees.forEach(opt => {
      const isSelected = opt.value === taskData.empleado;
      empOptions += `<option value="${opt.value}" ${isSelected ? "selected" : ""}>${opt.label}</option>`;
    });
    empSelect.innerHTML = empOptions;
    empSelect.value = taskData.empleado;
  } else {
    // Fresh task: defaults to MECANICA (value "15") so filter immediately
    updateEmployeeDropdownForCard(cardElement);
  }

  // Convert employee select to searchable select
  convertSelectToSearchable(empSelect);

  // Auto-resume timer if running in database taskData
  if (taskData && taskData.timerStart) {
    localStorage.setItem(`timer_start_${taskId}`, taskData.timerStart);
  }

  // Auto-resume timer if it is running in localStorage!
  const timerKey = `timer_start_${taskId}`;
  const runningStartTime = localStorage.getItem(timerKey);
  if (runningStartTime) {
    const startTime = parseInt(runningStartTime);
    startTimerInterval(taskId, startTime);

    // Update Button UI immediately to show running state
    const btn = cardElement.querySelector('.btn-timer-toggle');
    if (btn) {
      btn.classList.add('running');
      btn.querySelector('.material-icons').textContent = 'stop';
      btn.querySelector('.btn-text').textContent = 'Detener';
    }
  }

  updateTaskCountBadge();
}

function removeTaskField(cardId) {
  const card = document.getElementById(cardId);
  if (card) {
    card.remove();
    
    // Clean up timers from localStorage and interval registry
    localStorage.removeItem(`timer_start_${cardId}`);
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

function renderOrders() {
  const container = document.getElementById('orders-list-container');
  const queueContainer = document.getElementById('sync-queue-container');
  const historyContainer = document.getElementById('history-list-container');
  
  if (!container) return;

  // Apply search filtering for active (non-synced) orders
  const query = document.getElementById('order-search').value.toLowerCase();
  const activeLocalOrders = activeOrders.filter(o => o.syncStatus !== 'success');
  const filtered = activeLocalOrders.filter(o => 
    o.rodado.toLowerCase().includes(query) || 
    o.interno.toLowerCase().includes(query) || 
    o.clasificacion.toLowerCase().includes(query)
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

  // Render History Tab (only synced success orders)
  if (historyContainer) {
    const historySearchEl = document.getElementById('history-search');
    const historyQuery = historySearchEl ? historySearchEl.value.toLowerCase() : '';
    
    const syncedOrders = activeOrders.filter(o => o.syncStatus === 'success');
    const filteredHistory = syncedOrders.filter(o => 
      o.rodado.toLowerCase().includes(historyQuery) || 
      o.interno.toLowerCase().includes(historyQuery) || 
      o.clasificacion.toLowerCase().includes(historyQuery)
    );

    if (filteredHistory.length === 0) {
      historyContainer.innerHTML = `
        <div class="empty-state">
          <span class="material-icons">history_toggle_off</span>
          <p>No hay órdenes sincronizadas aún.</p>
        </div>
      `;
    } else {
      historyContainer.innerHTML = filteredHistory.map(order => createHistoryCardHtml(order)).join('');
    }
  }

  // Render Sync Queue (only pending, syncing, or error ones)
  const queueOrders = activeOrders.filter(o => o.syncStatus !== 'success');
  if (queueOrders.length === 0) {
    queueContainer.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">cloud_done</span>
        <p>Todas las órdenes están sincronizadas.</p>
      </div>
    `;
  } else {
    queueContainer.innerHTML = queueOrders.map(order => createQueueCardHtml(order)).join('');
  }

  // Render the Operator/Tasks active dashboard on home page
  renderDashboard();
}

function createHistoryCardHtml(order) {
  const syncDate = order.syncDate ? new Date(order.syncDate).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Fecha desconocida';
  return `
    <div class="order-card">
      <div class="order-card-header">
        <div>
          <div class="order-card-title">${order.rodado}</div>
          <div class="order-card-subtitle">Interno: <strong>${order.interno}</strong> | Clasificación: <strong>${order.clasificacion}</strong></div>
        </div>
        <span class="badge-status success"><span class="material-icons">check_circle</span> Sincronizado</span>
      </div>
      <div class="order-card-footer">
        <div class="tasks-summary">
          <span class="material-icons">format_list_bulleted</span>
          <span>${order.tasks.length} Tareas &nbsp;·&nbsp; <span class="material-icons" style="font-size:12px;vertical-align:middle;">cloud_upload</span> ${syncDate}</span>
        </div>
        <div class="card-actions">
          <button class="icon-btn primary" onclick="viewOrder('${order.id}')" title="Ver Orden">
            <span class="material-icons">visibility</span>
          </button>
          <button class="icon-btn danger" onclick="deleteOrder('${order.id}')" title="Eliminar de la App (ya está en Taxes)">
            <span class="material-icons">delete</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function updateStats() {
  const total = activeOrders.length;
  const synced = activeOrders.filter(o => o.syncStatus === 'success').length;
  const pending = activeOrders.filter(o => o.syncStatus === 'pending' || o.syncStatus === 'syncing').length;

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-synced').textContent = synced;
  document.getElementById('stat-pending').textContent = pending;
}

function createOrderCardHtml(order) {
  let statusBadge = '';
  if (order.syncStatus === 'pending') {
    statusBadge = `<span class="badge-status pending"><span class="material-icons">hourglass_empty</span> Pendiente</span>`;
  } else if (order.syncStatus === 'syncing') {
    statusBadge = `<span class="badge-status syncing"><span class="material-icons spinner">autorenew</span> Sincronizando</span>`;
  } else if (order.syncStatus === 'success') {
    statusBadge = `<span class="badge-status success"><span class="material-icons">check_circle</span> Sincronizado</span>`;
  } else if (order.syncStatus === 'error') {
    statusBadge = `<span class="badge-status error" onclick="openErrorModal(\`${order.syncError.replace(/"/g, '&quot;')}\`, '${order.id}')"><span class="material-icons">error</span> Error</span>`;
  } else if (order.syncStatus === 'local') {
    const allCompleted = (order.tasks || []).length > 0 && (order.tasks || []).every(t => t.status === "Finalizada");
    if (allCompleted) {
      statusBadge = `<span class="badge-status success" style="background-color:#d1fae5; color:#065f46; border:1px solid rgba(6,95,70,0.2);"><span class="material-icons" style="font-size:12px;">check_circle</span> Completada</span>`;
    } else {
      statusBadge = `<span class="badge-status local" style="background-color:#e0f2fe; color:#0369a1; border:1px solid rgba(3,105,161,0.2);"><span class="material-icons" style="font-size:12px;">construction</span> En Curso</span>`;
    }
  }

  const dateFormatted = order.fechaEntrega ? order.fechaEntrega.split('-').reverse().join('/') : '-';

  return `
    <div class="order-card">
      <div class="order-card-header">
        <div>
          <div class="order-card-title">${order.rodado}</div>
          <div class="order-card-subtitle">Interno: <strong>${order.interno}</strong> | Clasificación: <strong>${order.clasificacion}</strong></div>
        </div>
        ${statusBadge}
      </div>

      <div class="order-card-footer">
        <div class="tasks-summary">
          <span class="material-icons">format_list_bulleted</span>
          <span>${order.tasks.length} Tareas asignadas</span>
        </div>
        <div class="card-actions">
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
          <button class="icon-btn danger" onclick="deleteOrder('${order.id}')" title="Eliminar Localmente">
            <span class="material-icons">delete</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function createQueueCardHtml(order) {
  let statusColor = 'pending';
  let desc = 'En cola de espera';
  let actionBtn = '';

  if (order.syncStatus === 'local') {
    statusColor = 'secondary';
    const allCompleted = (order.tasks || []).length > 0 && (order.tasks || []).every(t => t.status === "Finalizada");
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
        <div>
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
 
  // Manual validations for touch optimization
  if (!rodadoEl.value) return showToast("Por favor, selecciona un Rodado.", "danger");
  if (!internoEl.value) return showToast("Por favor, ingresa el Interno de Unidad.", "danger");
  if (!clasificacionEl.value) return showToast("Por favor, selecciona una Clasificación.", "danger");
 
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
 
    tasks.push({
      id: taskId,
      centroCosto: cc,
      empleado: emp,
      horasEstimadas: hours,
      status: status,
      descripcion: desc,
      timerStart: timerStartVal
    });
  });
 
  if (!tasksValid) {
    return showToast("Completa el Centro de Costo y Operario de todas las tareas.", "danger");
  }
 
  const payload = {
    rodado: rodadoEl.options[rodadoEl.selectedIndex].text,
    responsable: "AUTO", // Always send AUTO so the worker resolves it from the logged-in user
    interno: internoEl.value,
    clasificacion: clasificacionEl.value,
    fechaEntrega: fechaEl.value,
    horario: horaEl.value,
    incidente: incidenteEl.value,
    tasks: tasks
  };
 
  const url = currentEditingOrderId ? `/api/orders/${currentEditingOrderId}` : '/api/orders';
  const method = currentEditingOrderId ? 'PUT' : 'POST';
 
  try {
    const res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
 
    if (!res.ok) throw new Error("Error submitting work order");
    
    const msg = currentEditingOrderId ? "Orden de Trabajo actualizada y encolada" : "Orden de Trabajo guardada y encolada para Taxes";
    showToast(msg, "success");
    closeNewOrderModal();
    fetchOrders();
    switchView('home'); // Go to dashboard (Inicio) to see the tasks and stopwatch
  } catch (error) {
    const msg = currentEditingOrderId ? "Fallo al actualizar la orden" : "Fallo al crear la orden";
    showToast(msg, "danger");
    console.error(error);
  }
}

// 9. SYNC ACTIONS (RETRY & DELETE)
async function retrySync(orderId) {
  try {
    const res = await fetch(`/api/orders/retry/${orderId}`, { method: 'POST' });
    if (!res.ok) throw new Error("Failed to retry");
    
    showToast("Reintento encolado", "warning");
    fetchOrders();
  } catch (error) {
    showToast("Error al encolar reintento", "danger");
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
  if (confirm("¿Estás seguro de eliminar esta orden localmente? No se borrará del portal Taxes si ya fue sincronizada.")) {
    try {
      const res = await fetch(`/api/orders/${orderId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error("Failed to delete");
      
      showToast("Orden eliminada localmente", "success");
      fetchOrders();
    } catch (error) {
      showToast("Error al eliminar orden", "danger");
      console.error(error);
    }
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
  const runningByEmployee = {};

  activeOrders.forEach(order => {
    (order.tasks || []).forEach(task => {
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
        const addedHours = parseFloat((elapsedMs / (1000 * 60 * 60)).toFixed(2));
        const currentHours = parseFloat(task.horasEstimadas) || 0;
        const newHours = parseFloat((currentHours + addedHours).toFixed(2));

        // Clean up local storage and update database task
        localStorage.removeItem(`timer_start_${task.id}`);

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
        const updatedHours = hoursInput ? parseFloat(hoursInput.value) : 0;
        
        const tasks = order.tasks.map(t => {
          if (t.id === taskId) {
            return {
              ...t,
              timerStart: null,
              horasEstimadas: updatedHours
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
    localStorage.removeItem(timerKey);

    // Clear interval
    if (activeIntervalTimers[taskId]) {
      clearInterval(activeIntervalTimers[taskId]);
      delete activeIntervalTimers[taskId];
    }

    // Calculate decimal hours
    const elapsedMs = Date.now() - startTime;
    const addedHours = parseFloat((elapsedMs / (1000 * 60 * 60)).toFixed(2));

    // Find and update hours input in this task card
    const card = document.getElementById(taskId) || btn.closest('.task-item-card');
    let totalHours = addedHours;
    if (card) {
      const hoursInput = card.querySelector('.task-hours');
      if (hoursInput) {
        const currentHours = parseFloat(hoursInput.value) || 0;
        totalHours = parseFloat((currentHours + addedHours).toFixed(2));
        hoursInput.value = totalHours.toFixed(2);
        updateHoursReadable(hoursInput);
      }
    }

    // Reset Button UI
    btn.classList.remove('running');
    btn.querySelector('.material-icons').textContent = 'play_arrow';
    btn.querySelector('.btn-text').textContent = 'Iniciar';
    display.textContent = '00:00:00';
    showToast(`Tiempo sumado: +${formatDecimalHours(addedHours)}. Total: ${formatDecimalHours(totalHours)}`, "success");
  }
}

function formatDecimalHours(decimalHours) {
  const h = Math.floor(decimalHours);
  const m = Math.round((decimalHours - h) * 60);
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, '0')}min`;
}

function updateHoursReadable(inputEl) {
  const readableEl = inputEl.parentElement.querySelector('.hours-readable');
  if (!readableEl) return;
  const val = parseFloat(inputEl.value) || 0;
  readableEl.textContent = val > 0 ? formatDecimalHours(val) : '';
}

function startTimerInterval(taskId, startTime) {
  const display = document.getElementById(`timer-display-${taskId}`);
  if (!display) return;

  if (activeIntervalTimers[taskId]) {
    clearInterval(activeIntervalTimers[taskId]);
  }

  function update() {
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const hh = Math.floor(elapsedSeconds / 3600);
    const mm = Math.floor((elapsedSeconds % 3600) / 60);
    const ss = elapsedSeconds % 60;
    display.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
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
    labelSpan = document.createElement('span');
    labelSpan.className = 'trigger-label';
    labelSpan.textContent = 'Seleccionar...';
    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'material-icons';
    arrowSpan.textContent = 'arrow_drop_down';
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

    options.forEach(opt => {
      if (opt.value === '' && opt.text.includes('Seleccionar')) {
        if (opt.selected) {
          labelSpan.textContent = opt.text;
        }
        return;
      }

      const li = document.createElement('li');
      li.className = 'searchable-select-option';
      if (opt.selected) {
        li.classList.add('selected');
        labelSpan.textContent = opt.text;
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

    if (listContainer.children.length === 0) {
      const li = document.createElement('li');
      li.className = 'searchable-select-option no-results';
      li.textContent = 'No hay opciones disponibles';
      listContainer.appendChild(li);
    }
  }

  function filterOptions(query) {
    const term = query.toLowerCase().trim();
    const items = Array.from(listContainer.querySelectorAll('.searchable-select-option:not(.no-results)'));
    let matchCount = 0;

    items.forEach(item => {
      const text = item.textContent.toLowerCase();
      const isMatch = text.includes(term);
      item.style.display = isMatch ? 'block' : 'none';
      if (isMatch) matchCount++;
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

    countSpan.textContent = `${matchCount} de ${items.length} opciones`;
  }

  rebuildList();
  selectEl.rebuildSearchable = rebuildList;
}

// --- OPERATOR & ACTIVE TAREAS DASHBOARD ---
let activeDashboardIntervals = {};

function renderDashboard() {
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
  const activeLocalOrders = activeOrders;
  
  const workingTasks = [];
  const pausedTasks = [];

  const workingEmployeeLabels = new Set();
  const pausedEmployeeLabels = new Set();

  activeLocalOrders.forEach(order => {
    (order.tasks || []).forEach(task => {
      if (task.status !== 'Finalizada') {
        const empOpt = cachedCatalogs.empleados.find(e => e.value === task.empleado);
        const empLabel = empOpt ? empOpt.label : task.empleado;
        const isTimerRunning = task.timerStart !== null && task.timerStart > 0;

        const taskInfo = {
          orderId: order.id,
          interno: order.interno,
          rodado: order.rodado,
          taskId: task.id,
          empleadoValue: task.empleado,
          empleadoLabel: empLabel,
          centroCosto: task.centroCosto,
          horasEstimadas: parseFloat(task.horasEstimadas) || 0,
          descripcion: task.descripcion || '(Sin descripción)',
          timerStart: task.timerStart,
          isTimerRunning: isTimerRunning
        };

        if (isTimerRunning) {
          workingTasks.push(taskInfo);
          workingEmployeeLabels.add(empLabel.toLowerCase().trim());
        } else {
          pausedTasks.push(taskInfo);
          pausedEmployeeLabels.add(empLabel.toLowerCase().trim());
        }
      }
    });
  });

  // Render count badges
  document.getElementById('count-working').textContent = workingTasks.length;
  document.getElementById('count-paused').textContent = pausedTasks.length;

  // 1. Render working grid
  if (workingTasks.length === 0) {
    gridWorking.innerHTML = `<div class="empty-dashboard-state">No hay operarios trabajando actualmente.</div>`;
  } else {
    gridWorking.innerHTML = workingTasks.map(t => {
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - t.timerStart) / 1000));
      const hh = Math.floor(elapsedSeconds / 3600);
      const mm = Math.floor((elapsedSeconds % 3600) / 60);
      const ss = elapsedSeconds % 60;
      const displayTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;

      return `
        <div class="dashboard-card working" id="dash-card-${t.taskId}">
          <div class="dashboard-card-title" title="${t.empleadoLabel}">${t.empleadoLabel}</div>
          <div class="dashboard-card-subtitle">Int. ${t.interno} | ${t.rodado.split(' - ')[0]}</div>
          <div class="dashboard-card-desc">${t.descripcion}</div>
          <div class="dashboard-card-timer" id="dash-timer-${t.taskId}">${displayTime}</div>
          <div class="dashboard-card-actions">
            <button type="button" class="btn btn-warning btn-xs" onclick="toggleDashboardTaskTimer('${t.orderId}', '${t.taskId}')">
              <span class="material-icons" style="font-size:12px;">pause</span> Pausar
            </button>
            <button type="button" class="btn btn-primary btn-xs" onclick="markDashboardTaskFinished('${t.orderId}', '${t.taskId}')" style="background-color: var(--success); color: white; border-color: var(--success);">
              <span class="material-icons" style="font-size:12px;">check</span> Fin
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
      return `
        <div class="dashboard-card paused">
          <div class="dashboard-card-title" title="${t.empleadoLabel}">${t.empleadoLabel}</div>
          <div class="dashboard-card-subtitle">Int. ${t.interno} | ${t.rodado.split(' - ')[0]}</div>
          <div class="dashboard-card-desc">${t.descripcion}</div>
          <div class="dashboard-card-timer">${t.horasEstimadas.toFixed(2)} hrs</div>
          <div class="dashboard-card-actions">
            <button type="button" class="btn btn-primary btn-xs" onclick="toggleDashboardTaskTimer('${t.orderId}', '${t.taskId}')" style="background-color: var(--success); color: white; border-color: var(--success);">
              <span class="material-icons" style="font-size:12px;">play_arrow</span> Reanudar
            </button>
            <button type="button" class="btn btn-primary btn-xs" onclick="markDashboardTaskFinished('${t.orderId}', '${t.taskId}')">
              <span class="material-icons" style="font-size:12px;">check</span> Fin
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  // 3. Render Free Mechanics
  const cleanName = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");

  const activeBaseList = activeMechanicsList && activeMechanicsList.length > 0 ? activeMechanicsList : MECANICA_EMPLOYEES;

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

  document.getElementById('count-free').textContent = freeMechanics.length;

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
}

function startDashboardTimerUpdate(taskId, startTime) {
  const display = document.getElementById(`dash-timer-${taskId}`);
  if (!display) return;

  if (activeDashboardIntervals[taskId]) {
    clearInterval(activeDashboardIntervals[taskId]);
  }

  function update() {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const hh = Math.floor(elapsedSeconds / 3600);
    const mm = Math.floor((elapsedSeconds % 3600) / 60);
    const ss = elapsedSeconds % 60;
    const el = document.getElementById(`dash-timer-${taskId}`);
    if (el) {
      el.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    } else {
      clearInterval(activeDashboardIntervals[taskId]);
      delete activeDashboardIntervals[taskId];
    }
  }

  update();
  activeDashboardIntervals[taskId] = setInterval(update, 1000);
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

    task.timerStart = Date.now();
    localStorage.setItem(`timer_start_${taskId}`, task.timerStart);
    showToast("Cronómetro iniciado", "info");
  } else {
    // --- PAUSE TIMER ---
    const elapsedMs = Date.now() - task.timerStart;
    const addedHours = parseFloat((elapsedMs / (1000 * 60 * 60)).toFixed(2));
    const currentHours = parseFloat(task.horasEstimadas) || 0;
    
    task.horasEstimadas = parseFloat((currentHours + addedHours).toFixed(2));
    task.timerStart = null;
    localStorage.removeItem(`timer_start_${taskId}`);

    // Kill the dashboard interval for this task immediately
    if (activeDashboardIntervals[taskId]) {
      clearInterval(activeDashboardIntervals[taskId]);
      delete activeDashboardIntervals[taskId];
    }

    showToast(`Tiempo sumado: +${addedHours.toFixed(2)} hrs.`, "success");
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

    if (!res.ok) throw new Error("Error updating task timer");
    fetchOrders();
  } catch (error) {
    showToast("Error al guardar el cronómetro", "danger");
    console.error(error);
  }
}

async function markDashboardTaskFinished(orderId, taskId) {
  const order = activeOrders.find(o => o.id === orderId);
  if (!order) return;

  if (!confirm("¿Estás seguro de marcar esta tarea como FINALIZADA?")) return;

  // Find the actual task object inside order.tasks (by reference)
  const task = order.tasks.find(t => t.id === taskId);
  if (!task) return;

  if (task.timerStart !== null && task.timerStart > 0) {
    const elapsedMs = Date.now() - task.timerStart;
    const addedHours = parseFloat((elapsedMs / (1000 * 60 * 60)).toFixed(2));
    const currentHours = parseFloat(task.horasEstimadas) || 0;
    task.horasEstimadas = parseFloat((currentHours + addedHours).toFixed(2));
    task.timerStart = null;
    localStorage.removeItem(`timer_start_${taskId}`);
  }

  task.status = "Finalizada";

  // Kill the dashboard interval for this task immediately
  if (activeDashboardIntervals[taskId]) {
    clearInterval(activeDashboardIntervals[taskId]);
    delete activeDashboardIntervals[taskId];
  }

  // OPTIMISTIC UPDATE: re-render dashboard immediately so user sees the task disappear
  renderDashboard();
  showToast("Tarea finalizada", "success");

  const allCompleted = order.tasks.every(t => t.status === "Finalizada");

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

    if (!res.ok) throw new Error("Error updating task status");
    fetchOrders();
    
    if (allCompleted) {
      showToast("¡Todas las tareas finalizadas! Puedes subir la orden a Taxes manualmente desde el listado de órdenes.", "success");
    }
  } catch (error) {
    showToast("Error al finalizar la tarea", "danger");
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

  // Render checklist items
  container.innerHTML = MECANICA_EMPLOYEES.map((name, index) => {
    const isChecked = activeMechanicsList.includes(name);
    return `
      <label class="mechanic-check-item">
        <input type="checkbox" name="active_mechanic" value="${name}" ${isChecked ? 'checked' : ''}>
        <span>${name}</span>
      </label>
    `;
  }).join('');

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

    if (res.ok) {
      const data = await res.json();
      activeMechanicsList = data.list;
      showToast("Lista de mecánicos activos actualizada", "success");
      closeActiveMechanicsModal();
      renderDashboard();
    } else {
      throw new Error("Error saving active mechanics");
    }
  } catch (error) {
    console.error(error);
    showToast("Error al guardar la lista de mecánicos activos", "danger");
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

  updateBulkSummary();
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

function filterBulkVehicles() {
  const searchInput = document.getElementById('bulk-vehicle-search');
  if (!searchInput) return;

  const query = searchInput.value.toLowerCase().trim();
  const items = document.querySelectorAll('#bulk-vehicle-list .bulk-vehicle-item');

  items.forEach(item => {
    const text = item.textContent.toLowerCase();
    if (text.includes(query)) {
      item.style.display = 'flex';
    } else {
      item.style.display = 'none';
    }
  });
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

function updateBulkEmployeeDropdown() {
  const ccSelect = document.getElementById('bulk-task-cc');
  const empSelect = document.getElementById('bulk-task-emp');
  if (!ccSelect || !empSelect) return;

  const selectedCc = ccSelect.value;
  const currentValue = empSelect.value;

  let filteredEmployees = cachedCatalogs.empleados;
  if (selectedCc === "15") { // MECANICA
    const mecanicaNames = new Set(MECANICA_EMPLOYEES.map(name => name.toLowerCase().trim()));
    filteredEmployees = cachedCatalogs.empleados.filter(emp => {
      const empLabel = emp.label.toLowerCase().trim();
      return mecanicaNames.has(empLabel);
    });
  }

  let empOptions = `<option value="">Seleccionar Empleado...</option>`;
  filteredEmployees.forEach(opt => {
    const isSelected = opt.value === currentValue;
    empOptions += `<option value="${opt.value}" ${isSelected ? "selected" : ""}>${opt.label}</option>`;
  });
  empSelect.innerHTML = empOptions;

  if (empSelect.rebuildSearchable) {
    empSelect.rebuildSearchable();
  }
}

async function submitBulkOrders() {
  const ccEl = document.getElementById('bulk-task-cc');
  const empEl = document.getElementById('bulk-task-emp');
  const descEl = document.getElementById('bulk-task-desc');
  const timeStartEl = document.getElementById('bulk-time-start');
  const timeEndEl = document.getElementById('bulk-time-end');
  const clasificacionEl = document.getElementById('bulk-clasificacion');
  const incidenteEl = document.getElementById('bulk-incidente');

  const selectedChks = document.querySelectorAll('#bulk-vehicle-list input[type="checkbox"]:checked');
  if (selectedChks.length === 0) {
    return showToast("Selecciona al menos un vehículo.", "danger");
  }
  if (!ccEl.value) {
    return showToast("Selecciona un Centro de Costo.", "danger");
  }
  if (!empEl.value) {
    return showToast("Selecciona un Operario/Empleado.", "danger");
  }
  if (!descEl.value.trim()) {
    return showToast("Ingresa la descripción de la tarea.", "danger");
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

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < selectedChks.length; i++) {
    const chk = selectedChks[i];
    const rodadoId = chk.value;
    const rodadoOpt = cachedCatalogs.rodados.find(r => r.value === rodadoId);
    if (!rodadoOpt) continue;

    const task = {
      centroCosto: ccEl.value,
      empleado: empEl.value,
      horasEstimadas: hoursPerVehicleFormatted,
      descripcion: descEl.value.trim(),
      status: "Finalizada",
      timerStart: null
    };

    const payload = {
      rodado: rodadoOpt.label,
      responsable: "AUTO",
      interno: rodadoOpt.interno || "",
      clasificacion: clasificacionEl.value,
      fechaEntrega: fechaEntrega,
      horario: horario,
      incidente: incidenteEl.value.trim(),
      tasks: [task]
    };

    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        successCount++;
      } else {
        errorCount++;
      }
    } catch (e) {
      errorCount++;
      console.error("Error creating bulk order for " + rodadoOpt.label, e);
    }
  }

  if (errorCount === 0) {
    showToast(`Éxito: Se crearon ${successCount} órdenes correctamente.`, "success");
    toggleAllBulkVehicles(false);
    document.getElementById('bulk-incidente').value = '';
    fetchOrders();
    switchView('orders');
  } else if (successCount > 0) {
    showToast(`Advertencia: Se crearon ${successCount} órdenes, pero ${errorCount} fallaron.`, "warning");
    toggleAllBulkVehicles(false);
    fetchOrders();
    switchView('orders');
  } else {
    showToast(`Error: Falló la creación de las ${errorCount} órdenes.`, "danger");
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
      headers: { 'Content-Type': 'application/json' },
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
