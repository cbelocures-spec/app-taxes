// Global State
let cachedCatalogs = { rodados: [], responsables: [], empleados: [], centrosCosto: [] };
let activeOrders = [];
let currentRetryOrderId = null;
let currentEditingOrderId = null;
let catalogSyncInterval = null;

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

  // Setup Event Listeners
  document.getElementById('settings-form').addEventListener('submit', saveSettings);

  // Dynamic change listener for Centro de Costo (task-cc) to filter employees (task-emp)
  const tasksContainer = document.getElementById('modal-tasks-list');
  if (tasksContainer) {
    tasksContainer.addEventListener('change', (e) => {
      if (e.target && e.target.classList.contains('task-cc')) {
        const card = e.target.closest('.task-item-card');
        if (card) {
          updateEmployeeDropdownForCard(card);
        }
      }
    });
  }

  // Poll for orders sync status in real time
  setInterval(fetchOrders, 3000);
  setInterval(checkWorkerStatus, 3000);
  setInterval(fetchSettingsPolling, 3000);
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
  
  document.getElementById('new-order-modal').classList.add('open');
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
}

function closeNewOrderModal() {
  document.getElementById('new-order-modal').classList.remove('open');
  currentEditingOrderId = null;
}

function editOrder(orderId) {
  const order = activeOrders.find(o => o.id === orderId);
  if (!order) return;

  currentEditingOrderId = orderId;

  // Set modal title
  document.getElementById('modal-order-title').textContent = "Editar Orden de Trabajo";

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
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error("Error fetching settings");
    const data = await res.json();
    
    document.getElementById('set-portal-url').value = data.portalUrl || "https://taxes.com.ar";
    document.getElementById('set-username').value = data.username || "";
    document.getElementById('set-password').value = data.password || "";
    
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

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portalUrl, username, password })
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
    const res = await fetch('/api/settings');
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
    const mecanicaNames = new Set(MECANICA_EMPLOYEES.map(name => name.toLowerCase().trim()));
    filteredEmployees = cachedCatalogs.empleados.filter(emp => {
      const empLabel = emp.label.toLowerCase().trim();
      return mecanicaNames.has(empLabel);
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
          <input type="number" step="0.25" min="0" value="${taskData ? taskData.horasEstimadas : '0.00'}" class="task-hours">
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
      const mecanicaNames = new Set(MECANICA_EMPLOYEES.map(name => name.toLowerCase().trim()));
      filteredEmployees = cachedCatalogs.empleados.filter(emp => mecanicaNames.has(emp.label.toLowerCase().trim()));
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
    const res = await fetch('/api/orders');
    if (!res.ok) throw new Error("Error fetching orders");
    const data = await res.json();
    
    activeOrders = data;
    renderOrders();
    updateStats();
  } catch (error) {
    console.error("Error polling orders:", error);
  }
}

function renderOrders() {
  const container = document.getElementById('orders-list-container');
  const queueContainer = document.getElementById('sync-queue-container');
  
  if (!container) return;

  // Apply search filtering
  const query = document.getElementById('order-search').value.toLowerCase();
  const filtered = activeOrders.filter(o => 
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
    statusBadge = `<span class="badge-status local" style="background-color:#e0f2fe; color:#0369a1; border:1px solid rgba(3,105,161,0.2);"><span class="material-icons" style="font-size:12px;">construction</span> En Curso</span>`;
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
          ${(order.syncStatus === 'error' || order.syncStatus === 'pending' || order.syncStatus === 'local') ? `
            <button class="icon-btn warning" onclick="editOrder('${order.id}')" title="Editar Orden">
              <span class="material-icons">edit</span>
            </button>
          ` : ''}
          ${order.syncStatus === 'error' ? `
            <button class="icon-btn primary" onclick="retrySync('${order.id}')" title="Reintentar Sincronización">
              <span class="material-icons">sync</span>
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
    desc = 'En Taller (tareas pendientes)';
    actionBtn = `
      <button class="btn btn-warning btn-sm" onclick="editOrder('${order.id}')" style="display:flex; align-items:center; gap:4px;">
        <span class="material-icons" style="font-size:16px;">edit</span> Editar
      </button>
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
        <button class="btn btn-primary btn-sm" onclick="retrySync('${order.id}')" style="display:flex; align-items:center; gap:4px;">
          <span class="material-icons" style="font-size:16px;">sync</span> Reintentar
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
    switchView('orders'); // Go to orders list
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

function toggleTaskTimer(taskId) {
  const display = document.getElementById(`timer-display-${taskId}`);
  const btn = document.getElementById(`timer-btn-${taskId}`);
  if (!display || !btn) return;

  const timerKey = `timer_start_${taskId}`;
  const isRunning = localStorage.getItem(timerKey) !== null;

  if (!isRunning) {
    // Start stopwatch
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
      }
    }

    // Reset Button UI
    btn.classList.remove('running');
    btn.querySelector('.material-icons').textContent = 'play_arrow';
    btn.querySelector('.btn-text').textContent = 'Iniciar';
    display.textContent = '00:00:00';
    showToast(`Tiempo sumado: +${addedHours.toFixed(2)} hrs. Total: ${totalHours.toFixed(2)} hrs.`, "success");
  }
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

  // Active tasks from local or error orders
  const activeLocalOrders = activeOrders.filter(o => o.syncStatus === 'local' || o.syncStatus === 'error');
  
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

  const freeMechanics = MECANICA_EMPLOYEES.filter(name => {
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

  const tasks = [...order.tasks];
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  const isRunning = task.timerStart !== null && task.timerStart > 0;

  if (!isRunning) {
    task.timerStart = Date.now();
    localStorage.setItem(`timer_start_${taskId}`, task.timerStart);
    showToast("Cronómetro iniciado", "info");
  } else {
    const elapsedMs = Date.now() - task.timerStart;
    const addedHours = parseFloat((elapsedMs / (1000 * 60 * 60)).toFixed(2));
    const currentHours = parseFloat(task.horasEstimadas) || 0;
    
    task.horasEstimadas = parseFloat((currentHours + addedHours).toFixed(2));
    task.timerStart = null;
    localStorage.removeItem(`timer_start_${taskId}`);

    showToast(`Tiempo sumado: +${addedHours.toFixed(2)} hrs.`, "success");
  }

  try {
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...order,
        tasks: tasks
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

  const tasks = [...order.tasks];
  const task = tasks.find(t => t.id === taskId);
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
  showToast("Tarea finalizada", "success");

  const allCompleted = tasks.every(t => t.status === "Finalizada");

  try {
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...order,
        tasks: tasks
      })
    });

    if (!res.ok) throw new Error("Error updating task status");
    fetchOrders();
    
    if (allCompleted) {
      showToast("¡Todas las tareas finalizadas! La orden se sincronizará automáticamente.", "success");
    }
  } catch (error) {
    showToast("Error al finalizar la tarea", "danger");
    console.error(error);
  }
}
