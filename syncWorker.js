const puppeteer = require('puppeteer');
const db = require('./database');

// Mock data based on screenshots to pre-populate catalogs if scraping hasn't run yet
const MOCK_CATALOGS = {
  rodados: [
    { value: "1", label: "FORD - F100. Interno 1" },
    { value: "2", label: "VOLKSWAGEN - SAVEIRO 1.6L Interno 2" },
    { value: "4", label: "VOLKSWAGEN - AMAROK Interno 4" },
    { value: "5", label: "VOLKSWAGEN - AMAROK Interno 5" },
    { value: "7", label: "VOLKSWAGEN - AMAROK Interno 7" }
  ],
  responsables: [
    { value: "1", label: "BELOCURES CESAR HERNAN" },
    { value: "2", label: "GOMEZ MARCELO JAVIER" }
  ],
  empleados: [
    { value: "1", label: "Canaviri Fernandez Jesús" },
    { value: "2", label: "Cuba Orosco, Kevin Genaro" },
    { value: "3", label: "GERRY CRISTIAN MARCELO" },
    { value: "4", label: "Gustavo Javier Benitez" },
    { value: "5", label: "Monzon, Carlos Agustín" }
  ],
  centrosCosto: [
    { value: "MECANICA", label: "MECÁNICA" },
    { value: "ELECTRICIDAD", label: "ELECTRICIDAD" },
    { value: "HERRERIA", label: "HERRERÍA" },
    { value: "NEUMATICOS", label: "NEUMÁTICOS" }
  ]
};

// Initialize Catalogs if they are empty
function initMockCatalogs() {
  const current = db.getCatalogs();
  if (!current.rodados || current.rodados.length === 0) {
    console.log("Pre-populating local database with catalogs...");
    try {
      const fs = require('fs');
      const path = require('path');
      const prodPath = path.join(__dirname, 'prod_catalogs.json');
      if (fs.existsSync(prodPath)) {
        const prodData = JSON.parse(fs.readFileSync(prodPath, 'utf8'));
        if (prodData.rodados && prodData.rodados.length > 0) {
          console.log(`Loaded ${prodData.rodados.length} rodados from prod_catalogs.json`);
          db.saveCatalogs(prodData);
          return;
        }
      }
    } catch (e) {
      console.warn("Failed to load prod_catalogs.json, using fallback MOCK_CATALOGS:", e.message);
    }
  }
}

// Background Worker state
let isWorkerRunning = false;
const candadoInternosActivos = new Set(); // Evita ejecuciones paralelas para el mismo camión
let isScraping = false;
let scrapeCatalogsAbandoned = false;

// Global lock so only ONE Puppeteer browser runs at a time across the whole app.
// Running two Chromium instances at once on a resource-limited server (like a
// small Railway container) can cause one of them to crash/close mid-operation
// ("Target closed" / "detached Frame" errors), so every entry point that launches
// a browser must acquire this lock first and release it when done.
let browserBusy = false;
const abandonedSyncOrderIds = new Set();
async function acquireBrowserLock(context) {
  let waited = false;
  let waitedMs = 0;
  const MAX_WAIT_MS = 5.5 * 60 * 1000; // safety valve: never wait more than 5.5 minutes
  while (browserBusy) {
    if (!waited) { console.log(`[Lock] Browser is busy, ${context} is waiting for it to free up...`); waited = true; }
    if (waitedMs >= MAX_WAIT_MS) {
      console.warn(`[Lock] ${context} waited over 5.5 minutes for the browser lock — forcing it free (possible stuck process).`);
      break;
    }
    await delay(3000);
    waitedMs += 3000;
  }
  if (waited) console.log(`[Lock] Browser is free, ${context} proceeding.`);
  browserBusy = true;
}
function releaseBrowserLock() {
  browserBusy = false;
}

const { exec } = require('child_process');

function cleanupZombieBrowsers() {
  return new Promise((resolve) => {
    // Avoid aggressive pkill that kills active puppeteer sessions
    return resolve();
  });
}

const delay = ms => new Promise(res => setTimeout(res, ms));

// Helper to evaluate JS safely with automatic retries on detached Frame
async function evaluateWithRetry(page, fn, ...args) {
  let lastError = null;
  for (let i = 0; i < 3; i++) {
    try {
      if (!page || page.isClosed()) throw new Error("Target page is closed");
      return await page.evaluate(fn, ...args);
    } catch (err) {
      lastError = err;
      if (err.message.includes('detached Frame') || err.message.includes('Execution context was destroyed') || err.message.includes('frame was detached')) {
        console.warn(`[Puppeteer] Frame detached during evaluate (attempt ${i + 1}/3), waiting for frame to settle...`);
        await delay(2000);
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}


async function killZombieChromes() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('taskkill /F /IM chrome.exe /T', () => resolve());
    } else {
      exec('pkill -9 -f chrome || pkill -9 -f chromium || true', () => resolve());
    }
  });
}

// Kills only chrome/chromium processes that have been running longer than minAgeSeconds.
// A legitimate session is always younger than that (bounded by the sync/verify timeouts, both
// well under 6 minutes), so this can never touch an actively-in-progress browser — but it does
// clean up true zombies (orphaned renderer/zygote processes left behind when browser.close()
// doesn't fully tear down the process tree) before they pile up and exhaust the container's
// process table (see "fork: retry: Resource temporarily unavailable", 2026-08-03).
async function killAgedZombieChromes(minAgeSeconds = 360) {
  if (process.platform === 'win32') return; // dev machines: not worth the ps parsing
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec("ps -eo pid,etimes,comm | grep -Ei 'chrome|chromium' | grep -v grep", (err, stdout) => {
      if (err || !stdout) return resolve();
      const oldPids = [];
      for (const line of stdout.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[0];
        const etimes = parseInt(parts[1], 10);
        if (pid && !isNaN(etimes) && etimes >= minAgeSeconds) oldPids.push(pid);
      }
      if (oldPids.length === 0) return resolve();
      console.log(`[ZombieCleanup] Killing ${oldPids.length} chrome process(es) older than ${minAgeSeconds}s: ${oldPids.join(',')}`);
      exec(`kill -9 ${oldPids.join(' ')}`, () => resolve());
    });
  });
}

async function launchBrowser() {
  // Clean up only long-lived zombie chrome processes before launching — see
  // killAgedZombieChromes() above for why this is safe even under the browserBusy lock's
  // 5.5-minute forced-through edge case, unlike the unconditional pkill this replaced. The
  // global browserBusy lock (acquireBrowserLock/releaseBrowserLock) is supposed to guarantee
  // only one browser runs at a time, but a stuck/hung previous session can force its
  // way past the lock's 5.5-minute safety valve while its own browser is still technically
  // alive — in that narrow window, an unconditional pkill here kills a still-legitimately-open
  // session belonging to another order, producing exactly the cascading "detached Frame" /
  // "Password input not found" failures seen across multiple orders in quick succession
  // (2026-08-03). Zombie cleanup still happens where it's unambiguously safe: after a launch
  // failure (below), in the timeout-safety abandonment paths, and here via the age-gated
  // killAgedZombieChromes() (otherwise truly orphaned processes pile up and exhaust the
  // container's process table — "fork: retry: Resource temporarily unavailable").
  await killAgedZombieChromes().catch(() => {});

  let execPath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  const fs = require('fs');

  if (!execPath) {
    if (process.platform === 'win32') {
      const stdPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      const x86Path = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
      if (fs.existsSync(stdPath)) {
        execPath = stdPath;
      } else if (fs.existsSync(x86Path)) {
        execPath = x86Path;
      }
    } else {
      const linuxPaths = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome'
      ];
      for (const p of linuxPaths) {
        if (fs.existsSync(p)) {
          execPath = p;
          break;
        }
      }
    }
  }

  console.log(`[Puppeteer] Launching browser executable: ${execPath || 'bundled default'}`);

  // En Linux (Railway Cloud / Docker), SIEMPRE usar headless: 'new' para prevenir crashes por falta de X11
  let isHeadless = 'new';
  if (process.platform === 'win32') {
    isHeadless = process.env.PUPPETEER_HEADLESS === 'true' ? 'new' : false;
  } else {
    isHeadless = process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new';
  }

  const launchOptions = {
    executablePath: execPath || undefined,
    headless: isHeadless,
    slowMo: 50,
    protocolTimeout: 180000,
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1280,800',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-extensions'
    ]
  };

  try {
    return await puppeteer.launch(launchOptions);
  } catch (err) {
    console.warn(`[Puppeteer] First launch attempt failed: ${err.message}. Retrying with zombie cleanup...`);
    await killZombieChromes().catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    launchOptions.args.push('--single-process');
    return await puppeteer.launch(launchOptions);
  }
}

async function setupPage(page) {
  global.paginaActivaParaStream = page;

  // Anti-bot detection avoidance
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-AR,es;q=0.9' });
  await page.emulateTimezone('America/Argentina/Buenos_Aires');
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.setViewport({ width: 1280, height: 800 });

  // Avoid using setRequestInterception(true) as it is known to cause race conditions
  // and 'detached Frame' errors when handling rapid redirections in Puppeteer.
}

// Helper to navigate safely using 'load' instead of 'networkidle2' and catch timeout errors
async function safeGoto(page, url, options = {}) {
  const defaultOptions = { waitUntil: 'load', timeout: 30000 };
  const mergedOptions = { ...defaultOptions, ...options };
  try {
    console.log(`[safeGoto] Navigating to ${url} ...`);
    return await page.goto(url, mergedOptions);
  } catch (err) {
    if (err.message.includes('Timeout') || err.message.includes('timeout')) {
      console.warn(`[safeGoto] Navigation timeout hit for ${url}. Attempting to continue...`);
      return null;
    }
    if (err.message.includes('Session closed') || err.message.includes('Target closed') || err.message.includes('Protocol error')) {
      console.warn(`[safeGoto] Session/page closed during navigation to ${url}: ${err.message}`);
      throw new Error('La conexión o sesión de navegación en Taxes fue interrumpida. Reintentando...');
    }
    throw err;
  }
}

// Helper to guarantee navigation to the Órdenes de Trabajo page from home/inicio
async function ensureOnOtPage(page, portalUrl) {
  const targetUrl = `${portalUrl}/tms/produccion/ot`;
  console.log(`[Navigation] Asegurando navegación a ${targetUrl}...`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const currentUrl = page.url().toLowerCase();
    if (currentUrl.includes('/tms/produccion/ot')) {
      console.log(`[Navigation] Confirmada vista /tms/produccion/ot.`);
      return true;
    }

    console.log(`[Navigation] Intento ${attempt}: Navegando desde inicio (${currentUrl}) a /tms/produccion/ot...`);
    await safeGoto(page, targetUrl, { timeout: 30000 }).catch(() => {});
    await delay(1500);

    const updatedUrl = page.url().toLowerCase();
    if (!updatedUrl.includes('/tms/produccion/ot')) {
      console.log(`[Navigation] Forzando navegación vía menú / script a /tms/produccion/ot...`);
      await safeEvaluate(page, (target) => {
        const links = Array.from(document.querySelectorAll('a, button, div, span'));
        const otLink = links.find(l => {
          const txt = (l.textContent || '').trim().toLowerCase();
          return txt.includes('órdenes de trabajo') || txt.includes('ordenes de trabajo') || txt.includes('ordenes') || txt.includes('producción');
        });
        if (otLink) {
          otLink.click();
        } else {
          window.location.href = target;
        }
      }, targetUrl);
      await delay(2000);
    }
  }

  return page.url().toLowerCase().includes('/tms/produccion/ot');
}

// Helper: Semantic text click in Puppeteer
async function clickByText(page, text, elementType = '*') {
  const elements = await page.$$(elementType);
  for (const element of elements) {
    const content = await safeEvaluate(page, el => el.textContent, element);
    if (content && content.toLowerCase().includes(text.toLowerCase())) {
      const isVisible = await safeEvaluate(page, el => {
        const style = window.getComputedStyle(el);
        return style && style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0;
      }, element);
      if (isVisible) {
        await safeEvaluate(page, el => el.click(), element);
        return true;
      }
    }
  }
  return false;
}

// Puppeteer helper to enter text into inputs near labels
async function fillInputByLabel(page, labelText, value) {
  const inputs = await page.$$('input, textarea, select');
  for (const input of inputs) {
    const id = await safeEvaluate(page, el => el.id, input);
    const name = await safeEvaluate(page, el => el.getAttribute('name'), input);
    const placeholder = await safeEvaluate(page, el => el.getAttribute('placeholder'), input);
    
    // Check if ID matches any labels
    if (id) {
      const label = await page.$(`label[for="${id}"]`);
      if (label) {
        const text = await safeEvaluate(page, el => el.textContent, label);
        if (text && text.toLowerCase().includes(labelText.toLowerCase())) {
          await input.focus();
          await safeEvaluate(page, el => el.value = '', input); // Clear
          await input.type(value);
          return true;
        }
      }
    }
    
    // fallback check placeholder or name
    if ((placeholder && placeholder.toLowerCase().includes(labelText.toLowerCase())) || 
        (name && name.toLowerCase().includes(labelText.toLowerCase()))) {
      await input.focus();
      await safeEvaluate(page, el => el.value = '', input); // Clear
      await input.type(value);
      return true;
    }
  }
  return false;
}

// Puppeteer helper to fill custom searchable selects
async function fillSearchableSelect(page, labelText, searchValue) {


  console.log(`Searching for searchable select for: "${labelText}" with target value: "${searchValue}"`);
  try {
    // Find the correct searchable-input by looking at the label
    const inputInfo = await safeEvaluate(page, (label) => {
      const clean = (str) => {
        if (!str) return '';
        return str.normalize("NFD")
                  .replace(/[\u0300-\u036f]/g, "")
                  .toLowerCase()
                  .replace(/[^a-z0-9]/g, "");
      };
      
      const cleanTarget = clean(label);
      const allLabels = Array.from(document.querySelectorAll('label'));
      for (const lbl of allLabels) {
        const cleanLabelText = clean(lbl.textContent);
        if (cleanLabelText.includes(cleanTarget) || cleanTarget.includes(cleanLabelText)) {
          // Find the parent container
          const parent = lbl.closest('.form-group') || 
                         lbl.closest('.taxes-form-group') || 
                         lbl.closest('.col') || 
                         lbl.closest('.row') ||
                         lbl.parentElement;
          if (parent) {
            // Look for the searchable-input inside this container
            const searchInput = parent.querySelector('.searchable-input, input[type="text"]');
            // Look for any hidden input in the same container
            const hiddenInput = parent.querySelector('input[type="hidden"], input[name$="_id"], input[name="rodado_id"], input[name="syj_empleado_id"]');
            
            if (searchInput) {
              const searchId = 'tmp_search_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
              searchInput.setAttribute('id', searchId);
              let hiddenId = null;
              if (hiddenInput) {
                hiddenId = 'tmp_hidden_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
                hiddenInput.setAttribute('id', hiddenId);
              }
              return { searchId, hiddenId, found: true };
            }
          }
        }
      }
      return { found: false };
    }, labelText);

    if (!inputInfo.found) {
      console.log(`Could not find searchable select input for: "${labelText}"`);
      return false;
    }

    const searchSelector = `#${inputInfo.searchId}`;
    const hiddenSelector = `#${inputInfo.hiddenId}`;

    // Generate list of queries to try in sequence
    const queriesToTry = [];
    let rodadoInfo = null;

    if (labelText.toLowerCase().includes('rodado')) {
      try {
        const catalogs = db.getCatalogs();
        const rodados = catalogs.rodados || [];
        const internoMatch = searchValue.match(/Interno\s+(\S+)/i);
        const searchInterno = internoMatch ? internoMatch[1].toLowerCase().trim() : '';
        const matching = rodados.find(r => 
          r.label === searchValue || 
          r.value === searchValue || 
          (r.interno && searchInterno && r.interno.toLowerCase().trim() === searchInterno)
        );
        if (matching) {
          rodadoInfo = {
            patente: matching.patente || '',
            interno: matching.interno || '',
            modelo: matching.modelo || ''
          };
          // Interno first: it's the most precise/unique identifier and always confirmed to
          // work in Taxes' own search. Patente goes after it (some equipment - compactadores,
          // equipos municipales - has no real patente or a stale/wrong catalog value, and
          // trying that first can derail the whole match before we ever get to the interno).
          if (rodadoInfo.interno) {
            queriesToTry.push(rodadoInfo.interno.trim());
            queriesToTry.push(`Interno ${rodadoInfo.interno.trim()}`);
          }
          if (rodadoInfo.patente) {
            queriesToTry.push(rodadoInfo.patente.trim());
          }
          if (rodadoInfo.modelo) {
            queriesToTry.push(rodadoInfo.modelo.trim());
          }
        }
      } catch (catErr) {
        console.error("Error retrieving matching rodado from local catalogs:", catErr);
      }
    }

    if (labelText.toLowerCase().includes('responsable')) {
      const targetLower = searchValue.toLowerCase();
      if (targetLower.includes('belocures') || targetLower.includes('cesar')) {
        queriesToTry.push('Belocures,');
        queriesToTry.push('Belocures');
        queriesToTry.push('Belocures, Cesar');
        queriesToTry.push(searchValue);
      }
    }

    if (queriesToTry.length === 0) {
      // If it contains "Interno X", we try to search by the interno number FIRST as it is highly precise!
      const internoMatch = searchValue.match(/Interno\s+(\d+)/i);
      if (internoMatch) {
        queriesToTry.push(internoMatch[1]); // Try "4" first
        queriesToTry.push(`Interno ${internoMatch[1]}`); // Try "Interno 4" second
      }

      // Add query with commas/punctuation stripped
      const cleanValue = searchValue.replace(/[,._\-]/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleanValue) {
        queriesToTry.push(cleanValue);
      }
      if (searchValue !== cleanValue) {
        queriesToTry.push(searchValue);
      }

      if (searchValue.includes(' - ')) {
        const parts = searchValue.split(' - ');
        const brand = parts[0].trim();
        const rest = parts[1].split('.')[0].trim(); // e.g. "F100" or "SAVEIRO 1.6L"
        queriesToTry.push(`${brand} ${rest}`);
        queriesToTry.push(rest);
        queriesToTry.push(brand);
      }

      // Extract individual words stripped of punctuation
      const cleanWords = cleanValue.split(/\s+/).filter(w => w.length >= 3);
      if (cleanWords.length > 0) {
        queriesToTry.push(cleanWords[0]); // e.g. "Belocures"
        if (cleanWords[1]) {
          queriesToTry.push(cleanWords[1]); // e.g. "Cesar"
        }
      }
    }

    // Try queries one by one
    for (const query of queriesToTry) {
      console.log(`Attempting search query for "${labelText}": "${query}"...`);
      
      // Check if dropdown is visible, if not click it to open
      const isDropdownOpen = await safeEvaluate(page, () => {
        const dropdownContainers = Array.from(document.querySelectorAll('[id^="searchable-select-dropdown-"]'));
        return dropdownContainers.some(container => container.offsetHeight > 0);
      });

      if (!isDropdownOpen) {
        console.log(`   Dropdown was closed, clicking input to open...`);
        await page.click(searchSelector);
        await delay(500);
      }

      // Focus and clear existing text reliably via evaluate and keyboard
      await safeEvaluate(page, (sel) => {
        const el = document.querySelector(sel);
        if (el) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, searchSelector);
      await page.focus(searchSelector);
      await delay(300);

      // Type the query
      await page.type(searchSelector, query, { delay: 50 });
      await delay(2000); // Wait for dropdown to appear and filter

      // Click the first visible option in the dropdown that matches
      const optionClicked = await safeEvaluate(page, (targetVal, rodadoInfo, fieldLabel) => {
        // Find visible options inside portal dropdown containers (ID starts with "searchable-select-dropdown-")
        const dropdownContainers = Array.from(document.querySelectorAll('[id^="searchable-select-dropdown-"]'));
        
        let visibleOptions = [];
        dropdownContainers.forEach(container => {
          const isVisible = container.offsetHeight > 0;
          if (isVisible) {
            // Find leaf divs that contain text and do not have child divs
            const divs = Array.from(container.querySelectorAll('div'));
            const leafDivs = divs.filter(d => d.querySelectorAll('div').length === 0 && d.textContent.trim().length > 0);
            visibleOptions.push(...leafDivs);
          }
        });

        // Normalize helper to ignore accents, punctuation, and spaces
        const clean = (str) => {
          if (!str) return '';
          return str.normalize("NFD")
                    .replace(/[\u0300-\u036f]/g, "")
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, "");
        };

        const targetClean = clean(targetVal);

        // Filter out header/status rows containing "opciones" or "cargando"
        const filteredOptions = visibleOptions.filter(el => {
          const text = el.textContent.trim().toLowerCase();
          return text.length > 0 && !text.includes('opciones') && !text.includes('cargando') && !text.includes('no hay');
        });

        if (filteredOptions.length === 0) return { success: false };

        let matched = null;

        // Regla específica para Responsable (ej. Belocures, Cesar / Belocures, --- al final de la lista)
        if (fieldLabel && fieldLabel.toLowerCase().includes('responsable')) {
          const targetLower = targetVal.toLowerCase();
          if (targetLower.includes('belocures') || targetLower.includes('cesar')) {
            // 1) Contiene tanto belocures como cesar
            matched = filteredOptions.find(el => {
              const txt = el.textContent.toLowerCase();
              return txt.includes('belocures') && txt.includes('cesar');
            });
            // 2) Contiene belocures y "---" (ej: "Belocures, ---")
            if (!matched) {
              matched = filteredOptions.find(el => {
                const txt = el.textContent.toLowerCase();
                return txt.includes('belocures') && txt.includes('---');
              });
            }
            // 3) Elegir la ÚLTIMA opción que coincida con Belocures en la lista desplegable
            if (!matched) {
              const belocuresOpts = filteredOptions.filter(el => el.textContent.toLowerCase().includes('belocures'));
              if (belocuresOpts.length > 0) {
                matched = belocuresOpts[belocuresOpts.length - 1];
              }
            }
          }
        }

        // A. Match by patent (highest priority for vehicles)
        if (!matched && rodadoInfo && rodadoInfo.patente) {
          const cleanPatent = clean(rodadoInfo.patente);
          if (cleanPatent) {
            matched = filteredOptions.find(el => clean(el.textContent).includes(cleanPatent));
          }
        }

        // B. Match by interno (extract and compare exact internal number)
        if (!matched && rodadoInfo && rodadoInfo.interno) {
          const cleanInterno = clean(rodadoInfo.interno);
          if (cleanInterno) {
            matched = filteredOptions.find(el => {
              const text = el.textContent.toLowerCase();
              const match = text.match(/interno\s+(\S+)/);
              if (match) {
                return clean(match[1]) === cleanInterno;
              }
              // Fallback to substring only if "interno" word is not present in the option text
              if (!text.includes('interno')) {
                return clean(text).includes(cleanInterno);
              }
              return false;
            });
          }
        }

        // C. Try exact or full match containing targetVal
        if (!matched) {
          matched = filteredOptions.find(el => {
            const textClean = clean(el.textContent);
            return textClean.includes(targetClean) || targetClean.includes(textClean);
          });
        }

        // D. Try partial match: if targetVal contains brand and interno, check both
        if (!matched && targetVal.includes(' - ')) {
          const parts = targetVal.split(' - ');
          const brand = clean(parts[0]);
          const numMatch = targetVal.match(/Interno\s+(\d+)/i);
          const internoNum = numMatch ? numMatch[1] : '';

          matched = filteredOptions.find(el => {
            const textClean = clean(el.textContent);
            const hasBrand = textClean.includes(brand);
            const hasInterno = internoNum ? textClean.includes(internoNum) : true;
            return hasBrand && hasInterno;
          });
        }

        // E. Fallback: click the very first visible option in the dropdown
        if (!matched && filteredOptions.length > 0) {
          matched = filteredOptions[0];
        }

        if (matched) {
          ['mousedown', 'mouseup', 'click'].forEach(evtName => {
            try {
              const evt = new MouseEvent(evtName, { bubbles: true, cancelable: true, view: window });
              matched.dispatchEvent(evt);
            } catch (_) {}
          });
          return { success: true, text: matched.textContent.trim() };
        }

        return { success: false };
      }, searchValue, rodadoInfo, labelText);

      if (optionClicked.success) {
        console.log(`   ✓ Selected option for "${labelText}": "${optionClicked.text}"`);
        
        // Wait for Vue reactivity to update inputs
        await delay(1000);
        
        // Verify either hidden input or search input got a value
        const checkResult = await safeEvaluate(page, (hSel, sSel) => {
          const hEl = document.querySelector(hSel);
          const sEl = document.querySelector(sSel);
          return {
            hiddenVal: hEl ? hEl.value : '',
            searchVal: sEl ? sEl.value : ''
          };
        }, hiddenSelector, searchSelector);

        console.log(`   ✓ Hidden input value: "${checkResult.hiddenVal}" | Search input value: "${checkResult.searchVal}"`);
        
        if (checkResult.hiddenVal !== '' || checkResult.searchVal !== '') {
          return true;
        }
      }
    }

    console.log(`Failed to select option for "${labelText}" after all search query attempts.`);
    return false;
  } catch (error) {
    console.error(`Error filling searchable select for "${labelText}":`, error);
    return false;
  }
}

// Puppeteer helper to fill custom searchable selects inside task cards
async function fillTaskEmployeeSearchableSelect(page, index, employeeName) {
  console.log(`Filling Employee for Task #${index} with: "${employeeName}"`);
  try {
    // Resolve employee details from catalog for fallback
    const employeeCatalog = db.getCatalogs().empleados || [];
    const employeeObj = employeeCatalog.find(e => {
      const clean = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return clean(e.label).includes(clean(employeeName)) || clean(employeeName).includes(clean(e.label));
    });

    // Try queries one by one via dropdown UI
    const queriesToTry = [employeeName];
    if (employeeName.includes(' ')) {
      const words = employeeName.split(/\s+/).filter(w => w.length > 2);
      queriesToTry.push(...words.map(w => w.replace(/[^a-zA-Z0-9]/g, '')));
    }

    for (const query of queriesToTry) {
      console.log(`Attempting employee search query: "${query}"...`);
      
      // Focus the input inside the correct card container using page.evaluate
      const focused = await safeEvaluate(page, (idx) => {
        const horasInputs = Array.from(document.querySelectorAll('input[id^="horas_"], input[name="horas_estimadas"]'));
        const targetHoursInput = horasInputs[idx];
        if (!targetHoursInput) return false;

        let card = targetHoursInput.parentElement;
        while (card && card !== document.body && 
               !card.classList.contains('card') && 
               !card.classList.contains('form-row') && 
               !card.classList.contains('row') &&
               !card.className.includes('col-12')) {
          card = card.parentElement;
        }
        if (!card) return false;

        const wrapper = card.querySelector('.searchable-select-wrapper, .multiselect');
        if (!wrapper) return false;

        const searchInput = wrapper.querySelector('.searchable-input, input[type="text"]');
        if (searchInput) {
          searchInput.focus();
          searchInput.click();
          return true;
        }
        return false;
      }, index);

      if (!focused) {
        console.log(`Could not focus searchable employee input for task index: ${index}`);
        continue;
      }

      await delay(500);

      // Clear the active focused input
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await delay(300);

      // Type the query
      await page.keyboard.type(query, { delay: 30 });
      await delay(600); // Wait for dropdown to filter

      // Select option
      const optionClicked = await safeEvaluate(page, (targetVal) => {
        const dropdownContainers = Array.from(document.querySelectorAll('[id^="searchable-select-dropdown-"]'));
        let visibleOptions = [];
        dropdownContainers.forEach(container => {
          if (container.offsetHeight > 0) {
            const divs = Array.from(container.querySelectorAll('div'));
            const leafDivs = divs.filter(d => d.querySelectorAll('div').length === 0 && d.textContent.trim().length > 0);
            leafDivs.forEach(d => {
              visibleOptions.push({
                element: d,
                text: d.textContent.trim()
              });
            });
          }
        });

        const filtered = visibleOptions.filter(opt => {
          const text = opt.text.toLowerCase();
          return text.length > 0 && !text.includes('opciones') && !text.includes('cargando') && !text.includes('no hay') && !text.includes('no se encontraron');
        });

        if (filtered.length === 0) return null;

        const cleanStr = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const targetClean = cleanStr(targetVal);

        let matched = filtered.find(opt => {
          const optClean = cleanStr(opt.text);
          return optClean.includes(targetClean) || targetClean.includes(optClean);
        });

        if (!matched && filtered.length > 0) {
          matched = filtered[0]; // Fallback to first
        }

        if (matched && matched.element) {
          const tempId = 'tmp-opt-' + Date.now();
          matched.element.id = tempId;
          return { tempId, text: matched.text };
        }
        return null;
      }, employeeName);

      if (optionClicked && optionClicked.tempId) {
        try {
          await page.click(`#${optionClicked.tempId}`);
          console.log(`   ✓ Selected employee option: "${optionClicked.text}"`);
          await delay(1000);
          return true;
        } catch (e) {
          console.warn(`Clicking option raised error: ${e.message}, trying fallback...`);
        }
      }
    }

    // =====================================================================
    // FALLBACK: Direct injection when dropdown selection fails
    // =====================================================================
    if (employeeObj) {
      console.log(`Dropdown selection failed. Attempting DIRECT INJECTION fallback for ID=${employeeObj.value}, Label="${employeeObj.label}"...`);
      const injected = await safeEvaluate(page, (idx, empId, empLabel) => {
        const horasInputs = Array.from(document.querySelectorAll('input[id^="horas_"], input[name="horas_estimadas"]'));
        const targetHoursInput = horasInputs[idx];
        if (!targetHoursInput) return false;

        let card = targetHoursInput.parentElement;
        while (card && card !== document.body && 
               !card.classList.contains('card') && 
               !card.classList.contains('form-row') && 
               !card.classList.contains('row') &&
               !card.className.includes('col-12')) {
          card = card.parentElement;
        }
        if (!card) return false;

        const wrapper = card.querySelector('.searchable-select-wrapper, .multiselect');
        if (!wrapper) return false;

        const hiddenInput = wrapper.querySelector('input[type="hidden"]') || wrapper.querySelector('input[name*="empleado_id"]');
        const searchInput = wrapper.querySelector('.searchable-input, input[type="text"]');

        if (!hiddenInput) return false;

        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(hiddenInput, empId);
        hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
        hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));

        if (searchInput) {
          nativeSetter.call(searchInput, empLabel);
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          searchInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (wrapper && wrapper.__vue__) {
          try {
            wrapper.__vue__.$emit('input', empId);
            wrapper.__vue__.$emit('change', empId);
          } catch(e) {}
        }
        return true;
      }, index, employeeObj.value, employeeObj.label);

      return injected;
    }

    return false;
  } catch (error) {
    console.error(`Error filling task employee searchable select: ${error}`);
    return false;
  }
}



// Safe page.evaluate that retries on context/frame destruction due to rapid redirects
async function safeEvaluate(page, fn, ...args) {
  for (let i = 0; i < 3; i++) {
    try {
      return await page.evaluate(fn, ...args);
    } catch (err) {
      const msg = err.message || '';
      // Also retry a hung CDP call (ProtocolError: Runtime.callFunctionOn timed out) -
      // this can happen transiently under load (e.g. a burst of many queued syncs) and
      // otherwise fails the whole step immediately with no retry at all.
      if (msg.includes('Execution context was destroyed') || msg.includes('detached Frame') || msg.includes('Target closed') || msg.includes('timed out')) {
        console.warn(`[safeEvaluate] Context/Frame/timeout error, waiting 1s before retry ${i + 1}/3...`);
        await delay(1000);
      } else {
        throw err;
      }
    }
  }
  throw new Error("Page evaluation failed due to persistent context/frame destruction or timeout.");
}

// Automate login to Taxes.com.ar
// Taxes.com.ar started showing a "Nos estamos modernizando" WhatsApp promo modal on top of
// the page (2026-08). Left up, it blocks interaction with whatever is underneath — including
// the login form — which is what caused the sudden wave of "Password input not found" /
// login failures across many orders at once. Dismiss it via "Ahora no" or its close (X)
// button whenever present; a harmless no-op otherwise.
async function dismissWhatsappPromoModal(page) {
  try {
    return await safeEvaluate(page, () => {
      const isVisible = (el) => !!(el && el.offsetParent !== null);
      const all = Array.from(document.querySelectorAll('button, a, span, div'));
      const dismissBtn = all.find(el => isVisible(el) && (el.textContent || '').trim().toLowerCase() === 'ahora no');
      if (dismissBtn) { dismissBtn.click(); return true; }
      const modals = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"]'));
      for (const modal of modals) {
        if (!isVisible(modal)) continue;
        const text = (modal.textContent || '').toLowerCase();
        if (text.includes('whatsapp') || text.includes('modernizando')) {
          const closeBtn = modal.querySelector('button, [class*="close"], .fa-times, .material-icons');
          if (closeBtn) { closeBtn.click(); return true; }
        }
      }
      return false;
    });
  } catch (e) {
    return false;
  }
}

async function autoLogin(browser, username, password, portalUrl) {
  // Always create a FRESH page to avoid detached frame issues
  console.log(`[autoLogin] Creating fresh page and navigating to ${portalUrl}/login ...`);

  // Diagnostic only (never logs the actual password value): helps catch invisible
  // issues like stray whitespace, newlines, or non-standard characters that can
  // sneak in from copy/paste or mobile keyboards without being visible on screen.
  const describeStr = (label, s) => {
    if (s === undefined || s === null) { console.log(`[autoLogin-Diag] ${label}: MISSING (undefined/null)`); return; }
    const hasLeadingOrTrailingSpace = s !== s.trim();
    const hasNonAscii = /[^\x20-\x7E]/.test(s);
    console.log(`[autoLogin-Diag] ${label}: length=${s.length}, trimmedLength=${s.trim().length}, hasLeadingOrTrailingSpace=${hasLeadingOrTrailingSpace}, hasNonAsciiChars=${hasNonAscii}`);
  };
  describeStr('username', username);
  describeStr('password', password);
  
  let page = await browser.newPage();
  await setupPage(page);

  // Capture the page's own console/JS errors — a click that silently does
  // nothing (no navigation, no visible error) is often caused by a client-side
  // JS error we can't see in a screenshot or HTML snapshot.
  page.on('console', msg => console.log(`[Taxes-Console-${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => console.log(`[Taxes-PageError] ${err.message}`));
  page.on('response', res => {
    if (res.url().includes('/login') && res.request().method() === 'POST') {
      console.log(`[Taxes-LoginRequest] POST ${res.url()} -> status ${res.status()}`);
    }
  });

  // Use domcontentloaded (not networkidle2) to tolerate internal redirects from Taxes
  try {
    await page.goto(`${portalUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch (e) {
    console.log('[autoLogin] goto /login threw error, creating another fresh page:', e.message);
    // If frame was detached during goto, create yet another fresh page and try again
    try { await page.close(); } catch (_) {}
    page = await browser.newPage();
    await setupPage(page);
    try {
      await page.goto(`${portalUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (e2) {
      console.log('[autoLogin] Second goto also failed (ok):', e2.message);
    }
  }

  await delay(2000); // Give Vue.js time to hydrate the DOM
  await dismissWhatsappPromoModal(page);

  // Check if we landed on /login or got redirected to /admin (already logged in)
  const urlAfterLoad = page.url().toLowerCase();
  if (!urlAfterLoad.includes('/login')) {
    console.log(`[autoLogin] Already logged in, URL is: ${urlAfterLoad}`);
    return page;
  }

  console.log(`[autoLogin] Not logged in. Attempting login as ${username}...`);

  // Target selectors for email and password on Taxes.com.ar login page
  const emailSelector = 'input[name="loginUser"], input[name="email"], input[name="username"], input[type="text"], input[type="email"]';
  const passSelector = 'input[name="password"], input[type="password"]';

  // Poll for password input using evaluate (avoids detached frame from waitForSelector)
  console.log('[autoLogin] Waiting for password input via polling...');
  await delay(5000); // Wait longer for Vue.js + any redirects to settle
  await dismissWhatsappPromoModal(page);
  const inputReady = await (async () => {
    for (let i = 0; i < 40; i++) { // 40 × 500ms = 20 seconds max
      try {
        if (i % 6 === 0) await dismissWhatsappPromoModal(page);
        const found = await safeEvaluate(page, (sel) => !!document.querySelector(sel), passSelector);
        if (found) { console.log(`[autoLogin] Password input found after ${i * 500 + 5000}ms`); return true; }
      } catch (e) {
        if (i % 4 === 0) console.log(`[autoLogin] Polling attempt ${i}: ${e.message.substring(0, 80)}`);
      }
      await delay(500);
    }
    // If still not found, try navigating again to /login
    console.log('[autoLogin] Input not found after 25s - retrying goto /login...');
    try { await page.goto(`${portalUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (_) {}
    await delay(3000);
    await dismissWhatsappPromoModal(page);
    try {
      const found = await safeEvaluate(page, (sel) => !!document.querySelector(sel), passSelector);
      if (found) { console.log('[autoLogin] Password input found after retry goto'); return true; }
    } catch (e) { console.log('[autoLogin] Retry evaluate failed:', e.message.substring(0, 80)); }
    return false;
  })();

  if (!inputReady) {
    const currentPageUrl = page.url();
    throw new Error(`[autoLogin] Password input not found. Current URL: ${currentPageUrl}`);
  }

  // Use real keyboard simulation (page.type) so Vue.js v-model detects the input.
  // Direct .value assignment via evaluate() is NOT detected by Vue's reactivity system.
  console.log('[autoLogin] Filling form with real keyboard simulation...');

  // Clear and type email
  await safeEvaluate(page, (sel) => { const el = document.querySelector(sel); if (el) { el.value = ''; el.focus(); } }, emailSelector);
  await page.click(emailSelector, { clickCount: 3 }); // select all
  await page.type(emailSelector, username, { delay: 30 });

  // Clear and type password
  await safeEvaluate(page, (sel) => { const el = document.querySelector(sel); if (el) { el.value = ''; el.focus(); } }, passSelector);
  await page.click(passSelector, { clickCount: 3 }); // select all
  await page.type(passSelector, password, { delay: 30 });

  await delay(300);

  // Extract and inject CSRF token (Taxes.com.ar is Laravel-based and requires _token)
  const csrfToken = await safeEvaluate(page, () => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : null;
  });
  if (csrfToken) {
    console.log(`[autoLogin] CSRF token found (length=${csrfToken.length}), injecting into form...`);
    await safeEvaluate(page, (token) => {
      const form = document.querySelector('form.login-form') || document.querySelector('form');
      if (!form) return;
      let tokenInput = form.querySelector('input[name="_token"]');
      if (!tokenInput) {
        tokenInput = document.createElement('input');
        tokenInput.type = 'hidden';
        tokenInput.name = '_token';
        form.appendChild(tokenInput);
      }
      tokenInput.value = token;
    }, csrfToken);
  } else {
    console.log('[autoLogin] No CSRF meta tag found - proceeding without explicit token.');
  }

  // Submit by clicking the submit button ONCE (avoid double-POST 419 error)
  console.log('[autoLogin] Submitting form with single button click...');
  await safeEvaluate(page, () => {
    const btn = document.querySelector('button[type="submit"], input[type="submit"], .btn-primary, form button, .btn');
    if (btn) {
      btn.click();
    } else {
      const form = document.querySelector('form.login-form') || document.querySelector('form');
      if (form) form.submit();
    }
  });
  await delay(1500);





  // Poll URL until we leave /login (up to 35 seconds) - avoids waitForNavigation frame issues
  console.log('Waiting for Taxes authentication redirect...');
  let redirected = false;
  for (let i = 0; i < 70; i++) {
    await delay(500);
    try {
      const url = page.url().toLowerCase();
      if (!url.includes('/login')) { redirected = true; break; }
    } catch (e) { /* page still navigating */ }
  }
  await delay(2000); // Give dashboard time to settle

  // Robust check: if the URL no longer contains "/login", the login was successful!
  const currentUrl = page.url().toLowerCase();
  console.log(`Current URL after login check: ${currentUrl}`);
  
  if (currentUrl.includes('/login')) {
    // We are still on the login page or got a 429 rate limit error, so it failed. Let's find out why:
    let errorMsg = "Credenciales incorrectas o error de inicio de sesión en Taxes.com.ar";
    try {
      const pageInfo = await safeEvaluate(page, () => {
        const bodyText = document.body ? document.body.textContent.toLowerCase() : '';
        const titleText = document.title ? document.title.toLowerCase() : '';
        return {
          isRateLimited: bodyText.includes('too many requests') || titleText.includes('too many requests') || bodyText.includes('429'),
          isInvalidCreds: bodyText.includes('credenciales inv') ||
                 bodyText.includes('credenciales incorrecta') ||
                 bodyText.includes('usuario o contrase') ||
                 bodyText.includes('contraseñaa incorrecta') ||
                 bodyText.includes('contraseña incorrecta') ||
                 bodyText.includes('datos incorrectos') ||
                 bodyText.includes('acceso denegado')
        };
      });
      if (pageInfo.isRateLimited) {
        errorMsg = "Taxes.com.ar restringió temporalmente las solicitudes automáticas por exceso de tráfico (Error 429 Too Many Requests). Espere 3 a 5 minutos e intente nuevamente.";
      } else if (pageInfo.isInvalidCreds) {
        errorMsg = "Credenciales incorrectas en Taxes.com.ar. Verifique su contraseña.";
      }
    } catch (e) {
      console.log("Could not evaluate error text on login page.");
    }
    // Save a shared debug snapshot (screenshot + full HTML) any time autoLogin fails,
    // regardless of which feature (sync, verify, catalogs) triggered it — so we can
    // always inspect what the page actually looked like at the moment of failure.
    try {
      const path = require('path');
      const fs = require('fs');
      await page.screenshot({ path: path.join(__dirname, 'public', 'last_login_attempt.png'), fullPage: true });
      const html = await page.content();
      fs.writeFileSync(path.join(__dirname, 'public', 'last_login_attempt.html'), html);
      console.warn(`[autoLogin] Debug snapshot saved: public/last_login_attempt.png and .html`);
    } catch (se) {
      console.warn('[autoLogin] Debug snapshot failed:', se.message);
    }
    throw new Error(errorMsg);
  }

  console.log(`Login successful as ${username}!`);
  return page; // Return authenticated page for reuse
}

// 1. SCRAPE CATALOGS FUNCTION
async function scrapeCatalogs(triggerUsername = null) {
  if (isScraping) return { success: false, message: "Catalog scraping is already running." };
  isScraping = true;
  await acquireBrowserLock('scrapeCatalogs');

  const settings = db.getSettings();
  let username = settings.username;
  let password = settings.password;

  if (triggerUsername) {
    const cleanTriggerUsername = triggerUsername.split(',')[0].trim();
    const user = db.getUser(cleanTriggerUsername);
    if (user && user.password) {
      username = user.username;
      password = user.password;
    }
  }

  if (!username || !password) {
    if (scrapeCatalogsAbandoned) {
      console.log(`[ScrapeCatalogs] Ejecución abandonada por timeout — ignorando resultado tardío.`);
      return { success: false, message: 'Abandoned due to timeout' };
    }
    isScraping = false; releaseBrowserLock();
    db.saveSettings({ catalogSyncStatus: "error", catalogSyncError: "Faltan configurar las credenciales de Taxes." });
    return { success: false, message: "Faltan configurar las credenciales de Taxes." };
  }

  console.log(`Starting automatic catalog extraction from Taxes.com.ar using user: ${username}...`);
  let browser = null;

  try {
    db.saveSettings({ catalogSyncStatus: "syncing", catalogSyncError: null });
    browser = await launchBrowser();
    // Login and use the authenticated page directly
    const page = await autoLogin(browser, username, password, settings.portalUrl);

    // ============================================================
    // STEP A: SCRAPE ALL RODADOS FROM FLOTA > FLOTA (limit 999)
    // ============================================================
    console.log("=== PASO 1/3: Scrapeando FLOTA completa ===");
    console.log("Navigating to Flota > Flota page...");
    await safeGoto(page, `${settings.portalUrl}/tms/produccion/flota`, { timeout: 30000 });
    await delay(3000);

    // Set limit to 999 to show all vehicles
    console.log("Setting limit to 999 to show all vehicles...");
    const limitSet = await safeEvaluate(page, () => {
      // The Límite field is an input field on the Taxes Flota page
      const inputs = Array.from(document.querySelectorAll('input'));
      for (const inp of inputs) {
        const name = (inp.name || '').toLowerCase();
        const id = (inp.id || '').toLowerCase();
        const placeholder = (inp.placeholder || '').toLowerCase();
        // Also check by looking at nearby labels
        const parent = inp.closest('.form-group') || inp.parentElement;
        const parentText = parent ? parent.textContent.toLowerCase() : '';
        
        if (name.includes('limit') || id.includes('limit') || 
            placeholder.includes('limit') || parentText.includes('límite') || parentText.includes('limite')) {
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(inp, '999');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return { found: true, method: 'input_limite', value: '999' };
        }
      }
      // Fallback: try finding any input near "Límite" text
      const allLabels = Array.from(document.querySelectorAll('label, span, div'));
      for (const lbl of allLabels) {
        const text = lbl.textContent.trim().toLowerCase();
        if (text === 'límite' || text === 'limite' || text === 'limit') {
          const container = lbl.closest('.form-group') || lbl.parentElement;
          const inp = container ? container.querySelector('input') : null;
          if (inp) {
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(inp, '999');
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return { found: true, method: 'label_search', value: '999' };
          }
        }
      }
      return { found: false };
    });
    console.log("Limit set result:", JSON.stringify(limitSet));

    // Click "BUSCAR" button
    console.log("Clicking BUSCAR button...");
    const buscarClicked = await safeEvaluate(page, () => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
      for (const btn of buttons) {
        const text = btn.textContent.trim().toUpperCase();
        const val = (btn.value || '').toUpperCase();
        if (text.includes('BUSCAR') || val.includes('BUSCAR')) {
          btn.click();
          return { clicked: true, text: btn.textContent.trim() };
        }
      }
      // Fallback: submit the form
      const form = document.querySelector('form');
      if (form) { form.submit(); return { clicked: true, text: 'form.submit()' }; }
      return { clicked: false };
    });
    console.log("Buscar result:", JSON.stringify(buscarClicked));

    // Wait for the table to reload with all results
    await delay(5000);
    await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {});
    await delay(3000);

    // Log total count from page
    const totalText = await safeEvaluate(page, () => {
      const body = document.body.textContent;
      const match = body.match(/Total:\s*(\d+)\s*registros/i);
      return match ? match[0] : 'Total not found';
    });
    console.log("Fleet page reports:", totalText);

    // Attempt to set DataTable page length to maximum to reduce pagination overhead
    console.log("Attempting to set DataTable page length to maximum...");
    const lengthResult = await safeEvaluate(page, () => {
      const select = document.querySelector('select[name$="_length"], select[class*="length"], .dataTables_length select');
      if (select) {
        let bestOpt = null;
        let maxVal = -1;
        for (const opt of Array.from(select.options)) {
          if (opt.value === '-1' || opt.text.toLowerCase().includes('todos')) {
            bestOpt = opt;
            break;
          }
          const val = parseInt(opt.value, 10);
          if (val > maxVal) {
            maxVal = val;
            bestOpt = opt;
          }
        }
        if (bestOpt) {
          select.value = bestOpt.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return { found: true, value: bestOpt.value, text: bestOpt.text };
        }
      }
      return { found: false };
    }).catch(() => ({ found: false }));
    console.log("DataTable length adjustment result:", JSON.stringify(lengthResult));
    
    if (lengthResult.found) {
      await delay(3000); // Allow DataTable to redraw
    }

    // Scrape all vehicles from the Flota table using pagination
    console.log("Scraping all vehicles from fleet table...");
    let rodados = [];
    let hasNextPage = true;
    let pageNum = 1;
    
    while (hasNextPage) {
      console.log(`Scraping DataTable page ${pageNum}...`);
      
      const pageVehicles = await safeEvaluate(page, () => {
        const results = [];
        const mainTable = document.querySelector('#tabla_flota');
        if (!mainTable) return results;
        
        const rows = mainTable.querySelectorAll('tbody tr');
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length < 3) continue;
          
          const cellTexts = Array.from(cells).map(c => c.textContent.trim());
          const interno = cellTexts[1] || '';
          const modelo = cellTexts[2] || '';
          const patente = cellTexts[3] || '';
          const equipo = cellTexts.length > 7 ? cellTexts[7] : '';
          
          if (!modelo || modelo === '-' || modelo === 'Ningún dato disponible en esta tabla') continue;
          
          let label = modelo;
          if (interno && !label.toLowerCase().includes('interno')) {
            label += ` Interno ${interno}`;
          }
          
          // Get vehicle ID
          let value = '';
          const link = row.querySelector('a');
          if (link) {
            const href = link.href || '';
            const idMatch = href.match(/\/(\d+)(?:\/|$|\?)/);
            if (idMatch) value = idMatch[1];
          }
          if (!value && interno) value = interno;
          
          results.push({ value, label, interno, modelo, patente, equipo });
        }
        return results;
      });
      
      console.log(`Found ${pageVehicles.length} vehicles on DataTable page ${pageNum}.`);
      rodados.push(...pageVehicles);
      
      // Check if "Siguiente" button is enabled
      const nextButtonInfo = await safeEvaluate(page, () => {
        const nextBtn = document.querySelector('#tabla_flota_next');
        if (!nextBtn) return { exists: false };
        
        const isDisabled = nextBtn.classList.contains('disabled') || 
                           nextBtn.getAttribute('aria-disabled') === 'true' ||
                           nextBtn.classList.contains('ui-state-disabled');
        return { exists: true, disabled: isDisabled };
      });
      
      if (nextButtonInfo.exists && !nextButtonInfo.disabled) {
        console.log("Clicking 'Siguiente' page...");
        await page.click('#tabla_flota_next');
        await delay(1500); // wait for DataTable page transition
        pageNum++;
      } else {
        console.log("No more pages in DataTable.");
        hasNextPage = false;
      }
    }

    console.log(`Total scraped vehicles: ${rodados.length}`);

    // If still no rodados found, take a screenshot for debugging and keep existing catalog
    if (rodados.length < 3) {
      console.log("WARNING: Could not scrape enough rodados. Taking debug screenshot...");
      await page.screenshot({ path: 'debug_flota_page.png', fullPage: true });
      
      // Dump the page HTML structure for debugging
      const pageTitle = await page.title();
      const pageUrl = page.url();
      const bodyText = await safeEvaluate(page, () => document.body.textContent.substring(0, 500));
      console.log(`Page title: ${pageTitle}`);
      console.log(`Page URL: ${pageUrl}`);
      console.log(`Body text preview: ${bodyText}`);
      
      // Keep existing rodados from database if available
      const existingCatalogs = db.getCatalogs();
      if (existingCatalogs.rodados && existingCatalogs.rodados.length > 5) {
        rodados = existingCatalogs.rodados;
        console.log(`Keeping ${rodados.length} existing rodados from database.`);
      } else {
        rodados = MOCK_CATALOGS.rodados;
        console.log("Falling back to mock rodados.");
      }
    }

    // ============================================================
    // STEP B: SCRAPE EMPLOYEES & CENTROS DE COSTO FROM OT PAGE
    // ============================================================
    console.log("=== PASO 2/3: Scrapeando Empleados y Centros de Costo ===");
    console.log("Navigating to Ordenes de Trabajo list page...");
    await safeGoto(page, `${settings.portalUrl}/tms/produccion/ot`, { timeout: 30000 });
    
    console.log("Waiting for selects to load via polling...");
    await delay(4000);
    // Poll for select elements (avoids waitForSelector detached frame issues)
    for (let i = 0; i < 20; i++) {
      try {
        const hasSelect = await safeEvaluate(page, () => !!document.querySelector('select'));
        if (hasSelect) { console.log("Select found after polling."); break; }
      } catch (e) { /* still navigating */ }
      await delay(500);
    }

    console.log("Waiting for employee select options to populate...");
    for (let i = 0; i < 30; i++) {
      try {
        const hasOptions = await safeEvaluate(page, () => {
          const selects = Array.from(document.querySelectorAll('select'));
          return selects.some(s => s.options.length > 50);
        });
        if (hasOptions) { console.log("Employee options populated."); break; }
      } catch (e) { /* still navigating */ }
      await delay(500);
    }

    // Scrape all employees from the select that has the most options
    console.log("Scraping employees/responsibles from list page...");
    const employees = await safeEvaluate(page, () => {
      const selects = Array.from(document.querySelectorAll('select'));
      let empSelect = null;
      let maxOptions = 0;
      for (const s of selects) {
        if (s.options.length > maxOptions) {
          maxOptions = s.options.length;
          empSelect = s;
        }
      }

      if (empSelect && maxOptions > 50) {
        return Array.from(empSelect.options)
          .filter(opt => opt.value && opt.value !== '0' && opt.value !== '')
          .map(opt => ({
            value: opt.value,
            label: opt.textContent.trim()
          }));
      }
      return [];
    });

    console.log(`Found ${employees.length} employees/responsibles.`);

    // Click NUEVO button to open creation form modal
    console.log("Clicking NUEVO button...");
    const nuevoClicked = await safeEvaluate(page, () => {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      for (const btn of buttons) {
        const text = btn.textContent.trim().toUpperCase();
        if (text === 'NUEVO' || text === 'NUEVA') {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!nuevoClicked) {
      throw new Error("No se pudo encontrar el botón NUEVO en la página de Órdenes de Trabajo.");
    }

    // Wait for the modal / creation form to open via polling
    console.log("Waiting for modal to open via polling...");
    await delay(2000);
    for (let i = 0; i < 20; i++) {
      try {
        const found = await safeEvaluate(page, () => !!document.querySelector('select[name="inv_ot_clasificacion_id"]'));
        if (found) { console.log('Modal select found.'); break; }
      } catch (e) { /* navigating */ }
      await delay(500);
    }

    // Click AGREGAR TAREA
    console.log("Clicking AGREGAR TAREA...");
    await safeEvaluate(page, () => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const addBtn = buttons.find(b => b.textContent.includes('AGREGAR TAREA') || b.textContent.includes('Agregar Tarea'));
      if (addBtn) addBtn.click();
    });
    
    // Wait for task card to appear via polling
    console.log("Waiting for task card to appear via polling...");
    await delay(2000);
    for (let i = 0; i < 20; i++) {
      try {
        const found = await safeEvaluate(page, () => !!document.querySelector('select[name="syj_centro_costo_id_0"]'));
        if (found) { console.log('CC select found.'); break; }
      } catch (e) { /* navigating */ }
      await delay(500);
    }

    console.log("Waiting for Centro de Costo options to populate via polling...");
    for (let i = 0; i < 20; i++) {
      try {
        const ready = await safeEvaluate(page, () => {
          const ccSelect = document.querySelector('select[name="syj_centro_costo_id_0"]');
          return ccSelect && ccSelect.options.length > 1;
        });
        if (ready) { console.log('CC options populated.'); break; }
      } catch (e) { /* navigating */ }
      await delay(500);
    }

    // Scrape Centros de Costo from the newly added task card
    console.log("Scraping Centros de Costo from task card...");
    const centrosCosto = await safeEvaluate(page, () => {
      const ccSelect = document.querySelector('select[name="syj_centro_costo_id_0"]');
      if (ccSelect) {
        return Array.from(ccSelect.options)
          .filter(opt => opt.value && opt.value !== '')
          .map(opt => ({
            value: opt.value,
            label: opt.textContent.trim()
          }));
      }
      return [];
    });

    console.log(`Found ${centrosCosto.length} Centros de Costo.`);

    // ============================================================
    // STEP C: SAVE ALL CATALOGS
    // ============================================================
    console.log("=== PASO 3/3: Guardando catálogos ===");
    
    const mergedResponsables = employees.length > 0 ? employees : MOCK_CATALOGS.responsables;
    const mergedEmpleados = employees.length > 0 ? employees : MOCK_CATALOGS.empleados;
    const mergedCentros = centrosCosto.length > 0 ? centrosCosto : MOCK_CATALOGS.centrosCosto;

    // Merge scraped rodados with existing database rodados (preserving manual entries like Interno 125)
    const existingRodados = (db.getCatalogs() || {}).rodados || [];
    const rodadosMap = new Map();
    existingRodados.forEach(r => { if (r && r.interno) rodadosMap.set(String(r.interno).trim(), r); });
    rodados.forEach(r => { if (r && r.interno) rodadosMap.set(String(r.interno).trim(), r); });
    const mergedRodados = Array.from(rodadosMap.values()).sort((a, b) => (parseInt(a.interno) || 0) - (parseInt(b.interno) || 0));

    const finalCatalogs = {
      rodados: mergedRodados.length > 0 ? mergedRodados : rodados,
      responsables: mergedResponsables,
      empleados: mergedEmpleados,
      centrosCosto: mergedCentros
    };

    db.saveCatalogs(finalCatalogs);
    db.saveSettings({ catalogSyncStatus: "success", catalogSyncError: null });
    console.log(`Catalog scraping completed! Rodados: ${rodados.length}, Empleados: ${mergedEmpleados.length}, Centros: ${mergedCentros.length}`);
    if (scrapeCatalogsAbandoned) {
      console.log(`[ScrapeCatalogs] Ejecución abandonada por timeout — ignorando resultado tardío.`);
      if (browser) try { await browser.close(); } catch (_) {}
      return { success: false, message: 'Abandoned due to timeout' };
    }
    isScraping = false; releaseBrowserLock();
    await browser.close();
    return { success: true, message: `Catálogos actualizados: ${rodados.length} rodados, ${mergedEmpleados.length} empleados, ${mergedCentros.length} centros de costo.` };
  } catch (error) {
    console.error("Error scraping catalogs:", error);
    if (scrapeCatalogsAbandoned) {
      console.log(`[ScrapeCatalogs] Ejecución abandonada por timeout — ignorando resultado tardío.`);
      if (browser) try { await browser.close(); } catch (_) {}
      return { success: false, message: 'Abandoned due to timeout' };
    }
    db.saveSettings({ catalogSyncStatus: "error", catalogSyncError: error.message });
    if (browser) {
      try {
        const pages = await browser.pages();
        const activePage = pages[pages.length - 1];
        if (activePage) {
          const path = require('path');
          await activePage.screenshot({ path: path.join(__dirname, 'public', 'last_catalog_error.png'), fullPage: true });
          console.warn(`[ScrapeCatalogs] Debug screenshot saved to public/last_catalog_error.png. Current URL: ${activePage.url()}`);
          const fs = require('fs');
          const html = await activePage.content();
          fs.writeFileSync(path.join(__dirname, 'public', 'last_catalog_error.html'), html);
          console.warn(`[ScrapeCatalogs] Debug HTML saved to public/last_catalog_error.html`);
        }
      } catch (se) { console.warn('[ScrapeCatalogs] Debug screenshot failed:', se.message); }
    }
    isScraping = false; releaseBrowserLock();
    if (browser) await browser.close();
    return { success: false, message: `Error al extraer catálogos: ${error.message}` };
  }
}

// Helper wrapper to execute scrapeCatalogs with a 5-minute global safety timeout
async function scrapeCatalogsWithTimeout(triggerUsername = null) {
  let timeoutId;
  scrapeCatalogsAbandoned = false;
  try {
    return await Promise.race([
      scrapeCatalogs(triggerUsername),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Timeout: extracción de catálogos tardó más de 5 minutos')), 5 * 60 * 1000);
      })
    ]);
  } catch (err) {
    console.error(`[ScrapeCatalogs Timeout Safety] Fallo o timeout:`, err.message);
    scrapeCatalogsAbandoned = true;
    isScraping = false;
    releaseBrowserLock();
    await killZombieChromes().catch(() => {});
    try {
      db.saveSettings({ catalogSyncStatus: 'error', catalogSyncError: err.message || 'Extracción cancelada por timeout de 5 minutos' });
    } catch (dbErr) {
      console.error(`[ScrapeCatalogs Timeout Safety] Error al actualizar settings:`, dbErr.message);
    }
    return { success: false, message: err.message };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// Helper to extract pure base user description by stripping any previously appended system suffixes
function extractPureUserDescription(desc) {
  if (!desc) return '';
  let clean = desc;
  // Remove [Insumos: ...] blocks
  clean = clean.replace(/\[Insumos:[^\]]*\]/gi, '');
  // Remove - Insumos: ... or . Insumos: ... blocks
  clean = clean.replace(/(\s*-\s*|\s*\.\s*)Insumos:\s*[^\n\r]*/gi, '');
  // Remove Realizó: ... blocks
  clean = clean.replace(/(\s*-\s*|\s*\.\s*)Realizó:\s*[^\n\r]*/gi, '');
  clean = clean.replace(/(\s*-\s*|\s*\.\s*)Realizo:\s*[^\n\r]*/gi, '');
  // Remove Diagnóstico: ... blocks
  clean = clean.replace(/(\s*-\s*|\s*\.\s*)Diagnóstico:\s*[^\n\r]*/gi, '');
  clean = clean.replace(/(\s*-\s*|\s*\.\s*)Diagnostico:\s*[^\n\r]*/gi, '');
  return clean.trim();
}

// Helper to extract base description for comparisons
function extractBaseDescription(desc) {
  return extractPureUserDescription(desc).replace(/[.,\s]/g, '').toLowerCase();
}

// Helper to resolve employee name and handle custom fallbacks (like mapping to Vera)
function resolveAndMapEmployee(task) {
  const employeeCatalog = db.getCatalogs().empleados || [];
  const employeeObj = employeeCatalog.find(e => e.value === task.empleado);
  let employeeLabel = employeeObj ? employeeObj.label : task.empleado;

  const settings = db.getSettings();
  const savedMappings = settings.employeeMappings;

  const FALLBACK_MAPPINGS = {
    Taller: [
      { appName: 'GODOY DAVID',               taxesName: 'Vera, Domingo Sergio' },
      { appName: 'DOMINIC DYLAN',              taxesName: 'Vera, Domingo Sergio' },
      { appName: 'PEREZ FACUNDO',              taxesName: 'Vera, Domingo Sergio' },
      { appName: 'LOPEZ GUSTAVO',              taxesName: 'Vera, Domingo Sergio' },
      { appName: 'CALOMINO DARIO',             taxesName: 'Vera, Domingo Sergio' },
      { appName: 'MUSDALINO FRANCO',           taxesName: 'Vera, Domingo Sergio' },
      { appName: 'RODRIGUEZ MARCELO',          taxesName: 'Vera, Domingo Sergio' },
      { appName: 'Cuba Orosco, Kevín Genaro',  taxesName: 'Cuba Orosco, Kevín Genaro' }
    ],
    Herrería: [
      { appName: 'Federico', taxesName: 'García, Yamandú Liborio' },
      { appName: 'Luciano',  taxesName: 'Carmona González, Juan Manuel' },
      { appName: 'Digno',    taxesName: 'García, Yamandú Liborio' }
    ],
    Edilicio: []
  };

  const effectiveMappings = (savedMappings && (savedMappings.Taller || savedMappings.Herrería || savedMappings.Edilicio))
    ? savedMappings
    : FALLBACK_MAPPINGS;

  const allMappings = [
    ...(effectiveMappings.Taller   || []),
    ...(effectiveMappings.Herrería || []),
    ...(effectiveMappings.Edilicio || [])
  ];

  let finalDescription = (task.descripcion || '').trim();
  const cleanDescLower = finalDescription.toLowerCase();

  const matchedEntry = allMappings.find(entry =>
    entry.appName && entry.appName.trim().toLowerCase() === employeeLabel.trim().toLowerCase()
  );

  if (matchedEntry && matchedEntry.taxesName && matchedEntry.taxesName.trim()) {
    const isSameName = matchedEntry.appName.trim().toLowerCase() === matchedEntry.taxesName.trim().toLowerCase();
    const proxySuffix = `Realizó: ${matchedEntry.appName.trim()}`;
    if (!cleanDescLower.includes(proxySuffix.toLowerCase())) {
      finalDescription = `${finalDescription}. ${proxySuffix}`;
    }
    if (!isSameName) {
      employeeLabel = matchedEntry.taxesName.trim();
    }
  }

  // Append diagnostico/diagnostic if present and not already in description
  if (task.diagnostico && task.diagnostico.trim()) {
    const diagStr = task.diagnostico.trim();
    if (!cleanDescLower.includes(diagStr.toLowerCase()) && !cleanDescLower.includes('diagnóstico') && !cleanDescLower.includes('diagnostico')) {
      finalDescription = `${finalDescription}. Diagnóstico: ${diagStr}`;
    }
  }

  // Append insumos/supplies if present and not already in description
  if (task.insumos && task.insumos.trim()) {
    const insumosStr = task.insumos.trim();
    if (!cleanDescLower.includes(insumosStr.toLowerCase()) && !cleanDescLower.includes('insumos')) {
      finalDescription = `${finalDescription} [Insumos: ${insumosStr}]`;
    }
  }

  return { employeeLabel, finalDescription };
}

// 2. SYNCHRONIZE SINGLE WORK ORDER (REPARADO ANTI-DUPLICADOS VELOCES)
async function syncWorkOrder(orderId) {
  let order = db.getWorkOrderById(orderId);
  if (!order) return { success: false, message: "Order not found" };

  // CONTROL INTERNO EN MEMORIA (Rechazo instantáneo en menos de 1 milisegundo)
  const claveCandado = `${order.interno}_${order.clasificacion}`;
  if (candadoInternosActivos.has(claveCandado)) {
    console.warn(`[Anti-Duplicado] 🛑 Petición duplicada veloz bloqueada para el camión: ${order.interno}`);
    return { success: false, message: "Esta orden ya se está procesando o está en cola de espera." };
  }

  // Si pasó el control, bloqueamos el camión inmediatamente en memoria
  candadoInternosActivos.add(claveCandado);

  if (order.syncStatus === 'syncing' && order.syncLockTime && (Date.now() - new Date(order.syncLockTime).getTime() < 120000)) {
    console.log(`[SyncLock] Order ID ${orderId} is ALREADY active in another sync process. Skipping duplicate run.`);
    candadoInternosActivos.delete(claveCandado); // Liberamos antes de salir
    return { success: false, message: "Order is already syncing" };
  }

  // Mark as syncing IMMEDIATELY before browser lock to block rapid duplicate calls
  db.updateWorkOrder(orderId, { syncStatus: "syncing", syncError: null, syncLockTime: new Date().toISOString() });

  const settings = db.getSettings();
  const username = settings.username;
  const password = settings.password;

  if (!username || !password) {
    db.updateWorkOrder(orderId, {
      syncStatus: "error",
      syncError: "Faltan las credenciales en Ajustes. Configurá el usuario y contraseña de Taxes."
    });
    candadoInternosActivos.delete(claveCandado); // Liberamos antes de salir
    return { success: false, message: "Missing credentials in settings" };
  }

  let browser = null;

  try {
    await acquireBrowserLock(`syncWorkOrder(${orderId})`);

    // RE-READ FRESH ORDER STATE AFTER ACQUIRING BROWSER LOCK
    order = db.getWorkOrderById(orderId);
    if (!order) {
      return { success: false, message: "Order not found after lock" };
    }

    // Pre-check DB safeguard: If this order has no taxesOrderNumber yet, check if another active order for the same interno AND same clasificacion already generated an OT today!
    if (!order.taxesOrderNumber && order.interno) {
      const dbData = db.read();
      const existingWithOt = (dbData.workOrders || []).find(o => 
        String(o.id) !== String(orderId) && 
        o.deleted !== true &&
        String(o.interno).trim().toLowerCase() === String(order.interno).trim().toLowerCase() &&
        String(o.clasificacion || '').trim().toLowerCase() === String(order.clasificacion || '').trim().toLowerCase() &&
        o.taxesOrderNumber && String(o.taxesOrderNumber).trim() !== '' &&
        (Date.now() - new Date(o.createdAt || o.syncDate || Date.now()).getTime() < 24 * 60 * 60 * 1000)
      );
      if (existingWithOt && existingWithOt.taxesOrderNumber) {
        console.log(`[Pre-Check DB Safeguard] Order ${orderId} (Interno ${order.interno}, Clasificación ${order.clasificacion}) matched existing OT #${existingWithOt.taxesOrderNumber} in DB! Linking...`);
        db.updateWorkOrder(orderId, { taxesOrderNumber: existingWithOt.taxesOrderNumber });
        order.taxesOrderNumber = existingWithOt.taxesOrderNumber;
      }
    }

    console.log(`\n=== Starting Background Sync for OT #${order.interno} (ID: ${order.id}) [taxesOrderNumber: ${order.taxesOrderNumber || 'NEW'}] ===`);

    // Launch browser
    browser = await launchBrowser();

    // 1. LOGIN - autoLogin creates a fresh page directly on /login
    let page;
    try {
      page = await autoLogin(browser, username, password, settings.portalUrl);
    } catch (loginError) {
      throw new Error(`Error de login para ${username}: ${loginError.message}`);
    }

    page.on('requestfailed', r => {
      console.log(`[Browser-Network-Err] Request failed: ${r.url()} - ${r.failure()?.errorText || ''}`);
    });
    page.on('response', r => {
      if (r.status() >= 400) {
        console.log(`[Browser-Network-Err] Response error: ${r.url()} - Status: ${r.status()}`);
      }
    });


    // ====== FASE 1: CREAR LA CABECERA TOTALMENTE VACÍA (SI ES ORDEN NUEVA) ======
    if (!order.taxesOrderNumber) {
      console.log(`[Alta O.T.] Creando cabecera limpia para el interno ${order.interno} (${order.clasificacion})...`);
      
      await ensureOnOtPage(page, settings.portalUrl);
      await page.waitForSelector('table', { timeout: 10000 }).catch(() => {});
      await delay(1000);

      // Esperar 2 segundos para que el catálogo de camiones y la vista carguen completamente en segundo plano
      console.log("[Alta O.T.] Esperando 2 segundos para la carga del catálogo de camiones en la vista...");
      await delay(2000);

      let numeroGenerado = null;

      // 1. Chequear si la orden actual en la BD local YA tiene su N° de O.T. asignado
      const dbData = db.read();
      const existingInDb = (dbData.workOrders || []).find(o => 
        String(o.id) === String(orderId) && 
        o.taxesOrderNumber && String(o.taxesOrderNumber).trim() !== ''
      );

      if (existingInDb && existingInDb.taxesOrderNumber) {
        console.log(`[Alta O.T.] La orden actual (${orderId}) ya cuenta con O.T. #${existingInDb.taxesOrderNumber} asignada en BD. Reutilizando...`);
        numeroGenerado = existingInDb.taxesOrderNumber;
        order.taxesOrderNumber = existingInDb.taxesOrderNumber;
      } else {
        // 2. Si es una orden nueva sin O.T., chequear si en Taxes hay una O.T. ABIERTA / EN PROCESO (NO cerrada/operativa) para esta misma orden en curso
        console.log(`[Alta O.T.] Inspeccionando tabla por si existe una O.T. ABIERTA en proceso para el interno ${order.interno} (${order.clasificacion})...`);
        
        const existingOpenTaxesOt = await safeEvaluate(page, (targetInterno, targetClasif) => {
          const clean = s => (s || '').toString().trim().toUpperCase();
          const todayStr = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
          
          const tables = Array.from(document.querySelectorAll('table'));
          for (const table of tables) {
            const rows = Array.from(table.querySelectorAll('tbody tr'));
            for (const row of rows) {
              const cells = Array.from(row.querySelectorAll('td')).map(c => clean(c.textContent));
              if (cells.length >= 3) {
                const otCell = cells.find(c => /^\d{4,6}$/.test(c.replace(/^#/, '')));
                const otNum = otCell ? otCell.replace(/^#/, '').trim() : '';
                
                const intMatch = cells.some(c => c.includes(clean(targetInterno)));
                const dateMatch = cells.some(c => c.includes(clean(todayStr)));

                // Verificar si la fila en Taxes NO está cerrada ni finalizada
                const isClosedOrOperativo = cells.some(c => 
                  c.includes('CERRAD') || c.includes('FINALIZAD') || c.includes('OPERATIV') || c.includes('COMPLETAD')
                );

                if (intMatch && dateMatch && otNum && !isClosedOrOperativo) {
                  return otNum;
                }
              }
            }
          }
          return null;
        }, order.interno, order.clasificacion);

        if (existingOpenTaxesOt) {
          console.log(`[Alta O.T.] O.T. abierta en proceso #${existingOpenTaxesOt} detectada para Interno ${order.interno}. Vinculando sin crear nueva...`);
          numeroGenerado = existingOpenTaxesOt;
          db.updateWorkOrder(orderId, { taxesOrderNumber: existingOpenTaxesOt, syncStatus: 'success', syncError: null });
          order.taxesOrderNumber = existingOpenTaxesOt;
        } else {
          console.log(`[Alta O.T.] No se detectó O.T. abierta en proceso para Interno ${order.interno}. Se procederá a crear una NUEVA O.T. en Taxes.`);
        }
      }

      if (!numeroGenerado) {
        console.log("[Alta O.T.] Buscando y pulsando el botón verde '+ NUEVO'...");
        
        let modalListo = false;
        for (let int = 1; int <= 10; int++) {
          const btnInfo = await safeEvaluate(page, () => {
            // Filtrar exclusivamente etiquetas button o enlaces de tipo botón (a.btn) excluyendo explícitamente el botón Guardar
            const candidates = Array.from(document.querySelectorAll('button, a.btn, a, input[type="button"]'));
            const match = candidates.find(b => {
              const txt = (b.textContent || b.value || '').trim().toUpperCase();
              if (txt.includes('GUARDAR')) return false; // NUNCA tomar el botón Guardar como + NUEVO
              return txt === '+ NUEVO' || txt === 'NUEVO' || txt.includes('+ NUEVO') || (txt.includes('NUEVO') && !txt.includes('NOVEDAD') && !txt.includes('MODULO'));
            });
            if (!match) return null;
            const target = match.closest('button, a') || match;
            const id = 'tmp-btn-nuevo-' + Date.now();
            target.setAttribute('id', id);
            target.scrollIntoView({ block: 'center' });
            try { target.focus(); } catch(_) {}
            try { target.click(); } catch (_) {}
            ['mousedown', 'mouseup', 'click'].forEach(evtName => {
              try {
                target.dispatchEvent(new MouseEvent(evtName, { bubbles: true, cancelable: true, view: window }));
              } catch (_) {}
            });
            return { id, text: target.textContent.trim(), tag: target.tagName, className: target.className };
          });

          if (btnInfo && btnInfo.id) {
            console.log(`[Alta O.T.] Intento ${int}: Botón localizado '<${btnInfo.tag} class="${btnInfo.className}"> "${btnInfo.text}"'. Ejecutando clic nativo...`);
            await page.click(`#${btnInfo.id}`).catch(() => {});
          } else {
            console.log(`[Alta O.T.] Intento ${int}: Esperando despliegue del modal de nueva orden...`);
          }

          await delay(1000);

          modalListo = await safeEvaluate(page, () => {
            const hasRodadoInput = !!document.querySelector('input.searchable-input, input[name="titulo"]');
            const hasModalText = document.body.innerText.includes('Nueva Orden de Trabajo') || 
                                 document.body.innerText.includes('Nueva Orden') ||
                                 document.body.innerText.includes('Rodado');
            return hasRodadoInput || hasModalText;
          });

          if (modalListo) {
            console.log(`[Alta O.T.] ¡Modal 'Nueva Orden de Trabajo' desplegado con éxito en intento ${int}!`);
            break;
          }
        }

        if (!modalListo) {
          console.warn("[Alta O.T.] El modal de Nueva Orden no se detectó tras 10 intentos.");
        }

        try {
          console.log("[Puppeteer] Formulario 'Nueva Orden de Trabajo' desplegado. Cargando datos...");

          // 1. ESPERAR EL INPUT DE RODADO (Aseguramos que el modal terminó de abrirse)
          const inputRodadoReal = 'input.searchable-input';
          await page.waitForSelector(inputRodadoReal, { visible: true, timeout: 15000 }).catch(() => {});
          await delay(500);

          // 2. CARGAR RODADO
          console.log(`[Puppeteer] 1. Cargar Rodado: ${order.rodado || order.interno}`);
          let rodadoFilled = await fillSearchableSelect(page, 'Rodado', order.rodado || String(order.interno));
          if (!rodadoFilled && order.interno) {
            rodadoFilled = await fillSearchableSelect(page, 'Rodado', String(order.interno).trim());
          }
          if (!rodadoFilled && order.interno) {
            rodadoFilled = await fillSearchableSelect(page, 'Rodado', `Interno ${String(order.interno).trim()}`);
          }
          if (!rodadoFilled) throw new Error(`No se pudo localizar y seleccionar el Rodado '${order.rodado || order.interno}' en el alta de O.T.`);
          await page.screenshot({ path: 'public/paso1_rodado.png' }).catch(() => {});

          // 3. CARGAR RESPONSABLE (si es Belocures Cesar, lo buscará al final con "Belocures," / "Belocures, ---")
          let targetResponsableAlta = order.responsable;
          if (!targetResponsableAlta || targetResponsableAlta === 'AUTO' || targetResponsableAlta.includes('@')) {
            targetResponsableAlta = "Belocures, Cesar Hernán";
          }
          console.log(`[Puppeteer] 2. Cargar Responsable: ${targetResponsableAlta}`);
          let respFilledAlta = await fillSearchableSelect(page, 'Responsable', targetResponsableAlta);
          if (!respFilledAlta) {
            respFilledAlta = await fillSearchableSelect(page, 'Responsable', 'Belocures,');
          }
          if (!respFilledAlta) {
            respFilledAlta = await fillSearchableSelect(page, 'Responsable', 'Belocures');
          }
          if (!respFilledAlta) {
            respFilledAlta = await fillSearchableSelect(page, 'Responsable', 'Cesar');
          }
          if (!respFilledAlta) throw new Error("No se pudo seleccionar el Responsable en el alta de O.T.");
          await page.screenshot({ path: 'public/paso2_responsable.png' }).catch(() => {});

          // 4. CARGAR TÍTULO (NÚMERO DE INTERNO)
          console.log(`[Puppeteer] 3. Cargar Título (número de interno): ${order.interno}`);
          await safeEvaluate(page, (interno) => {
            let input = document.querySelector('input[name="titulo"]');
            if (!input) {
              const labels = Array.from(document.querySelectorAll('label, div, span'));
              const lbl = labels.find(l => {
                const txt = l.textContent.trim().toLowerCase();
                return txt.startsWith('título') || txt.startsWith('titulo');
              });
              if (lbl) {
                const parent = lbl.closest('.form-group') || lbl.closest('.taxes-form-group') || lbl.parentElement;
                if (parent) input = parent.querySelector('input[type="text"], input');
              }
            }
            if (input) {
              input.focus();
              const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              nativeSetter.call(input, String(interno));
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, order.interno);
          await delay(500);

          // 5. CARGAR CLASIFICACIÓN
          console.log(`[Puppeteer] 4. Cargar Clasificación: ${order.clasificacion}`);
          await safeEvaluate(page, (valorClasificacion) => {
            const etiquetas = Array.from(document.querySelectorAll('label, div, span'));
            const etiquetaClasif = etiquetas.find(el => {
              const txt = el.textContent.trim().toLowerCase();
              return txt.startsWith('clasificación') || txt.startsWith('clasificacion');
            });
            
            if (etiquetaClasif) {
              const contenedor = etiquetaClasif.closest('.form-group') || etiquetaClasif.closest('.taxes-form-group') || etiquetaClasif.parentElement;
              const select = contenedor ? contenedor.querySelector('select') : null;
              if (select && valorClasificacion) {
                const clean = s => String(s || '').trim().toUpperCase();
                const opt = Array.from(select.options).find(o => clean(o.textContent).includes(clean(valorClasificacion)));
                if (opt) {
                  select.value = opt.value;
                } else {
                  select.value = valorClasificacion;
                }
                select.dispatchEvent(new Event('change', { bubbles: true }));
                select.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
          }, order.clasificacion);
          await delay(500);

          // Cargar Fecha Entrega
          await safeEvaluate(page, (dateVal) => {
            const dateInput = document.querySelector('input[type="date"].taxes-datepicker');
            if (dateInput) {
              const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              nativeSetter.call(dateInput, dateVal);
              dateInput.dispatchEvent(new Event('input', { bubbles: true }));
              dateInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, order.fechaEntrega || new Date().toISOString().split('T')[0]);
          await delay(500);

          // 6. GUARDAR
          console.log("[Puppeteer] 5. Guardar: Buscando el botón verde de Guardar...");
          const guardadoExitoso = await safeEvaluate(page, () => {
            const botones = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
            const btnGuardarVerde = botones.find(b => {
              const txt = b.textContent.trim().toLowerCase();
              return txt === 'guardar' || txt.includes('guardar');
            });
            
            if (btnGuardarVerde) {
              btnGuardarVerde.scrollIntoView();
              btnGuardarVerde.focus();
              btnGuardarVerde.click();
              return true;
            }
            return false;
          });

          if (!guardadoExitoso) {
            throw new Error("No se encontró el botón de Guardar en la pantalla de Taxes.");
          }

          // 5. ESPERAR CONFIRMACIÓN TOAST DE TAXES Y CAPTURAR NÚMERO GENERADO REAL (#28448)
          console.log(`[Puppeteer] Escaneando confirmación Toast y tabla de Taxes para Interno ${order.interno}...`);
          
          for (let check = 1; check <= 12; check++) {
            await delay(600);
            numeroGenerado = await safeEvaluate(page, (targetInterno) => {
              const clean = s => (s || '').toString().trim().toUpperCase();
              const cleanTargetInt = clean(targetInterno);

              // A. Carteles Toast / Alertas verdes oficiales (ej: "Orden de Trabajo N 28448 Creada con Éxito")
              const toasts = Array.from(document.querySelectorAll('.toast, .b-toast, .b-toaster, .toast-body, .alert, [role="alert"]'));
              for (const el of toasts) {
                const txt = el.textContent || '';
                if (txt.includes('Creada') || txt.includes('Exito') || txt.includes('Éxito')) {
                  const match = txt.match(/\b(2\d{4})\b/); // Busca números de OT reales de 5 dígitos comenzando con 2
                  if (match) return match[1];
                }
              }

              // B. Filas de la tabla oficial de Taxes para el Interno buscado (ej. Fila con Interno 5 -> O.T. #28448)
              const tables = Array.from(document.querySelectorAll('table'));
              for (const table of tables) {
                const rows = Array.from(table.querySelectorAll('tbody tr'));
                for (const row of rows) {
                  const cells = Array.from(row.querySelectorAll('td')).map(c => clean(c.textContent));
                  if (cells.length < 3) continue;

                  // Verificar si alguna celda coincide exactamente con el interno (ej: "5" o "INTERNO 5")
                  const rowMatchesInterno = cells.some(cellTxt => {
                    if (!cleanTargetInt) return false;
                    if (cellTxt === cleanTargetInt) return true;
                    const words = cellTxt.split(/\s+/);
                    return words.includes(cleanTargetInt) || cellTxt.includes(`INTERNO ${cleanTargetInt}`);
                  });

                  if (rowMatchesInterno) {
                    // Extraer la celda que contiene la OT (ej: "#28448" o "28448")
                    for (const cellTxt of cells) {
                      const otMatch = cellTxt.match(/#?\b(2\d{4})\b/);
                      if (otMatch) return otMatch[1];
                    }
                  }
                }
              }

              return null;
            }, order.interno);

            if (numeroGenerado) {
              console.log(`[Alta O.T.] ¡Número de O.T. #${numeroGenerado} capturado exitosamente para Interno ${order.interno} en intento ${check}!`);
              break;
            }
          }

        } catch (error) {
          await page.screenshot({ path: 'public/error_localizacion_campos.png' }).catch(() => {});
          console.error(`[Falla del Formulario]: ${error.message}`);
          throw error;
        }
      }

      if (numeroGenerado) {
        db.updateWorkOrder(orderId, { taxesOrderNumber: numeroGenerado });
        order.taxesOrderNumber = numeroGenerado;
        console.log(`[Alta O.T.] Cabecera creada con éxito: #${numeroGenerado}. Pausando 3 segundos para verificación visual antes de cerrar...`);
        await delay(3000);
      } else {
        throw new Error("No se pudo capturar el número de O.T. generado por Taxes.");
      }
    }

    // ====== FASE 2: INYECCIÓN DE TAREAS (SOLO CUANDO LA UNIDAD ESTÁ OPERATIVA) ======
    // La inserción de tareas en Taxes ÚNICA y EXCLUSIVAMENTE se ejecuta cuando el estado
    // de la unidad en nuestra app esté en 'Operativo' / 'Operativa'.
    if (order.taxesOrderNumber) {
      const isOperativo = (order.estadoUnidad || '').trim().toLowerCase() === 'operativo' || (order.estadoUnidad || '').trim().toLowerCase() === 'operativa';

      if (!isOperativo) {
        console.log(`[Tareas O.T.] La orden #${order.taxesOrderNumber} (Interno ${order.interno}) está en estado '${order.estadoUnidad || 'Fuera de Servicio'}'. Cabecera registrada vacía en Taxes. Las tareas ÚNICAMENTE se cargarán cuando la unidad pase a Operativo.`);
        db.updateWorkOrder(orderId, { syncStatus: "success", syncError: null });
        return { success: true, message: `Cabecera O.T. #${order.taxesOrderNumber} reservada vacía. Tareas pausadas hasta estado Operativo.` };
      }

      console.log(`[Tareas O.T.] Unidad confirmada en estado OPERATIVO. Navegando a /tms/produccion/ot para buscar O.T. #${order.taxesOrderNumber} y presionar Lápiz (Editar)...`);
      const otNumClean = String(order.taxesOrderNumber).replace(/^#/, '');
      console.log(`[Editar O.T.] Buscando O.T. #${otNumClean} para abrir formulario de tareas vía Lápiz...`);

      const cleanStr = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

      // 1. Go to OT list
      await safeGoto(page, `${settings.portalUrl}/tms/produccion/ot`, { timeout: 30000 });
      await page.waitForSelector('input', { timeout: 10000 }).catch(() => {});
      await delay(2500);

      // Click "En Proceso" tab
      console.log(`[Reconcile] Clicking 'En Proceso' tab...`);
      await safeEvaluate(page, () => {
        const navLinks = Array.from(document.querySelectorAll('a.nav-link, [role="tab"], .nav-tabs li a, .nav li a'));
        const tab = navLinks.find(t => t.textContent.trim().toLowerCase().includes('en proceso'));
        if (tab) { tab.click(); return; }
        const all = Array.from(document.querySelectorAll('a, button, li'));
        const fb  = all.find(t => t.textContent.trim().toLowerCase() === 'en proceso');
        if (fb) { fb.click(); }
      }).catch(() => {});
      await delay(2500);

      // Find and click the Numero input using the exact logic from test_ot_search.js
      const numInputId = await safeEvaluate(page, () => {
        const normalizeText = s => (s || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        // 1. Look for exact "Numero" label
        const allEls = Array.from(document.querySelectorAll('label, span, small, p, .col > div'));
        for (const el of allEls) {
          const t = normalizeText(el.textContent);
          if (t === 'numero') {
            const container = el.closest('.form-group, .col, [class*="col"]') || el.parentElement?.parentElement;
            const inp = container?.querySelector('input');
            if (inp) {
              if (!inp.id) inp.id = 'rc-numero-input-v2';
              return inp.id;
            }
          }
        }
        // 2. Container text includes "numero"
        const vis = Array.from(document.querySelectorAll('input[type="text"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')).filter(i => i.offsetParent);
        for (const inp of vis) {
          const par = inp.closest('.form-group, .col, [class*="col"]');
          if (par && normalizeText(par.textContent).includes('numero')) {
            if (!inp.id) inp.id = 'rc-numero-input-v2-fb';
            return inp.id;
          }
        }
        // 3. Positional fallback (usually index 3)
        const inp = vis[3] || vis[2];
        if (inp) {
          if (!inp.id) inp.id = 'rc-numero-input-v2-fb2';
          return inp.id;
        }
        return null;
      });

      console.log(`[Reconcile] Numero input ID: ${numInputId}`);

      if (numInputId) {
        await page.click(`#${numInputId}`, { clickCount: 3 }).catch(() => {});
        await page.keyboard.press('Backspace');
        await page.keyboard.type(otNumClean, { delay: 80 });
        await delay(500);
        console.log(`[Reconcile] Typed OT number "${otNumClean}". Navigating to BUSCAR via Tab...`);
        await page.keyboard.press('Tab');
        await delay(200);
        await page.keyboard.press('Tab');
        await delay(200);
        await page.keyboard.press('Tab');
        await delay(200);
        await page.keyboard.press('Enter');
        console.log(`[Reconcile] Pressed Enter on focused BUSCAR button`);
        await delay(1000);
      } else {
        console.warn(`[Reconcile] Could not find Numero input field`);
      }

      console.log(`[Reconcile] Waiting up to 12s for OT row "${otNumClean}" to appear in table...`);
      let foundOTRow = false;
      for (let attempt = 1; attempt <= 12; attempt++) {
        foundOTRow = await safeEvaluate(page, (otNum) => {
          const rows = Array.from(document.querySelectorAll('table tbody tr'));
          return rows.some(row => {
            const cells = Array.from(row.querySelectorAll('td'));
            return cells.some(c => {
              const txt = c.textContent.replace(/#/g, '').replace(/\s+/g, ' ').trim();
              return txt === otNum || txt.includes(otNum);
            });
          });
        }, otNumClean);

        if (foundOTRow) {
          console.log(`[Reconcile] OT row found after ${attempt}s!`);
          break;
        }
        await delay(1000);
      }

      // 2. Find the matching row and click pencil (edit).
      // IMPORTANT: we only *locate* the button via evaluate() (read-only, safe).
      // The actual click is done with Puppeteer's native page.click(), which
      // doesn't hang when the click triggers a page navigation — unlike calling
      // .click() on the element from inside safeEvaluate(page, ), which can leave the
      // browser's execution context waiting for a response that never comes.
      const findAndTagPencil = async () => {
        return await safeEvaluate(page, (otNum) => {
          const clean = s => (s || '').replace(/#/g, '').replace(/\s+/g, ' ').trim();
          const rows = Array.from(document.querySelectorAll('table tbody tr'));
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td'));
            const hasOT = cells.some(c => clean(c.textContent).includes(otNum));
            if (hasOT) {
              const allBtns = Array.from(row.querySelectorAll('a, button, [role="button"]'));
              if (allBtns.length === 0) continue;

              // 1. Icono o título explícito de edición
              let editBtn = allBtns.find(b => {
                const html = (b.innerHTML || '').toLowerCase();
                const title = (b.title || b.getAttribute('aria-label') || '').toLowerCase();
                const href = (b.href || b.getAttribute('href') || '').toLowerCase();
                return title.includes('edit') || title.includes('pencil') || html.includes('pencil') || html.includes('edit') || html.includes('fa-pencil') || href.includes('edit');
              });

              // 2. Segundo botón en la lista de acciones (índice 1: el Lápiz al lado del Ojo)
              if (!editBtn && allBtns.length >= 2) {
                editBtn = allBtns[1];
              }

              // 3. Cualquier botón que no sea rojo/danger
              if (!editBtn) {
                editBtn = allBtns.find(b => !b.className.includes('danger') && !b.className.includes('red'));
              }

              if (editBtn) {
                const id = 'tmp-pencil-btn-' + Date.now();
                editBtn.id = id;
                editBtn.scrollIntoView({ block: 'center' });
                return id;
              }
            }
          }
          return null;
        }, otNumClean);
      };

      let pencilClicked = false;
      console.log(`[Reconcile] Locating pencil/edit button for OT ${otNumClean}...`);
      const pencilBtnId = await findAndTagPencil();
      console.log(`[Reconcile] Pencil button located: ${pencilBtnId ? pencilBtnId : 'NOT FOUND'}`);
      if (pencilBtnId) {
        try {
          console.log(`[Reconcile] Clicking pencil button #${pencilBtnId}...`);
          await safeEvaluate(page, (id) => {
            const b = document.getElementById(id);
            if (b) {
              b.scrollIntoView({ block: 'center' });
              try { b.focus(); } catch(_) {}
              try { b.click(); } catch (_) {}
              ['mousedown', 'mouseup', 'click'].forEach(evtName => {
                try { b.dispatchEvent(new MouseEvent(evtName, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
              });
            }
          }, pencilBtnId);

          await page.click(`#${pencilBtnId}`).catch(() => {});
          pencilClicked = true;
        } catch (clickErr) {
          console.warn(`[Reconcile] Native click on pencil button: ${clickErr.message}`);
          pencilClicked = true;
        }
        // Confirm the edit form actually loaded before trusting the click.
        console.log(`[Reconcile] Waiting for edit form to confirm navigation...`);
        const isEditFormLoaded = await safeEvaluate(page, () => {
          const hasTaskInputs = !!document.querySelector('input[name="horas_estimadas"], textarea, select[name*="centro_costo"], select[id*="centro_costo"]');
          const hasModalHeader = document.body.innerText.includes('Editar Orden') || document.body.innerText.includes('Orden de Trabajo') || document.body.innerText.includes('Editar');
          const hasAddBtn = Array.from(document.querySelectorAll('button, a, input')).some(b => {
            const txt = (b.textContent || b.value || '').toLowerCase();
            return txt.includes('agregar') || txt.includes('tarea');
          });
          return hasTaskInputs || hasModalHeader || hasAddBtn;
        });
        pencilClicked = isEditFormLoaded || pencilClicked;
        console.log(`[Reconcile] Edit form loaded: ${pencilClicked}`);
      }

      // If not found, maybe search didn't apply — try pressing Enter in the Numero field and retry
      if (!pencilClicked && numInputId) {
        console.warn(`[Reconcile] Row not found after BUSCAR. Pressing Enter in Numero field and retrying...`);
        await page.click(`#${numInputId}`).catch(() => {});
        await page.keyboard.press('Enter');
        await delay(2000);
        const retryBtnId = await findAndTagPencil();
        if (retryBtnId) {
          try { await page.click(`#${retryBtnId}`); } catch (e) { /* likely navigated away */ }
          pencilClicked = await safeEvaluate(page, () => {
            return document.body.innerText.includes('Editar') || !!document.querySelector('textarea, select');
          });
        }
      }

      if (!pencilClicked) {
        // Save screenshot for debugging
        try {
          const path = require('path');
          const screenshotPath = path.join(__dirname, 'public', 'last_ot_search_debug.png');
          await page.screenshot({ path: screenshotPath, fullPage: false });
          console.log(`[Reconcile] Debug screenshot saved to: ${screenshotPath}`);
        } catch(se) { console.warn('[Reconcile] Screenshot failed:', se.message); }
        throw new Error(`No se pudo abrir el formulario de edición (Lápiz) para la O.T. #${otNumClean} en /tms/produccion/ot.`);
      }

      // 3. Wait 1.5 seconds for OT edit form animation & scroll directly to task section
      await delay(1500);
      await safeEvaluate(page, () => {
        const btns = Array.from(document.querySelectorAll('button, a.btn, a, input[type="button"]'));
        const addBtn = btns.find(b => {
          const txt = (b.textContent || b.value || '').trim().toLowerCase();
          return txt.includes('agregar') || txt.includes('tarea') || txt === '+' || txt.includes('+ tarea');
        });
        if (addBtn) {
          addBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      await delay(500);

      // 4. Read ALL task cards currently in the form (EXCLUDING Incidente o Requisito section)
      const readFormCards = async () => {
        return await safeEvaluate(page, () => {
          const clean = s => (s || '').trim();
          
          // Si el formulario dice explícitamente "No hay tareas asignadas", hay 0 tarjetas
          if (document.body && document.body.innerText.includes('No hay tareas asignadas')) {
            return [];
          }

          // Excluir 100% el textarea superior 'Incidente o Requisito' seleccionando SOLO textareas ubicadas tras el encabezado 'TAREAS A REALIZAR'
          const tareasHeader = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, .card-header, div, span'))
            .find(el => (el.textContent || '').toUpperCase().includes('TAREAS A REALIZAR'));
          
          const allTextareas = Array.from(document.querySelectorAll('textarea'));
          const descTextareas = allTextareas.filter(ta => {
            if (tareasHeader) {
              return (tareasHeader.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
            }
            return ta !== allTextareas[0];
          });

          // Buscar inputs de horas EXCLUSIVAMENTE dentro de tarjetas o contenedores de tareas
          const horasInputs = Array.from(document.querySelectorAll('input[id^="horas_"], input[name="horas_estimadas"]'))
            .filter(inp => {
              const parent = inp.closest('.card, .form-group, .row, div');
              const isIncidenteText = parent && parent.innerText && parent.innerText.toLowerCase().includes('incidente');
              return !isIncidenteText;
            });

          const switches = Array.from(document.querySelectorAll('.custom-control.custom-switch, [class*="switch"]'));
          const trashBtns = Array.from(document.querySelectorAll('button.btn-danger, a.btn-danger, [class*="danger"]'))
            .filter(b => b.querySelector('.fa-trash, .fa-times, .fa-remove') || b.textContent.trim() === '' || b.title?.toLowerCase().includes('elim'));

          const getEmpText = (i) => {
            const wrappers = Array.from(document.querySelectorAll('.searchable-select-wrapper, .multiselect'));
            if (wrappers[i]) {
              const tag = wrappers[i].querySelector('.multiselect__single, .multiselect__tag span, .multiselect__option--selected, .searchable-input');
              if (tag) return clean(tag.value || tag.textContent || '');
            }
            return '';
          };

          const count = Math.max(horasInputs.length, descTextareas.length);
          const cards = [];
          for (let i = 0; i < count; i++) {
            const inp = horasInputs[i];
            cards.push({
              index: i,
              hours: inp ? clean(inp.value) : '',
              employee: getEmpText(i),
              description: descTextareas[i] ? clean(descTextareas[i].value) : '',
              realizada: switches[i] ? (switches[i].querySelector('input[type="checkbox"]')?.checked || false) : false,
              hasTrashBtn: !!trashBtns[i],
              _debug: { emp: getEmpText(i), hrs: inp ? inp.value : '' }
            });
          }
          return cards;
        });
      };

      let formCards = await readFormCards();
      console.log(`[Reconcile] OT edit form has ${formCards.length} task cards. App has ${order.tasks.length} tasks.`);
      console.log(`[Reconcile] Form cards:`, JSON.stringify(formCards));

      // Add missing task cards if app has more tasks than form
      if (formCards.length < order.tasks.length) {
        const toAdd = order.tasks.length - formCards.length;
        console.log(`[Reconcile] Form has ${formCards.length} cards, but app has ${order.tasks.length}. Clicking (+) AGREGAR TAREA ${toAdd} times...`);
        for (let i = 0; i < toAdd; i++) {
          const btnResult = await safeEvaluate(page, () => {
            const tareasHeader = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, .card-header, div, span'))
              .find(el => (el.textContent || '').toUpperCase().includes('TAREAS A REALIZAR'));

            const btns = Array.from(document.querySelectorAll('button, a.btn, a, [role="button"], input[type="button"]'));
            const candidates = btns.filter(x => {
              const txt = (x.textContent || x.value || '').trim().toUpperCase();
              if (txt.includes('GUARDAR') || txt.includes('CANCELAR') || txt.includes('VOLVER')) return false;
              return txt.includes('AGREGAR TAREA') || txt.includes('AGREGAR') || (txt.includes('TAREA') && !txt.includes('REALIZAR'));
            });
            const debugCandidates = candidates.map(c => ({ text: (c.textContent || c.value || '').trim(), belowHeader: tareasHeader ? (tareasHeader.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : null }));

            // Preferir el boton que aparece DESPUES del encabezado 'TAREAS A REALIZAR' (mismo
            // criterio ya probado para aislar los textareas de descripcion de las tareas):
            // si hay otro boton "Agregar..." mas arriba en la pagina (ej. archivos, servicios),
            // el .find() original lo agarraba primero por estar antes en el DOM.
            let b = tareasHeader ? candidates.find(x => (tareasHeader.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) : null;
            if (!b) b = candidates[0];
            if (!b) return { id: null, debugCandidates };
            const id = 'tmp-btn-add-task-' + Date.now();
            b.id = id;
            b.scrollIntoView({ block: 'center' });
            return { id, debugCandidates };
          });
          const btnId = btnResult ? btnResult.id : null;
          console.log(`[Reconcile] AGREGAR TAREA button candidates:`, JSON.stringify(btnResult && btnResult.debugCandidates));

          if (btnId) {
            console.log(`[Reconcile] Clicking (+) AGREGAR TAREA button #${btnId}...`);
            await page.click(`#${btnId}`).catch(() => {});
            for (let retry = 1; retry <= 10; retry++) {
              await delay(500);
              const cardsNow = await readFormCards();
              if (cardsNow.length > formCards.length) {
                console.log(`[Reconcile] New task card confirmed in DOM after ${retry * 500}ms!`);
                break;
              }
            }
          }
        }
        formCards = await readFormCards();
        console.log(`[Reconcile] After adding missing tasks: ${formCards.length} cards now in form`);
      }

      // FALLBACK DE SEGURIDAD ABSOLUTO: Si la app tiene tareas pero formCards sigue en 0, forzar la lista de tarjetas
      if (formCards.length === 0 && order.tasks.length > 0) {
        console.warn(`[Reconcile] Fallback de Seguridad: Forzando ${order.tasks.length} tarjetas virtuales para garantizar la inyección de tareas.`);
        formCards = order.tasks.map((_, idx) => ({
          index: idx,
          hours: '',
          employee: '',
          description: '',
          realizada: false,
          hasTrashBtn: false
        }));
      }

      // Match cards <-> tasks by employee+description (strict pass, then loose pass).
      // Returns { cardMatch, taskMatch } where cardMatch[ci] = matched task index (or -1) and
      // taskMatch[ai] = matched card index (or -1). Re-run whenever the DOM card order may not
      // correspond to order.tasks index order (e.g. after Taxes renders cards in a different
      // order than they were created, or after we've deleted/added cards).
      const matchCardsToTasks = (cards, tasks) => {
        const cardMatch = new Array(cards.length).fill(-1);
        const taskMatch = new Array(tasks.length).fill(-1);

        // Strict pass: both employee and description agree
        for (let ai = 0; ai < tasks.length; ai++) {
          const appTask = tasks[ai];
          const { employeeLabel } = resolveAndMapEmployee(appTask);
          for (let ci = 0; ci < cards.length; ci++) {
            if (cardMatch[ci] !== -1) continue;
            const card = cards[ci];
            const empOk = cleanStr(card.employee).includes(cleanStr(employeeLabel)) || cleanStr(employeeLabel).includes(cleanStr(card.employee));
            const descOk = cleanStr(card.description).includes(cleanStr(appTask.descripcion)) || cleanStr(appTask.descripcion).includes(cleanStr(card.description));
            if (empOk && descOk) {
              cardMatch[ci] = ai;
              taskMatch[ai] = ci;
              break;
            }
          }
        }

        // Loose pass: either employee or description agree
        for (let ai = 0; ai < tasks.length; ai++) {
          if (taskMatch[ai] !== -1) continue;
          const appTask = tasks[ai];
          const { employeeLabel } = resolveAndMapEmployee(appTask);
          for (let ci = 0; ci < cards.length; ci++) {
            if (cardMatch[ci] !== -1) continue;
            const card = cards[ci];
            const empOk = cleanStr(card.employee).includes(cleanStr(employeeLabel)) || cleanStr(employeeLabel).includes(cleanStr(card.employee));
            const descOk = cleanStr(card.description).includes(cleanStr(appTask.descripcion)) || cleanStr(appTask.descripcion).includes(cleanStr(card.description));
            if (empOk || descOk) {
              cardMatch[ci] = ai;
              taskMatch[ai] = ci;
              break;
            }
          }
        }

        return { cardMatch, taskMatch };
      };

      // 5. DELETE duplicate/extra cards
      //    Strategy: determine which cards match local tasks to keep them, then delete unmatched ones.
      const { cardMatch: initialCardMatch } = matchCardsToTasks(formCards, order.tasks);

      // Unmatched form cards are marked for deletion
      const toDeleteIndices = [];
      for (let ci = 0; ci < formCards.length; ci++) {
        if (initialCardMatch[ci] === -1) toDeleteIndices.push(ci);
      }

      if (toDeleteIndices.length > 0) {
        console.log(`[Reconcile] Deleting ${toDeleteIndices.length} extra/unmatched cards at indices: ${toDeleteIndices.join(', ')}`);
        // Delete in reverse order
        for (let di = toDeleteIndices.length - 1; di >= 0; di--) {
          const cardIdx = toDeleteIndices[di];
          page.once('dialog', d => d.accept().catch(() => {}));
          const deleted = await safeEvaluate(page, (idx) => {
            const clickConfirm = () => {
              const confirmBtn = Array.from(document.querySelectorAll('button, a, input[type="button"]')).find(b => {
                const txt = (b.textContent || '').toLowerCase().trim();
                return txt === 'aceptar' || txt === 'confirmar' || txt === 'sí' || txt === 'si' || txt === 'eliminar';
              });
              if (confirmBtn && typeof confirmBtn.click === 'function') {
                confirmBtn.click();
              }
            };

            const inputs = Array.from(document.querySelectorAll('input[id^="horas_"], input[name="horas_estimadas"]'));
            const el = inputs[idx];
            if (el) {
              let card = el.parentElement;
              while (card && card !== document.body && 
                     !card.classList.contains('card') && 
                     !card.classList.contains('form-row') && 
                     !card.classList.contains('row') &&
                     !card.className.includes('col-12')) {
                card = card.parentElement;
              }
              if (card) {
                const redBtn = card.querySelector('button.btn-danger, a.btn-danger, button.btn-outline-danger, a.btn-outline-danger, [class*="danger"]');
                if (redBtn && typeof redBtn.click === 'function') {
                  redBtn.click();
                  setTimeout(clickConfirm, 350);
                  return true;
                }
              }
            }
            const trashBtns = Array.from(document.querySelectorAll('button.btn-danger, a.btn-danger, [class*="danger"]'))
              .filter(b => b.querySelector('.fa-trash, .fa-times, .fa-remove') || b.textContent.trim() === '' || b.title?.toLowerCase().includes('elim'));
            const btn = trashBtns[idx];
            if (btn && typeof btn.click === 'function') {
              btn.click();
              setTimeout(clickConfirm, 350);
              return true;
            }
            return false;
          }, cardIdx);
          console.log(`[Reconcile] Delete card ${cardIdx}: ${deleted}`);
          if (deleted) await delay(3000);
        }
        // Re-read form after deletions
        formCards = await readFormCards();
        console.log(`[Reconcile] After deletion: ${formCards.length} cards remain`);
      }

      // Add missing cards if needed (e.g. if we deleted unmatched ones and now have fewer cards than tasks)
      let currentLength = formCards.length;
      if (currentLength < order.tasks.length) {
        const toAdd = order.tasks.length - currentLength;
        console.log(`[Reconcile] Form has ${currentLength} cards, but app has ${order.tasks.length}. Clicking AGREGAR TAREA ${toAdd} times...`);
        for (let i = 0; i < toAdd; i++) {
          const addedId = await safeEvaluate(page, () => {
            const tareasHeader = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, .card-header, div, span'))
              .find(el => (el.textContent || '').toUpperCase().includes('TAREAS A REALIZAR'));
            const btns = Array.from(document.querySelectorAll('button, a.btn, a, [role="button"], input[type="button"]'));
            const candidates = btns.filter(b => {
              const txt = (b.textContent || b.value || '').trim().toLowerCase();
              if (txt.includes('guardar') || txt.includes('cancelar') || txt.includes('volver')) return false;
              if (txt.includes('tareas a realizar')) return false;
              return txt.includes('agregar') || txt.includes('tarea') || txt === '+' || txt.includes('+ tarea');
            });
            // Mismo criterio que el resto del Reconcile: preferir el boton que aparece
            // DESPUES del encabezado 'TAREAS A REALIZAR' para no agarrar un boton
            // "Agregar..." de otra seccion de la pagina (ej. archivos) que este antes en el DOM.
            let addBtn = tareasHeader ? candidates.find(b => (tareasHeader.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) : null;
            if (!addBtn) addBtn = candidates[0];
            if (addBtn) {
              const id = 'tmp-add-task-2-' + Date.now();
              addBtn.id = id;
              addBtn.scrollIntoView({ block: 'center' });
              try { addBtn.focus(); } catch(_) {}
              try { addBtn.click(); } catch (_) {}
              ['mousedown', 'mouseup', 'click'].forEach(evtName => {
                try { addBtn.dispatchEvent(new MouseEvent(evtName, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
              });
              return id;
            }
            return null;
          });
          if (addedId) {
            await page.click(`#${addedId}`).catch(() => {});
          }
          console.log(`[Reconcile] Added task card ${i + 1}: ${!!addedId}`);
          await delay(2000);
        }
        // Re-read form cards after adding
        formCards = await readFormCards();
        console.log(`[Reconcile] After adding missing tasks: ${formCards.length} cards now in form`);
      }

      // Now that formCards.length === order.tasks.length, compute the final mapping accurately.
      // Re-match against the FINAL card set instead of assuming position i == task i: Taxes may
      // render cards in a different order than order.tasks, and blindly using identity mapping
      // here silently wrote each task's hours/description into the wrong card (e.g. task #1's
      // hours ending up on card #2), which looked "synced" but left stale/incorrect values.
      const { cardMatch: finalCardMatch, taskMatch: finalTaskMatch } = matchCardsToTasks(formCards, order.tasks);
      const cardToAppMap = [...finalCardMatch];

      // Any card still unmatched (e.g. a freshly added blank card) gets assigned to whichever
      // app task doesn't have a matched card yet, in order.
      const unmatchedTasks = [];
      for (let ai = 0; ai < order.tasks.length; ai++) {
        if (finalTaskMatch[ai] === -1) unmatchedTasks.push(ai);
      }
      let unmatchedCursor = 0;
      for (let ci = 0; ci < cardToAppMap.length; ci++) {
        if (cardToAppMap[ci] === -1 && unmatchedCursor < unmatchedTasks.length) {
          cardToAppMap[ci] = unmatchedTasks[unmatchedCursor++];
        }
      }

      console.log(`[Reconcile] Final Card to App Map:`, JSON.stringify(cardToAppMap));

      // 6. Update each remaining card with correct employee, description, hours, and realizada state
      for (let ci = 0; ci < formCards.length; ci++) {
        const appIdx = cardToAppMap[ci];
        if (appIdx === undefined || appIdx === null || appIdx < 0) continue;
        const appTask = order.tasks[appIdx];
        if (!appTask) continue;

        // Desplazamiento instantáneo (scroll into view) hacia la tarjeta de tarea en la página
        await safeEvaluate(page, (idx) => {
          const horasInputs = Array.from(document.querySelectorAll('input[id^="horas_"], input[name="horas_estimadas"]'));
          const el = horasInputs[idx];
          if (el) {
            let card = el.closest('.card, .form-row, .row, [class*="col-12"]') || el.parentElement;
            if (card) card.scrollIntoView({ behavior: 'auto', block: 'center' });
          }
        }, ci);
        await delay(300);

        // 1. Fill/Fix Centro de Costo if empty
        const ccCatalog = db.getCatalogs().centrosCosto || [];
        const ccObj = ccCatalog.find(c => c.value === appTask.centroCosto);
        const ccLabel = ccObj ? ccObj.label : appTask.centroCosto;
        console.log(`[Reconcile] Card #${ci} Centro de Costo: "${ccLabel}" (ID: ${appTask.centroCosto})`);
        await safeEvaluate(page, (idx, taskCC) => {
          const horasInputs = Array.from(document.querySelectorAll('input[id^="horas_"], input[name="horas_estimadas"]'));
          const targetHoursInput = horasInputs[idx];
          if (!targetHoursInput) return;

          let card = targetHoursInput.parentElement;
          while (card && card !== document.body && 
                 !card.classList.contains('card') && 
                 !card.classList.contains('form-row') && 
                 !card.classList.contains('row') &&
                 !card.className.includes('col-12')) {
            card = card.parentElement;
          }
          if (!card) return;

          const ccSelect = card.querySelector('select[id^="centro_costo_"], select[name*="centro_costo_id"], select');
          if (ccSelect) {
            const cleanForCompare = (str) => {
              if (!str) return '';
              return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
            };
            const cleanVal = cleanForCompare(taskCC);
            const opt = Array.from(ccSelect.options).find(o => 
              cleanForCompare(o.text).includes(cleanVal) || 
              cleanForCompare(o.value) === cleanVal
            );
            if (opt) {
              ccSelect.value = opt.value;
              ccSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        }, ci, ccLabel);
        await delay(300);

        // 2. Fill/Fix Employee if empty, placeholder, or mismatch
        const { employeeLabel } = resolveAndMapEmployee(appTask);
        const hiddenEmpValue = await safeEvaluate(page, (idx) => {
          const inp = document.querySelector(`input[name="syj_empleado_id_tarea_${idx}"], input[name$="empleado_id_tarea_${idx}"], input[name*="empleado_id_tarea_${idx}"]`);
          return inp ? inp.value : '';
        }, ci);

        const isEmpEmptyOrPlaceholder = formCards[ci].employee === '' || 
                                       formCards[ci].employee.toLowerCase().includes('seleccionar') || 
                                       formCards[ci].employee.toLowerCase().includes('buscar') ||
                                       !hiddenEmpValue;
        const isEmpMismatch = !cleanStr(formCards[ci].employee).includes(cleanStr(employeeLabel)) && 
                              !cleanStr(employeeLabel).includes(cleanStr(formCards[ci].employee));
                              
        if (isEmpEmptyOrPlaceholder || isEmpMismatch) {
          console.log(`[Reconcile] Card #${ci} employee update required. Current: "${formCards[ci].employee}". Target: "${employeeLabel}"...`);
          const empFilled = await fillTaskEmployeeSearchableSelect(page, ci, employeeLabel);
          console.log(`[Reconcile] Card #${ci} employee select result: ${empFilled}`);
          await delay(500);
        }

        // 3. Fill/Fix Description if empty or doesn't match finalDescription (including diagnostico and insumos)
        let { finalDescription } = resolveAndMapEmployee(appTask);
        if (employeeLabel && !finalDescription.toLowerCase().includes(employeeLabel.toLowerCase().trim())) {
          finalDescription = `${employeeLabel} - ${finalDescription}`;
        }
        const cleanDescTaxes = (formCards[ci].description || '').trim();
        const cleanDescTarget = (finalDescription || '').trim();
        const descMismatch = (cleanDescTaxes !== cleanDescTarget);

        if (descMismatch) {
          console.log(`[Reconcile] Card #${ci} description update required (Taxes: "${cleanDescTaxes}" → Target: "${cleanDescTarget}"). Writing...`);
          const descId = await safeEvaluate(page, (idx) => {
            const tareasHeader = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, .card-header, div, span'))
              .find(el => (el.textContent || '').toUpperCase().includes('TAREAS A REALIZAR'));

            const allTextareas = Array.from(document.querySelectorAll('textarea, textarea[name*="descripcion"], textarea[id*="descripcion"], textarea[placeholder*="Describe"]'));
            const taskTextareas = allTextareas.filter(ta => {
              if (tareasHeader) {
                return (tareasHeader.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
              }
              return ta !== allTextareas[0];
            });
            const el = taskTextareas[idx];
            if (!el) return null;
            if (!el.id) el.id = `rc-desc-${idx}-${Date.now()}`;
            return el.id;
          }, ci);

          if (descId) {
            const sel = `#${descId}`;
            console.log(`[Reconcile] Erasing and rewriting description textarea (${sel}) with: "${finalDescription}"`);
            
            await page.focus(sel).catch(() => {});
            await page.click(sel, { clickCount: 3 }).catch(() => {});

            // 1. Force DOM flush & clear
            await safeEvaluate(page, (s) => {
              const el = document.querySelector(s);
              if (el) {
                el.value = '';
                if (el.textContent !== undefined) el.textContent = '';
                if (el.innerText !== undefined) el.innerText = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, sel);

            // 2. Keyboard Control+A + Backspace + Delete
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await page.keyboard.press('Delete');
            await delay(200);

            // 3. Set exact target string via DOM and dispatch events
            await safeEvaluate(page, (s, val) => {
              const el = document.querySelector(s);
              if (el) {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
              }
            }, sel, finalDescription);

            // 4. Trigger typing space + backspace to ensure Vue v-model updates binding
            await page.type(sel, ' ', { delay: 30 }).catch(() => {});
            await page.keyboard.press('Backspace').catch(() => {});
            await delay(1000);
          } else {
            console.warn(`[Reconcile] COULD NOT FIND description element for card #${ci}!`);
          }
        }

        // 4. Fill/Fix Hours
        let expectedHoursNum = parseFloat(String(appTask.horasEstimadas || '0').replace(',', '.')) || 0;
        if (expectedHoursNum === 0 && appTask.timerHistory && Array.isArray(appTask.timerHistory) && appTask.timerHistory.length >= 1) {
          let totalMs = 0;
          const sorted = [...appTask.timerHistory].sort((a, b) => a.timestamp - b.timestamp);
          let currentStart = null;
          sorted.forEach(event => {
            const type = String(event.type || '').trim().toLowerCase();
            if (type.startsWith('inici') || type.startsWith('reanud')) {
              currentStart = event.timestamp;
            } else if (type.startsWith('paus') || type.startsWith('fin')) {
              if (currentStart !== null) { totalMs += (event.timestamp - currentStart); currentStart = null; }
            }
          });
          if (totalMs > 0) {
            expectedHoursNum = Math.round((totalMs / 3600000) * 100) / 100;
          }
        }
        const expectedHours = expectedHoursNum.toFixed(2);
        const expectedHoursNum2 = parseFloat(expectedHoursNum.toFixed(2));
        const actualHours = parseFloat(formCards[ci].hours.replace(',', '.')) || 0;
        const hoursOk = (actualHours === 0 && expectedHoursNum2 > 0) ? false : (Math.abs(expectedHoursNum2 - actualHours) <= 0.05);

        if (!hoursOk) {
          console.log(`[Reconcile] Fixing hours for card #${ci} to "${expectedHours}"...`);
          const hoursId = await safeEvaluate(page, (idx) => {
            const inputs = Array.from(document.querySelectorAll('input[id^="horas_"], input[name="horas_estimadas"]'));
            const el = inputs[idx];
            if (!el) return null;
            if (!el.id) el.id = `rc-hours-${idx}-${Date.now()}`;
            return el.id;
          }, ci);
          if (hoursId) {
            const sel = `#${hoursId}`;
            await safeEvaluate(page, (s, val) => {
              const el = document.querySelector(s);
              if (el) {
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
                if (nativeSetter && nativeSetter.set) {
                  nativeSetter.set.call(el, val);
                } else {
                  el.value = val;
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
              }
            }, sel, expectedHours);

            await page.focus(sel).catch(() => {});
            await page.click(sel, { clickCount: 3 }).catch(() => {});
            await page.keyboard.press('Backspace').catch(() => {});
            await page.type(sel, expectedHours, { delay: 50 }).catch(() => {});
            await page.keyboard.press('Tab').catch(() => {});

            await safeEvaluate(page, (s) => {
              const el = document.querySelector(s);
              if (el) {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
              }
            }, sel);
            await delay(1000);
          }
          appTask.needsHoursUpdate = false;
        }

        // 5. Fill/Fix REALIZADA state (SI/NO toggle) to strictly match app task status
        const shouldBeRealizada = (appTask.status === 'Finalizada' || appTask.realizada === true);
        const currentRealizada = formCards[ci].realizada;

        if (shouldBeRealizada !== currentRealizada) {
          console.log(`[Reconcile] Toggling Realizada for card #${ci} (current=${currentRealizada}, target=${shouldBeRealizada})...`);
          await safeEvaluate(page, (idx, targetState) => {
            const switches = Array.from(document.querySelectorAll('.custom-control.custom-switch'));
            const sw = switches[idx];
            if (!sw) return;
            const cb = sw.querySelector('input[type="checkbox"]');
            if (cb && cb.checked !== targetState) {
              const lbl = sw.querySelector('label, .custom-control-label');
              if (lbl) lbl.click(); else cb.click();
            }
          }, ci, shouldBeRealizada);
          await delay(2500);
          appTask.taxesRealizadaSynced = shouldBeRealizada;
        }

        appTask.synced = true;
        appTask.needsHoursUpdate = false;
      }

      // Merge only the sync bookkeeping flags (synced/taxesRealizadaSynced) onto the CURRENT
      // task data instead of blindly overwriting with `order.tasks` (a snapshot taken minutes
      // ago, before the browser automation ran). This sync can take a long time; if the user
      // edited the order in the app meanwhile (e.g. adding diagnóstico/insumos or fixing hours),
      // a blind overwrite here would silently erase that edit by reverting to the stale snapshot.
      {
        const freshOrder = db.getWorkOrderById(orderId);
        if (freshOrder && Array.isArray(freshOrder.tasks)) {
          const syncedById = new Map(order.tasks.map(t => [t.id, t]));
          const mergedTasks = freshOrder.tasks.map(freshTask => {
            const synced = syncedById.get(freshTask.id);
            if (!synced) return freshTask;
            return { ...freshTask, synced: synced.synced, taxesRealizadaSynced: synced.taxesRealizadaSynced };
          });
          db.updateWorkOrder(orderId, { tasks: mergedTasks });
        } else {
          db.updateWorkOrder(orderId, { tasks: order.tasks });
        }
      }

      // Fix date inputs before saving:
      // Force all date inputs to have valid formats.
      // - inputs with type="date" strictly require "yyyy-MM-dd"
      // - text inputs with date class/name require "dd/MM/yyyy"
      let targetDateIso = order.fechaEntrega || new Date().toISOString().split('T')[0];
      // Normalize to yyyy-MM-dd
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(targetDateIso)) {
        const [d, m, y] = targetDateIso.split('/');
        targetDateIso = `${y}-${m}-${d}`;
      } else if (/^\d{4}\/\d{2}\/\d{2}$/.test(targetDateIso)) {
        targetDateIso = targetDateIso.replace(/\//g, '-');
      }
      
      if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDateIso)) {
        targetDateIso = new Date().toISOString().split('T')[0]; // fallback
      }

      // regional dd/MM/yyyy format for text-based date inputs
      const [y, m, d] = targetDateIso.split('-');
      const targetDateRegional = `${d}/${m}/${y}`;

      const fixedDates = await safeEvaluate(page, (iso, regional) => {
        const fixed = [];
        // 1. Force ISO format on all HTML5 type="date" inputs
        const dateInputs = Array.from(document.querySelectorAll('input[type="date"]'));
        dateInputs.forEach(input => {
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, iso);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          fixed.push({ name: input.name || input.id || 'type=date', format: 'ISO', value: iso });
        });

        // 2. Force regional format on any text inputs related to dates
        const textInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
        textInputs.forEach(input => {
          const nameOrId = (input.name || input.id || '').toLowerCase();
          const isDateRelated = nameOrId.includes('fecha') || nameOrId.includes('date') || nameOrId.includes('entrega');
          if (isDateRelated) {
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(input, regional);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            fixed.push({ name: input.name || input.id || 'type=text', format: 'regional', value: regional });
          }
        });
        return fixed;
      }, targetDateIso, targetDateRegional);

      if (fixedDates.length > 0) {
        console.log(`[Reconcile] Normalized ${fixedDates.length} date input(s) before GUARDAR:`, JSON.stringify(fixedDates));
      }

      console.log(`[Reconcile] Pausing 4 seconds for user visual check before clicking GUARDAR...`);
      await delay(4000);
      const guardarBtnId = await safeEvaluate(page, () => {
        let btn = document.querySelector('.taxes-btn-save');
        if (!btn) {
          const allBtns = Array.from(document.querySelectorAll('button, a.btn, input[type="submit"]'));
          const candidates = allBtns.filter(b => {
            const parentHeader = b.closest('header, .navbar, .user-menu, .nav-item, .dropdown-user, [class*="user"], [class*="profile"]');
            if (parentHeader) return false;
            const txt = (b.textContent || b.value || '').trim().toLowerCase();
            return txt === 'guardar' || txt.includes('guardar');
          });
          btn = candidates.find(b => b.className.includes('btn-success') || b.className.includes('success')) || candidates[0];
        }
        if (!btn) {
          btn = document.querySelector('button[type="submit"]');
        }
        if (!btn) return null;
        const id = 'tmp-guardar-btn-' + Date.now();
        btn.id = id;
        return id;
      });
      let clickedOk = false;
      if (guardarBtnId) {
        try { 
          await page.click(`#${guardarBtnId}`); 
          clickedOk = true; 
        } catch (e) { 
          console.warn(`[Reconcile] Native click on GUARDAR raised: ${e.message} (likely navigated away, treating as success)`); 
          clickedOk = true; 
        }
      }
      console.log(`[Reconcile] Guardar button clicked: ${clickedOk}`);
      
      // Wait for backend processing and redirects
      await delay(5000);
 
      // Verify if the form was actually saved by checking if we left the edit form
      const isFormStillOpen = await safeEvaluate(page, () => {
        const formInput = document.querySelector('input[name="horas_estimadas"], textarea[id^="descripcion_"]');
        return !!formInput;
      });
 
      let validationErrors = [];
      if (isFormStillOpen) {
        // Collect validation errors only if the form remains open
        validationErrors = await safeEvaluate(page, () => {
          const alertElements = document.querySelectorAll('.alert-danger, .is-invalid, .invalid-feedback, .text-danger');
          return Array.from(alertElements)
            .map(el => el.textContent.trim())
            .filter(t => {
              if (t.length === 0 || t.length > 200 || t.includes('soporte') || t.includes('comprobante')) return false;
              // Ignore simple dates like "17/07/2026" or "17-07-2026" being matched as errors
              const isDate = /^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(t) || /^\d{4}[\/\-]\d{2}[\/\-]\d{2}$/.test(t);
              return !isDate;
            });
        });
      }
      if (isFormStillOpen) {
        const errMsg = validationErrors.length > 0
          ? `Errores de validación en la web de Taxes al guardar edición: ${validationErrors.join(" | ")}`
          : "El formulario de edición de OT no se guardó correctamente (sigue abierto tras hacer click en Guardar y no reportó errores visibles).";
        throw new Error(errMsg);
      }

      if (abandonedSyncOrderIds.has(orderId)) {
        console.log(`[SyncWorker] Orden ${orderId} fue abandonada por timeout — ignorando resultado tardío, no se toca el lock ni la base.`);
        abandonedSyncOrderIds.delete(orderId);
        if (browser) try { await browser.close(); } catch (_) {}
        return { success: false, message: 'Abandoned due to timeout' };
      }

      db.updateWorkOrder(orderId, {
        syncStatus: 'success',
        syncDate: new Date().toISOString(),
        syncError: null,
        autoSyncRetryCount: 0
      });

      console.log(`[Reconcile] Running verification for OT #${order.interno}...`);
      try {
        await verifyWorkOrderWithPage(page, orderId);
      } catch (verifyErr) {
        console.error(`[Post-Sync Verify] Falló la verificación automática para orden ${orderId}:`, verifyErr.message);
        db.updateWorkOrder(orderId, { verifiedStatus: 'error', verifiedError: `Auto-control falló: ${verifyErr.message}` });
      }

      await browser.close(); releaseBrowserLock();
      try { db.purgeSyncedOrders(5); } catch(pe) { console.error('[Purge] Error:', pe.message); }
      return { success: true, message: `Orden ${otNumClean} reconciliada correctamente.` };
    }



    console.log("Navigating directly to Ordenes de Trabajo list page...");
    await safeGoto(page, `${settings.portalUrl}/tms/produccion/ot`, { timeout: 30000 });
    
    // Wait for the portal page catalogs/dropdowns to load completely
    await page.waitForSelector('select', { timeout: 10000 }).catch(() => {});
    await delay(1000); // Small extra buffer to be sure Vue is ready

    // PRE-CREATION SAFEGUARD: Check if an OT already exists in Taxes for this Interno ON TODAY'S DATE before creating a new one!
    if (order.interno) {
      // Use explicit Argentina timezone, NOT the process's local/system timezone (Railway
      // containers default to UTC). Argentina is UTC-3, so any order created roughly between
      // 21:00 and 23:59 local time falls on 00:00-02:59 UTC THE NEXT DAY — computing the date
      // with getDate()/getMonth()/getFullYear() would silently shift it by one day, the
      // safeguard would then fail to match the OT Taxes actually shows under today's (Argentina)
      // date, and a duplicate OT gets created. This is almost certainly why "me duplicaba
      // órdenes" happened — it lines up with evening-created orders.
      const targetDateObj = order.createdAt ? new Date(order.createdAt) : new Date();
      const todayDateStr = targetDateObj.toLocaleDateString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        day: '2-digit', month: '2-digit', year: 'numeric'
      });

      console.log(`[Pre-Check Safeguard] Filtering OT list page (Limit 500, Date: ${todayDateStr})...`);
      try {
        const filterApplied = await safeEvaluate(page, (targetDate) => {
          let updatedAny = false;

          // 1. Set Limite to 500
          const inputs = Array.from(document.querySelectorAll('input'));
          const limitInput = inputs.find(inp => {
            const name = (inp.name || '').toLowerCase();
            const id = (inp.id || '').toLowerCase();
            const placeholder = (inp.placeholder || '').toLowerCase();
            const parentText = inp.parentElement ? inp.parentElement.textContent.toLowerCase() : '';
            return name.includes('limite') || id.includes('limite') || placeholder.includes('limite') || parentText.includes('limite');
          });
          if (limitInput) {
            limitInput.value = '500';
            limitInput.dispatchEvent(new Event('input', { bubbles: true }));
            limitInput.dispatchEvent(new Event('change', { bubbles: true }));
            updatedAny = true;
          }

          // 2. Set Fecha Desde / Fecha Hasta to targetDate (todayDateStr)
          const dateInputs = inputs.filter(inp => {
            const name = (inp.name || '').toLowerCase();
            const id = (inp.id || '').toLowerCase();
            const placeholder = (inp.placeholder || '').toLowerCase();
            const type = (inp.type || '').toLowerCase();
            const parentText = inp.parentElement ? inp.parentElement.textContent.toLowerCase() : '';
            return type === 'date' || name.includes('fecha') || id.includes('fecha') || placeholder.includes('fecha') || parentText.includes('fecha') || name.includes('desde') || name.includes('hasta');
          });

          const parts = targetDate.split('/');
          const isoDate = parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : targetDate;
          for (const dInp of dateInputs) {
            dInp.value = dInp.type === 'date' ? isoDate : targetDate;
            dInp.dispatchEvent(new Event('input', { bubbles: true }));
            dInp.dispatchEvent(new Event('change', { bubbles: true }));
            updatedAny = true;
          }

          // 3. Click BUSCAR button
          const buttons = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
          const searchBtn = buttons.find(b => {
            const text = (b.textContent || b.value || '').trim().toUpperCase();
            return text === 'BUSCAR' || text.includes('BUSCAR');
          });

          if (searchBtn) {
            searchBtn.click();
            return true;
          }

          return updatedAny;
        }, todayDateStr);

        if (filterApplied) {
          console.log("[Pre-Check Safeguard] Filter inputs set and BUSCAR clicked. Waiting 2.5s for table refresh...");
          await delay(2500);
        } else {
          console.warn("[Pre-Check Safeguard] Could not locate filter elements, proceeding with existing table scan...");
        }
      } catch (filterErr) {
        console.warn("[Pre-Check Safeguard] Filter step encountered warning, proceeding with scan:", filterErr.message);
      }

      console.log(`[Pre-Check Safeguard] Searching OT list table for pre-existing OT for Interno ${order.interno} (Clasificación: ${order.clasificacion}) on date ${todayDateStr}...`);
      const existingOtOnPage = await safeEvaluate(page, (targetInterno, targetClasif, targetDateStr) => {
        const clean = s => (s || '').toString().trim();
        const normalizeDateStr = (str) => {
          const parts = (str || '').match(/\d+/g);
          if (!parts || parts.length < 3) return '';
          const d = parseInt(parts[0], 10);
          const m = parseInt(parts[1], 10);
          const y = parts[2].length === 2 ? 2000 + parseInt(parts[2], 10) : parseInt(parts[2], 10);
          return `${d}-${m}-${y}`;
        };
        const targetNorm = normalizeDateStr(targetDateStr);
        const targetCleanInt = clean(targetInterno).toUpperCase();
        const targetCleanClasif = clean(targetClasif).toUpperCase();

        const tables = Array.from(document.querySelectorAll('table'));
        for (const table of tables) {
          const rows = Array.from(table.querySelectorAll('tbody tr'));
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td')).map(c => clean(c.textContent));
            if (cells.length >= 3) {
              const rowDate = cells[0] || '';
              const rowInterno = cells[1] || cells[0] || '';
              const rowOt = cells[2] || cells[1] || '';
              const rowClasif = cells[4] || cells[3] || '';

              const isSameInterno = clean(rowInterno).toUpperCase() === targetCleanInt ||
                                   clean(rowOt).toUpperCase().includes(targetCleanInt);
              const isSameClasif = !targetCleanClasif || clean(rowClasif).toUpperCase().includes(targetCleanClasif) || targetCleanClasif.includes(clean(rowClasif).toUpperCase());
              const rowDateNorm = normalizeDateStr(rowDate);
              const isSameDate = !targetNorm || !rowDateNorm || rowDateNorm === targetNorm || rowDate.includes(targetDateStr);

              if (isSameInterno && isSameClasif && isSameDate && rowOt.length >= 3 && /^\d+$/.test(rowOt.replace(/\D/g, ''))) {
                return rowOt.replace(/\D/g, '');
              }
            }
          }
        }
        return null;
      }, order.interno, order.clasificacion || '', todayDateStr);

      if (existingOtOnPage) {
        console.log(`[Pre-Check Safeguard] Found pre-existing OT #${existingOtOnPage} for Interno ${order.interno} on date ${todayDateStr} in Taxes! Linking and switching to reconciliation...`);
        db.updateWorkOrder(orderId, { taxesOrderNumber: existingOtOnPage });
        await browser.close(); releaseBrowserLock();
        return await syncWorkOrder(orderId);
      }
    }

    console.log("Closing any pre-existing toast notifications...");
    await safeEvaluate(page, () => {
      const closeButtons = Array.from(document.querySelectorAll('.toast button.close, .b-toast button.close, .toast .close, .b-toast .close, .toast button, .b-toast button'));
      closeButtons.forEach(btn => btn.click());
    }).catch(() => {});
    await delay(1000);

    console.log("Clicking NUEVO button to open create form modal...");
    const nuevoClicked = await safeEvaluate(page, () => {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      for (const btn of buttons) {
        const text = btn.textContent.trim().toUpperCase();
        if (text === 'NUEVO' || text === 'NUEVA') {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!nuevoClicked) {
      throw new Error("No se pudo encontrar el botón NUEVO en la página de Órdenes de Trabajo.");
    }
    
    console.log("Waiting for modal form fields to load...");
    await page.waitForSelector('.searchable-input', { timeout: 10000 });
    await delay(2000); // Extra safety delay for Vue to finish mounting searchable selects

    // 3. FILL OUT GENERAL DATA (Datos Generales)
    console.log("Filling General Data form fields...");

    // Resolve "AUTO" Responsable to currently logged-in user
    // Also treat email addresses as AUTO (e.g. paniol@contenedoreshugo.com.ar stored by mistake)
    let targetResponsable = order.responsable;
    const isEmailOrAuto = !targetResponsable || targetResponsable === 'AUTO' || targetResponsable.includes('@');
    if (isEmailOrAuto) {
      console.log("Resolving Responsable automatically...");
      const profileName = await safeEvaluate(page, () => {
        const el = document.querySelector('.user-profile-name, .user-profile-toggle, .user-profile-info, .profile-user, .user-profile, .user-name, .nav-item .nav-link span, .dropdown-toggle');
        return el ? el.textContent.trim() : '';
      });
      console.log("Logged-in user profile name detected:", profileName);

      const list = db.getCatalogs().responsables || [];
      let matched = null;
      
      const cleanText = (str) => {
        if (!str) return '';
        return str.normalize("NFD")
                  .replace(/[\u0300-\u036f]/g, "")
                  .toLowerCase()
                  .replace(/[^a-z0-9]/g, "");
      };

      if (profileName) {
        const cleanedProfile = cleanText(profileName);
        console.log("Cleaned profile name for search:", cleanedProfile);
        matched = list.find(r => {
          const cleanedLabel = cleanText(r.label);
          return cleanedLabel.includes(cleanedProfile) || cleanedProfile.includes(cleanedLabel);
        });
      }
      
      if (!matched && username) {
        const prefix = username.split('@')[0].toLowerCase().trim();
        const cleanedPrefix = cleanText(prefix);
        
        // 1. Exact/partial match with full prefix (e.g. jcarmona)
        matched = list.find(r => cleanText(r.label).includes(cleanedPrefix));
        
        // 2. Try match with prefix minus first letter (e.g. jcarmona -> carmona)
        if (!matched && prefix.length > 3) {
          const suffix = cleanText(prefix.substring(1));
          matched = list.find(r => cleanText(r.label).includes(suffix));
        }
        
        // 3. Try splitting by dot/hyphen/underscore (e.g. j.carmona -> carmona)
        if (!matched) {
          const parts = prefix.split(/[\._\-]/).filter(p => p.length >= 3);
          if (parts.length > 0) {
            matched = list.find(r => {
              const cleanedLabel = cleanText(r.label);
              return parts.some(part => cleanedLabel.includes(cleanText(part)));
            });
          }
        }
      }

      // Explicit search for Belocures if no match was found yet
      if (!matched) {
        matched = list.find(r => {
          const lbl = r.label.toLowerCase();
          return lbl.includes('belocures') || lbl.includes('cesar');
        });
      }

      if (matched) {
        targetResponsable = matched.label;
        console.log("Automatically selected matching Responsable:", targetResponsable);
      } else {
        // Fallback: always use Belocures (the global account owner)
        const defaultBelocures = list.find(r => r.label.toLowerCase().includes('belocures'));
        targetResponsable = defaultBelocures ? defaultBelocures.label : (list.length > 0 ? list[0].label : "Belocures, Cesar Hernán");
        console.log("Fallback to Belocures as default Responsable:", targetResponsable);
      }
    }

    // Fill searchable select fields (Rodado and Responsable)
    let rodadoFilled = await fillSearchableSelect(page, 'Rodado', order.rodado);
    if (!rodadoFilled && order.interno) {
      console.warn(`[Rodado] Selection with full name "${order.rodado}" failed. Trying search by Interno "${order.interno}"...`);
      rodadoFilled = await fillSearchableSelect(page, 'Rodado', String(order.interno).trim());
    }
    if (!rodadoFilled && order.interno) {
      console.warn(`[Rodado] Searchable select failed. Attempting native select fallback for Interno ${order.interno}...`);
      rodadoFilled = await safeEvaluate(page, (internoNum) => {
        const sel = document.querySelector('select[name="rodado_id"], select#rodado_id, select.rodado-select');
        if (!sel) return false;
        const cleanInt = String(internoNum).trim().toLowerCase();
        const opts = Array.from(sel.options);
        const matched = opts.find(o => {
          const txt = o.textContent.toLowerCase();
          return txt.includes(`interno ${cleanInt}`) || txt.includes(` ${cleanInt} `) || txt.startsWith(`${cleanInt} `) || txt.startsWith(`${cleanInt}-`) || txt.endsWith(` ${cleanInt}`);
        });
        if (matched) {
          sel.value = matched.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }, order.interno);
    }
    if (!rodadoFilled) {
      console.warn(`[Rodado] Primary rodado selection failed for "${order.rodado}". Attempting fallback with first catalog vehicle...`);
      const catalogs = db.getCatalogs();
      const firstRodado = (catalogs.rodados && catalogs.rodados.length > 0) ? (catalogs.rodados[0].label || catalogs.rodados[0].value) : "1";
      rodadoFilled = await fillSearchableSelect(page, 'Rodado', firstRodado);
    }
    if (!rodadoFilled) throw new Error("No se pudo seleccionar el Rodado. Asegúrese de que el valor sea válido.");

    let respFilled = await fillSearchableSelect(page, 'Responsable', targetResponsable);
    if (!respFilled) {
      console.log("Primary Responsable selection failed, trying fallback search with 'Belocures'...");
      respFilled = await fillSearchableSelect(page, 'Responsable', 'Belocures');
    }
    if (!respFilled) {
      console.log("Secondary Responsable selection failed, trying fallback search with 'Cesar'...");
      respFilled = await fillSearchableSelect(page, 'Responsable', 'Cesar');
    }
    if (!respFilled) throw new Error("No se pudo seleccionar el Responsable. Asegúrese de que el valor sea válido.");

    // Fill standard fields (Clasificacion, Interno, Date, Horario, Incidente)
    console.log("Filling standard fields (Clasificación, Interno, Date, Horario, Incidente)...");
    
    // Fill Fecha (Set both visible and hidden)
    await safeEvaluate(page, (dateVal) => {
      // Set the visible date input
      const dateInput = document.querySelector('input[type="date"].taxes-datepicker');
      if (dateInput) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(dateInput, dateVal);
        dateInput.dispatchEvent(new Event('input', { bubbles: true }));
        dateInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      // Also set the hidden fecha input
      const hiddenFecha = document.querySelector('input[name="fecha"]');
      if (hiddenFecha) {
        hiddenFecha.value = dateVal;
        hiddenFecha.dispatchEvent(new Event('input', { bubbles: true }));
        hiddenFecha.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, order.fechaEntrega);

    // Fill Horario (Timepicker)
    const orderTime = order.horario || new Date().toTimeString().substring(0, 5);
    await safeEvaluate(page, (time) => {
      // Try finding the time input directly
      const timeInputs = document.querySelectorAll('input[type="time"]');
      timeInputs.forEach(ti => {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(ti, time);
        ti.dispatchEvent(new Event('input', { bubbles: true }));
        ti.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // Also try the b-form-timepicker hidden input
      const hiddenTimeInputs = document.querySelectorAll('input[type="hidden"]');
      hiddenTimeInputs.forEach(hi => {
        if (hi.id && hi.id.includes('timepicker')) {
          hi.value = time;
          hi.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    }, orderTime);

    // Fill Titulo, Clasificación, and Incidente (Descripción)
    await safeEvaluate(page, (clasificacionVal, internoVal, incidenteVal) => {
      // Classification select (name: inv_ot_clasificacion_id)
      const classSelect = document.querySelector('select[name="inv_ot_clasificacion_id"]');
      if (classSelect) {
        const cleanForCompare = (str) => {
          if (!str) return '';
          return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        };
        const cleanVal = cleanForCompare(clasificacionVal);
        const option = Array.from(classSelect.options).find(opt => 
          cleanForCompare(opt.text).includes(cleanVal) || 
          cleanForCompare(opt.value) === cleanVal
        );
        if (option) {
          classSelect.value = option.value;
          classSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // Interno Unidad input (name: titulo)
      const internoInput = document.querySelector('input[name="titulo"]');
      if (internoInput) {
        internoInput.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(internoInput, internoVal);
        internoInput.dispatchEvent(new Event('input', { bubbles: true }));
        internoInput.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Incidente textarea (name: descripcion)
      const descTextarea = document.querySelector('textarea[name="descripcion"]');
      if (descTextarea) {
        descTextarea.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(descTextarea, incidenteVal);
        descTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        descTextarea.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, order.clasificacion, order.interno, order.incidente || '');

    await delay(1000);

    // 4. ADD TASKS (Tareas a Realizar)
    console.log(`Adding ${order.tasks.length} tasks...`);
    for (let i = 0; i < order.tasks.length; i++) {
      const task = order.tasks[i];
      console.log(`Adding Task #${i+1}: ${task.descripcion}`);

      // Resolve employee name and handle custom fallbacks (like mapping to Vera)
      const { employeeLabel, finalDescription } = resolveAndMapEmployee(task);

      // Resolve centro costo label to match dynamically on portal
      const ccCatalog = db.getCatalogs().centrosCosto || [];
      const ccObj = ccCatalog.find(c => c.value === task.centroCosto);
      const ccLabel = ccObj ? ccObj.label : task.centroCosto;
      console.log(`Resolved centro costo ID "${task.centroCosto}" to label: "${ccLabel}"`);

      // Click "AGREGAR TAREA" button
      const clickedAddTask = await clickByText(page, 'AGREGAR TAREA', 'button') ||
                             await clickByText(page, 'Agregar Tarea', 'button') ||
                             await clickByText(page, 'AGREGAR', 'button');
                             
      if (!clickedAddTask) {
        // Fallback search button containing plus sign or word Tarea
        await safeEvaluate(page, () => {
          const btns = Array.from(document.querySelectorAll('button'));
          const addBtn = btns.find(b => b.textContent.includes('TAREA') || b.textContent.includes('Tarea') || b.textContent.includes('+'));
          if (addBtn) addBtn.click();
        });
      }
      
      await delay(1500); // Wait for task form to expand

      try {
        const diagFs = require('fs');
        const diagPath = require('path');
        const diagHtml = await page.content();
        diagFs.writeFileSync(diagPath.join(__dirname, 'public', 'debug_task_card.html'), diagHtml);
        const diagInfo = await safeEvaluate(page, () => {
          const els = Array.from(document.querySelectorAll('select, textarea, input')).filter(el => {
            const idn = (el.id || '') + (el.name || '');
            return /costo|descripcion|horas|empleado|tarea/i.test(idn) || el.tagName === 'TEXTAREA';
          });
          return els.slice(0, 30).map(el => ({ tag: el.tagName, id: el.id || null, name: el.name || null, className: el.className || null }));
        });
        diagFs.writeFileSync(diagPath.join(__dirname, 'public', 'debug_task_card.json'), JSON.stringify(diagInfo, null, 2));
        console.log('[DEBUG-TASKCARD] Saved debug_task_card.html/.json. clickedAddTask was:', clickedAddTask);
      } catch (diagErr) {
        console.warn('[DEBUG-TASKCARD] Failed:', diagErr.message);
      }

      // 1. Select Centro de Costo
      console.log(`Setting Centro de Costo to: "${task.centroCosto}" (label: "${ccLabel}")`);
      const ccSelectSelector = `select#centro_costo_${i}`;
      await page.waitForSelector(ccSelectSelector, { timeout: 5000 });
      await safeEvaluate(page, (sel, taskCC) => {
        const ccSelect = document.querySelector(sel);
        if (ccSelect) {
          const cleanForCompare = (str) => {
            if (!str) return '';
            return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
          };
          const cleanVal = cleanForCompare(taskCC);
          const opt = Array.from(ccSelect.options).find(o => 
            cleanForCompare(o.text).includes(cleanVal) || 
            cleanForCompare(o.value) === cleanVal
          );
          if (opt) {
            ccSelect.value = opt.value;
            ccSelect.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }, ccSelectSelector, ccLabel);

      // Wait for any AJAX/Vue update
      await delay(2000);

      // 2. Select Employee (Searchable select)
      const empFilled = await fillTaskEmployeeSearchableSelect(page, i, employeeLabel);
      if (!empFilled) {
        throw new Error(`No se pudo seleccionar el Empleado para la tarea ${i+1}.`);
      }

      // 3. Fill Hours — input[name="horas_estimadas"], type="number", index i
      // horasEstimadas is stored as decimal hours directly from the timer (e.g., 0.55 = 0.55h = 33 min).
      // NO conversion needed — use the value as-is.
      let effectiveHoras = parseFloat(String(task.horasEstimadas || '0').replace(',', '.')) || 0;
      if (effectiveHoras === 0 && task.timerHistory && Array.isArray(task.timerHistory) && task.timerHistory.length >= 1) {
        // Sum up all (Inició/Reanudó → Pausó/Fin) pairs in the timer history
        let totalMs = 0;
        const sorted = [...task.timerHistory].sort((a, b) => a.timestamp - b.timestamp);
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
        if (totalMs > 0) {
          effectiveHoras = Math.round((totalMs / 3600000) * 100) / 100; // real decimal hours from ms
          console.log(`[Hours] Using timer-derived decimal hours: ${effectiveHoras}h (${totalMs}ms) for task #${i+1}`);
        }
      }
      // Minimum 0.01 hours if the task was completed (to avoid sending 0 which appears blank in Taxes)
      if (effectiveHoras === 0 && task.status === 'Finalizada') {
        effectiveHoras = 0.01;
        console.log(`[Hours] Task #${i+1} Finalizada with 0 hours — using minimum 0.01 to avoid blank in Taxes.`);
      }

      // HTML5 type="number" inputs programmatically require period (.) as the decimal separator under the W3C spec,
      // regardless of browser locale display. headless Chromium on Railway uses en-US locale and expects period.
      const hoursVal3 = effectiveHoras.toFixed(2);
      console.log(`[Hours] Target Horas Estimadas for task #${i+1}: "${hoursVal3}"`);

      // Resolve input ID
      const hoursInputId = await safeEvaluate(page, (idx) => {
        const inputs = Array.from(document.querySelectorAll('input[id^="horas_"], input[name="horas_estimadas"]'));
        const el = inputs[idx];
        if (!el) return null;
        if (!el.id) el.id = `temp-horas-${idx}-${Date.now()}`;
        return el.id;
      }, i);

      let hoursFilled = false;
      if (hoursInputId) {
        console.log(`[Hours] Found hours input at index ${i}. Focusing and typing value "${hoursVal3}"...`);
        const sel = `#${hoursInputId}`;

        // Attempt 1: keyboard simulation (standard approach)
        await page.focus(sel).catch(() => {});
        await page.click(sel, { clickCount: 3 }).catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await page.type(sel, hoursVal3, { delay: 50 });
        await page.keyboard.press('Tab').catch(() => {}); // Force Vue blur to persist the value
        await safeEvaluate(page, (s) => {
          const el = document.querySelector(s);
          if (el) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          }
        }, sel);

        await delay(800);

        // Verification step — re-read the input to confirm the value stuck
        const hoursVerify = await safeEvaluate(page, (s) => {
          const el = document.querySelector(s);
          if (!el) return { found: false };
          return { found: true, value: el.value };
        }, sel).catch(() => ({ found: false }));

        hoursFilled = hoursVerify.found && Math.abs(parseFloat(String(hoursVerify.value).replace(',', '.')) - parseFloat(String(hoursVal3).replace(',', '.'))) < 0.005;
        console.log(`[Hours] Verification attempt 1 — value: "${hoursVerify.value}", expected: "${hoursVal3}", success: ${hoursFilled}`);

        // Attempt 2 (fallback): use Vue-compatible native setter if value didn't stick
        if (!hoursFilled) {
          console.log(`[Hours] Attempt 1 failed. Retrying with Vue-native setter for index ${i}...`);
          await safeEvaluate(page, (s, val) => {
            const el = document.querySelector(s);
            if (!el) return;
            // Use HTMLInputElement native setter to bypass Vue's internal value caching
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            if (nativeSetter && nativeSetter.set) {
              nativeSetter.set.call(el, val);
            } else {
              el.value = val;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          }, sel, hoursVal3);
          await delay(500);

          const hoursVerify2 = await safeEvaluate(page, (s) => {
            const el = document.querySelector(s);
            if (!el) return { found: false };
            return { found: true, value: el.value };
          }, sel).catch(() => ({ found: false }));

          hoursFilled = hoursVerify2.found && Math.abs(parseFloat(String(hoursVerify2.value).replace(',', '.')) - parseFloat(String(hoursVal3).replace(',', '.'))) < 0.005;
          console.log(`[Hours] Verification attempt 2 — value: "${hoursVerify2.value}", expected: "${hoursVal3}", success: ${hoursFilled}`);
        }
      } else {
        console.warn(`[Hours] Could not locate input[name="horas_estimadas"] at index ${i}`);
      }

      console.log(`Horas filled: ${hoursFilled}, value: ${hoursVal3}, inputs found: via querySelectorAll`);

      // 4. Fill Description
      console.log(`Setting Descripción: "${finalDescription}"`);
      const descSelector = `textarea#descripcion_${i}`;
      await page.focus(descSelector);
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.type(descSelector, finalDescription, { delay: 50 });

      await delay(1000);

      // 5. Set Task Status (Toggle Switch if status is "Finalizada")
      // The toggle switch is a Bootstrap Vue custom-switch at the top of each task card.
      // We find ALL switches on the page and use the task index to select the right one.
      console.log(`Setting Task Status for task #${i+1}. Current db status: "${task.status}"`);
      if (task.status && task.status.toLowerCase() === 'finalizada') {
        console.log(`Task #${i+1} is Finalizada, toggling switch to Tarea Completada...`);
        const toggled = await safeEvaluate(page, (index) => {
          // Find all custom-switch containers on the page
          const allSwitches = Array.from(document.querySelectorAll('.custom-control.custom-switch'));
          // The i-th switch corresponds to the i-th task
          const targetSwitch = allSwitches[index];
          if (!targetSwitch) return { success: false, error: `Switch #${index} not found. Total switches: ${allSwitches.length}` };

          const checkbox = targetSwitch.querySelector('input[type="checkbox"]');
          if (!checkbox) return { success: false, error: 'Checkbox input not found inside switch' };

          if (!checkbox.checked) {
            // Click the label to toggle (Bootstrap Vue requires label click for proper reactivity)
            const label = targetSwitch.querySelector('label');
            if (label) {
              label.click();
              return { success: true, method: 'label_click', wasChecked: false };
            } else {
              // Fallback: direct checkbox click + change event
              checkbox.checked = true;
              checkbox.dispatchEvent(new Event('change', { bubbles: true }));
              checkbox.dispatchEvent(new Event('input', { bubbles: true }));
              return { success: true, method: 'checkbox_direct', wasChecked: false };
            }
          }
          return { success: true, method: 'already_checked', wasChecked: true };
        }, i);
        console.log(`   Toggle result:`, JSON.stringify(toggled));
        await delay(1500);

        // Verify the toggle state after clicking
        const verifyState = await safeEvaluate(page, (index) => {
          const allSwitches = Array.from(document.querySelectorAll('.custom-control.custom-switch'));
          const targetSwitch = allSwitches[index];
          if (!targetSwitch) return { verified: false };
          const checkbox = targetSwitch.querySelector('input[type="checkbox"]');
          const label = targetSwitch.querySelector('label');
          return {
            verified: true,
            checked: checkbox ? checkbox.checked : false,
            labelText: label ? label.textContent.trim() : ''
          };
        }, i);
        console.log(`   Verification: checked=${verifyState.checked}, label="${verifyState.labelText}"`);
      } else {
        console.log(`Task #${i+1} is Pendiente, leaving switch as default.`);
      }

      await delay(1000);
    }

    // 5. SUBMIT FORM
    console.log("Saving the Work Order on the website...");
    const saved = await safeEvaluate(page, () => {
      const btn = document.querySelector('.taxes-btn-save');
      if (btn) {
        btn.click();
        return true;
      }
      const buttons = Array.from(document.querySelectorAll('button'));
      const guardar = buttons.find(b => b.textContent.trim() === 'Guardar');
      if (guardar) {
        guardar.click();
        return true;
      }
      return false;
    });
                  
    if (!saved) {
      const fallbackClicked = await clickByText(page, 'Guardar', 'button') ||
                              await clickByText(page, 'Crear Orden', 'button') ||
                              await page.click('button[type="submit"]').then(() => true).catch(() => false);
      if (!fallbackClicked) throw new Error("No se pudo encontrar el botón de Guardar.");
    }

    // Wait for submission response
    await page.waitForNavigation({ waitUntil: 'load', timeout: 15000 }).catch(() => {});
    await delay(5000); // 5 seconds wait to let backend finish writing and redirecting

    // 6. VERIFY SUCCESS
    console.log("Verifying if the order was created successfully...");
    const currentUrl = page.url();
    const errors = await safeEvaluate(page, () => {
      // Filter out global informative banners, only check real invalid field labels or error popups
      const alertElements = document.querySelectorAll('.alert-danger, .is-invalid, .invalid-feedback, .text-danger');
      return Array.from(alertElements)
        .map(el => el.textContent.trim())
        .filter(t => t.length > 0 && t.length < 200 && !t.includes('soporte') && !t.includes('comprobante'));
    });

    const isModalClosed = await safeEvaluate(page, () => {
      const form = document.querySelector('input[name="rodado_id"]');
      return !form;
    });

    if (errors.length > 0 && !isModalClosed) {
      throw new Error("Errores de validación en la web de Taxes: " + errors.join(" | "));
    }

    if (!currentUrl.includes('/ot') || !isModalClosed) {
      throw new Error("El formulario no se guardó correctamente en Taxes.com.ar (sigue abierto o no se redirigió).");
    }

    // Extract Taxes OT number from green toast notifications
    console.log("Looking for Taxes Work Order Number from toast notifications...");
    const taxesOrderNumber = await safeEvaluate(page, () => {
      const elements = Array.from(document.querySelectorAll('.toast, .b-toast, .alert, div, p, span'));
      const found = [];
      for (const el of elements) {
        const text = el.textContent.trim();
        const match = text.match(/Orden de Trabajo N\s*(\d+)\s*Creada/i) ||
                      text.match(/Orden\s*N\s*(\d+)/i) ||
                      text.match(/N\s*(\d+)\s*Creada/i);
        if (match && match[1]) found.push(parseInt(match[1], 10));
      }
      if (found.length === 0) return null;
      return String(Math.max(...found));
    });

    let finalTaxesOrderNumber = taxesOrderNumber;
    if (finalTaxesOrderNumber) {
      console.log(`Successfully captured Taxes Order Number: ${finalTaxesOrderNumber}`);
    } else {
      console.log("Warning: Could not capture Taxes Order Number from toast notifications. Attempting fallback search on list page...");
      try {
        await safeGoto(page, `${settings.portalUrl}/tms/produccion/ot`, { timeout: 20000 });
        await delay(2000);
        const capturedFromList = await safeEvaluate(page, (rodadoVal) => {
          const rows = Array.from(document.querySelectorAll('table tbody tr'));
          for (const row of rows) {
            const text = row.textContent || '';
            if (text && rodadoVal && text.toLowerCase().includes(rodadoVal.toLowerCase().substring(0, 5))) {
              const otMatch = text.match(/(\d{4,6})/);
              if (otMatch) return otMatch[1];
            }
          }
          if (rows.length > 0) {
            const firstRowText = rows[0].textContent || '';
            const match = firstRowText.match(/(\d{4,6})/);
            if (match) return match[1];
          }
          return null;
        }, order.rodado);
        if (capturedFromList) {
          finalTaxesOrderNumber = capturedFromList;
          console.log(`Successfully captured Taxes Order Number from list page fallback: ${finalTaxesOrderNumber}`);
        }
      } catch (fallbackErr) {
        console.log("Fallback search for Taxes Order Number failed:", fallbackErr.message);
      }
    }

    // Close any visible toast notifications by clicking close button inside them
    await safeEvaluate(page, () => {
      const closeButtons = Array.from(document.querySelectorAll('.toast button.close, .b-toast button.close, .toast .close, .b-toast .close, .toast button, .b-toast button'));
      closeButtons.forEach(btn => btn.click());
    }).catch(() => {});

    console.log(`Sync success for OT #${order.interno}!`);
    
    // Mark all initial tasks as synced
    const updatedTasks = order.tasks.map(t => {
      let taxesRealizadaSynced = t.taxesRealizadaSynced === true;
      if (t.status === "Finalizada") {
        taxesRealizadaSynced = true;
      }
      return {
        ...t,
        synced: true,
        taxesRealizadaSynced: taxesRealizadaSynced
      };
    });

    if (abandonedSyncOrderIds.has(orderId)) {
      console.log(`[SyncWorker] Orden ${orderId} fue abandonada por timeout — ignorando resultado tardío, no se toca el lock ni la base.`);
      abandonedSyncOrderIds.delete(orderId);
      if (browser) try { await browser.close(); } catch (_) {}
      return { success: false, message: 'Abandoned due to timeout' };
    }

    db.updateWorkOrder(orderId, {
      syncStatus: "success",
      syncDate: new Date().toISOString(),
      syncError: null,
      autoSyncRetryCount: 0,
      taxesOrderNumber: finalTaxesOrderNumber || null,
      tasks: updatedTasks
    });

    console.log(`Running post-sync verification for brand new OT #${order.interno}...`);
    try {
      await verifyWorkOrderWithPage(page, orderId);
    } catch (verifyErr) {
      console.error(`[Post-Sync Verify] Falló la verificación automática para orden ${orderId}:`, verifyErr.message);
      db.updateWorkOrder(orderId, { verifiedStatus: 'error', verifiedError: `Auto-control falló: ${verifyErr.message}` });
    }

    return { success: true, message: `Orden ${order.interno} sincronizada correctamente.` };

  } catch (error) {
    console.error(`Sync failed for OT #${order.interno}:`, error);
    if (abandonedSyncOrderIds.has(orderId)) {
      console.log(`[SyncWorker] Orden ${orderId} fue abandonada por timeout — ignorando resultado tardío, no se toca el lock ni la base.`);
      abandonedSyncOrderIds.delete(orderId);
      return { success: false, message: 'Abandoned due to timeout' };
    }
    if (browser) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) {
          await pages[0].screenshot({ path: 'public/last_sync_error.png', fullPage: true });
          console.log("Saved debug screenshot to public/last_sync_error.png");
        }
      } catch (screenshotErr) {
        console.error("Failed to take error screenshot:", screenshotErr.message);
      }
    }
    db.updateWorkOrder(orderId, {
      syncStatus: "error",
      syncError: error.message,
      autoSyncRetryCount: (order.autoSyncRetryCount || 0) + 1,
      lastAutoSyncAttempt: new Date().toISOString()
    });
    return { success: false, message: error.message };
  } finally {
    // Liberar los candados pase lo que pase (éxito o falla)
    const claveCandado = `${order.interno}_${order.clasificacion}`;
    candadoInternosActivos.delete(claveCandado);
    releaseBrowserLock();
    if (browser) try { await browser.close(); } catch (_) {}
  }
}

// 2b. AGENT VERIFICATION SYSTEM FOR OT TASKS (DISABLED)
async function verifyWorkOrderWithPage(page, orderId) {
  console.log(`[Verify] Acceso a /tms/produccion/tareas deshabilitado por directiva. Todas las tareas se gestionan únicamente en /tms/produccion/ot vía Lápiz (Editar).`);
  return;
}
async function verifyWorkOrder(orderId) {
  const order = db.getWorkOrderById(orderId);
  if (!order) return { success: false, message: "Order not found" };
  const settings = db.getSettings();

  // SIEMPRE usar credenciales globales de Ajustes
  const username = settings.username;
  const password = settings.password;

  if (!username || !password) {
    return { success: false, message: "Faltan las credenciales en Ajustes. Configurá el usuario y contraseña de Taxes." };
  }

  await acquireBrowserLock(`verifyWorkOrder(${orderId})`);
  let browser = null;
  const isFrameDetachError = (err) => {
    const msg = (err && err.message) || '';
    return msg.includes('detached Frame') || msg.includes('Execution context was destroyed') || msg.includes('frame was detached');
  };

  try {
    // A "detached Frame" error can come from ANY Puppeteer call on a frame that got torn down
    // by an unexpected navigation (not just page.evaluate — click/waitForSelector/$eval can all
    // throw it too). Rather than chase every call site, retry the whole verification once with
    // a brand-new browser/login instead of reusing whatever page state broke.
    // Guarded by a time budget: the caller (verifyWorkOrderWithTimeout) enforces a 3-minute
    // ceiling, so only retry if the first attempt failed fast enough to leave real room —
    // otherwise a slow-but-legitimate attempt plus a full retry would blow past that ceiling
    // and turn a "would have eventually succeeded" run into a wasted timeout.
    const verifyStartedAt = Date.now();
    const RETRY_BUDGET_MS = 100 * 1000; // only retry if under ~100s elapsed, leaving ~80s for attempt 2
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        browser = await launchBrowser();
        const page = await autoLogin(browser, username, password, settings.portalUrl);
        await verifyWorkOrderWithPage(page, orderId);
        lastErr = null;
        break;
      } catch (attemptErr) {
        lastErr = attemptErr;
        if (browser) { try { await browser.close(); } catch (_) {} browser = null; }
        const elapsed = Date.now() - verifyStartedAt;
        if (attempt < 2 && isFrameDetachError(attemptErr) && elapsed < RETRY_BUDGET_MS) {
          console.warn(`[VerifyWorkOrder] Frame detached on attempt ${attempt}/2 after ${Math.round(elapsed/1000)}s, retrying with a fresh browser session...`);
          await delay(2000);
          continue;
        }
        throw attemptErr;
      }
    }

    if (abandonedSyncOrderIds.has(orderId)) {
      console.log(`[VerifyWorkOrder] Orden ${orderId} fue abandonada por timeout — ignorando resultado tardío, no se toca el lock ni la base.`);
      abandonedSyncOrderIds.delete(orderId);
      if (browser) try { await browser.close(); } catch (_) {}
      return { success: false, message: 'Abandoned due to timeout' };
    }

    if (browser) await browser.close();
    releaseBrowserLock();

    // Get updated status
    const updated = db.getWorkOrderById(orderId);
    return {
      success: updated ? updated.verifiedStatus === 'success' : false,
      status: updated ? updated.verifiedStatus : 'error',
      error: updated ? updated.verifiedError : null,
      count: updated ? updated.verifiedCount : 0
    };
  } catch (error) {
    if (abandonedSyncOrderIds.has(orderId)) {
      console.log(`[VerifyWorkOrder] Orden ${orderId} fue abandonada por timeout — ignorando resultado tardío, no se toca el lock ni la base.`);
      abandonedSyncOrderIds.delete(orderId);
      if (browser) try { await browser.close(); } catch (_) {}
      return { success: false, message: 'Abandoned due to timeout' };
    }
    if (browser) await browser.close();
    releaseBrowserLock();
    db.updateWorkOrder(orderId, {
      verifiedStatus: "error",
      verifiedError: error.message
    });
    return { success: false, message: error.message };
  }
}

// Helper wrapper to execute verifyWorkOrder with a 5-minute global safety timeout
async function verifyWorkOrderWithTimeout(orderId) {
  let timeoutId;
  try {
    return await Promise.race([
      verifyWorkOrder(orderId),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Timeout: verificación tardó más de 5 minutos')), 300 * 1000);
      })
    ]);
  } catch (err) {
    console.error(`[VerifyWorkOrder Timeout Safety] Fallo o timeout en verificación de orden ID ${orderId}:`, err.message);
    abandonedSyncOrderIds.add(orderId);
    try {
      db.updateWorkOrder(orderId, { verifiedStatus: 'error', verifiedError: err.message || 'Verificación cancelada por timeout de 5 minutos' });
    } catch (dbErr) {
      console.error(`[VerifyWorkOrder Timeout Safety] Error al actualizar BD para orden ID ${orderId}:`, dbErr.message);
    }
    releaseBrowserLock();
    return { success: false, message: err.message };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// Helper wrapper to execute syncWorkOrder with a 6-minute global safety timeout
async function syncWorkOrderWithTimeout(orderId) {
  let timeoutId;
  try {
    await Promise.race([
      syncWorkOrder(orderId),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Timeout: sincronización tardó más de 6 minutos')), 360 * 1000);
      })
    ]);
  } catch (err) {
    console.error(`[SyncWorker Timeout Safety] Fallo o timeout en sincronización de orden ID ${orderId}:`, err.message);
    abandonedSyncOrderIds.add(orderId);
    try {
      db.updateWorkOrder(orderId, {
        syncStatus: 'error',
        syncError: err.message || 'Sincronización cancelada por timeout de 6 minutos'
      });
    } catch (dbErr) {
      console.error(`[SyncWorker Timeout Safety] Error al actualizar BD para orden ID ${orderId}:`, dbErr.message);
    }
    releaseBrowserLock();
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// 3. BACKGROUND WORKER QUEUE LOOP
async function startWorker() {
  if (isWorkerRunning) return;
  isWorkerRunning = true;
  console.log("Background Sync Worker initialized and listening for pending OTs...");
  
  // Pre-populate mock catalogs on startup
  initMockCatalogs();

  // Reset catalogSyncStatus if stuck in 'syncing' on startup (e.g. due to server crash/restart)
  try {
    const currentSettings = db.getSettings();
    if (currentSettings.catalogSyncStatus === 'syncing') {
      console.log("Resetting stuck catalog sync status from 'syncing' to 'idle' on worker startup.");
      db.saveSettings({ catalogSyncStatus: 'idle', catalogSyncError: null });
    }
  } catch (err) {
    console.error("Error resetting stuck catalog sync status on startup:", err);
  }

  // One-time cleanup: collapse consecutive duplicate "Pausó"/"Fin" timerHistory entries
  // (e.g. many "Pausó" in a row from the same already-closed segment). This was caused by
  // a bug where the auto-conflict-resolver (client-side resolveDatabaseConflicts) paused
  // an older task but never cleared its timerStarted flag, so the dashboard kept "reviving"
  // it and re-pausing it every poll cycle. That bug is fixed, but existing orders can still
  // have the leftover duplicate entries bloating the UI. Only pause/fin-type duplicates are
  // touched (never "Inició"/"Reanudó"): the elapsed-hours calculation already treats every
  // pause/fin event beyond the one that actually closes a segment as a pure no-op, so
  // dropping the extras is guaranteed not to change any computed hours.
  try {
    const orders = db.getSyncableOrders();
    for (const o of orders) {
      let changed = false;
      const dedupedTasks = (o.tasks || []).map(t => {
        if (!t || !Array.isArray(t.timerHistory) || t.timerHistory.length < 2) return t;
        const deduped = [];
        for (const ev of t.timerHistory) {
          const curType = String(ev.type || ev.event || '').trim().toLowerCase();
          const prevType = deduped.length > 0 ? String(deduped[deduped.length - 1].type || deduped[deduped.length - 1].event || '').trim().toLowerCase() : null;
          const isPauseOrFin = curType.startsWith('paus') || curType.startsWith('fin');
          if (isPauseOrFin && prevType === curType) continue; // drop consecutive duplicate pause/fin
          deduped.push(ev);
        }
        if (deduped.length !== t.timerHistory.length) {
          changed = true;
          return { ...t, timerHistory: deduped };
        }
        return t;
      });
      if (changed) {
        console.log(`[Startup Cleanup] Collapsing duplicate timerHistory entries for order ID: ${o.id}`);
        db.updateWorkOrder(o.id, { tasks: dedupedTasks });
      }
    }
  } catch (err) {
    console.error("Error deduping timerHistory on startup:", err);
  }

  // Reset any orders stuck in 'syncing' back to 'pending' on startup
  try {
    const orders = db.getSyncableOrders();
    for (const o of orders) {
      if (o.syncStatus === 'syncing') {
        console.log(`Resetting stuck sync status for order ID: ${o.id} to 'pending' on worker startup.`);
        db.updateWorkOrder(o.id, { syncStatus: 'pending', syncError: 'Sincronización interrumpida por reinicio del servidor.' });
      }
    }
  } catch (err) {
    console.error("Error resetting stuck orders on startup:", err);
  }

  // Reset any orders stuck in verifiedStatus 'checking' on startup. Nothing else clears this
  // flag: if the process restarts (crash, deploy) while a manual "Controlar" verification is
  // in flight, the in-memory promise dies with it and the DB is left showing "CONTROLANDO..."
  // forever, since the code path that would set 'success'/'error' never gets to run.
  try {
    const orders = db.getSyncableOrders();
    for (const o of orders) {
      if (o.verifiedStatus === 'checking') {
        console.log(`Resetting stuck verifiedStatus for order ID: ${o.id} to 'error' on worker startup.`);
        db.updateWorkOrder(o.id, { verifiedStatus: 'error', verifiedError: 'Control interrumpido por reinicio del servidor.' });
      }
    }
  } catch (err) {
    console.error("Error resetting stuck verification status on startup:", err);
  }

  // Auto-fix settings for tasks that failed verification (wrong hours/status in Taxes)
  const MAX_AUTO_VERIFY_RETRIES = 5;
  const AUTO_VERIFY_COOLDOWN_MS = 2 * 60 * 1000; // wait 2 min between auto retries per order

  while (isWorkerRunning) {
    try {
      const settings = db.getSettings();
      if (settings.autoSyncDisabled === true) {
        // Automatic background sync is PAUSED
        await delay(10000);
        continue;
      }

      const orders = db.getSyncableOrders();
      const pendingOrder = orders.find(o => o.syncStatus === 'pending');

      if (pendingOrder) {
        console.log(`Found pending Work Order ID: ${pendingOrder.id}. Launching sync...`);
        await syncWorkOrderWithTimeout(pendingOrder.id);
      } else {
        // No new orders to sync — look for orders that need an automatic retry:
        // either their tasks failed the control check (verifiedStatus: 'error'),
        // or a later re-sync attempt itself failed (syncStatus: 'error') even
        // though they were already synced before (have a taxesOrderNumber).
        const brokenOrder = orders.find(o => {
          if (!o.taxesOrderNumber || o.syncStatus === 'local' || o.syncStatus === 'draft') return false;

          const needsVerifyRetry = o.syncStatus === 'success' && o.verifiedStatus === 'error' &&
            (o.verifiedCount || 0) < MAX_AUTO_VERIFY_RETRIES &&
            (!o.lastVerifyAttempt || (Date.now() - new Date(o.lastVerifyAttempt).getTime()) >= AUTO_VERIFY_COOLDOWN_MS);

          const needsSyncRetry = o.syncStatus === 'error' &&
            (o.autoSyncRetryCount || 0) < MAX_AUTO_VERIFY_RETRIES &&
            (!o.lastAutoSyncAttempt || (Date.now() - new Date(o.lastAutoSyncAttempt).getTime()) >= AUTO_VERIFY_COOLDOWN_MS);

          return needsVerifyRetry || needsSyncRetry;
        });

        if (brokenOrder) {
          console.log(`[AutoFix] Found order needing retry (ID: ${brokenOrder.id}, syncStatus=${brokenOrder.syncStatus}, verifiedStatus=${brokenOrder.verifiedStatus}). Retrying full reconciliation...`);
          await syncWorkOrderWithTimeout(brokenOrder.id);
        } else {
          // Nada pendiente por ahora — se revisa de nuevo en el próximo ciclo.
        }
      }
    } catch (e) {
      console.error("Error in background sync worker loop:", e);
    }

    // Poll every 10 seconds
    await delay(10000);
  }
}

function stopWorker() {
  isWorkerRunning = false;
  console.log("Background Sync Worker stopped.");
}

/**
 * Verify multiple orders efficiently by grouping them by credentials
 * and reusing the same browser session for each credential group.
 * Up to MAX_PARALLEL_BROWSERS groups run simultaneously.
 */
// Keep to 1 to avoid 429 rate-limiting from Taxes.com.ar — do NOT increase
const MAX_PARALLEL_BROWSERS = 1;

async function verifyMultipleOrders(orderIds) {
  const settings = db.getSettings();

  // SIEMPRE usar credenciales globales de Ajustes para todas las OTs
  const globalUsername = settings.username;
  const globalPassword = settings.password;
  if (!globalUsername || !globalPassword) {
    console.log('[VerifyAll] Faltan credenciales en Ajustes. No se puede verificar.');
    return;
  }

  // Todas las OTs usan las mismas credenciales globales
  const groups = new Map();
  for (const id of orderIds) {
    const order = db.getWorkOrderById(id);
    if (!order || !order.taxesOrderNumber) continue;
    if (!groups.has(globalUsername)) {
      groups.set(globalUsername, { username: globalUsername, password: globalPassword, ids: [] });
    }
    groups.get(globalUsername).ids.push(id);
  }

  const groupList = Array.from(groups.values());
  console.log(`[VerifyAll] ${orderIds.length} orders grouped into ${groupList.length} credential group(s). Running up to ${MAX_PARALLEL_BROWSERS} browsers in parallel.`);

  // Process groups sequentially with a cooldown between each batch to avoid 429
  for (let i = 0; i < groupList.length; i += MAX_PARALLEL_BROWSERS) {
    const batch = groupList.slice(i, i + MAX_PARALLEL_BROWSERS);
    await Promise.allSettled(batch.map(group => verifyGroupWithBrowser(group, settings)));
    if (i + MAX_PARALLEL_BROWSERS < groupList.length) {
      console.log('[VerifyAll] Waiting 15s between browser batches to avoid rate-limiting...');
      await delay(15000);
    }
  }

  console.log(`[VerifyAll] All verifications complete.`);
}

async function verifyGroupWithBrowser(group, settings) {
  await acquireBrowserLock(`verifyGroupWithBrowser(${group.username})`);
  let browser = null;
  try {
    browser = await launchBrowser();

    // Login once for the whole group - autoLogin creates a fresh page
    const page = await autoLogin(browser, group.username, group.password, settings.portalUrl);
    console.log(`[VerifyAll] Logged in as ${group.username}. Verifying ${group.ids.length} order(s)...`);

    // Verify each order in this group sequentially, with auto-retry on timeout
    let currentPage = page; // track the current working page
    for (const orderId of group.ids) {
      let lastErr = null;
      let attempt = 1;
      for (attempt = 1; attempt <= 4; attempt++) {
        try {
          await Promise.race([
            verifyWorkOrderWithPage(currentPage, orderId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout: verificación tardó más de 90 segundos')), 90000))
          ]);
          lastErr = null;
          break; // success — go to next order
        } catch (err) {
          lastErr = err;
          console.warn(`[VerifyAll] Order ${orderId} attempt ${attempt}/4 failed: ${err.message}`);
          if (attempt < 4) {
            console.log(`[VerifyAll] Retrying order ${orderId} after 8s with a fresh page...`);
            await delay(8000);
            // Open a fresh page to avoid "detached Frame" errors from previous navigation
            try {
              if (currentPage && !currentPage.isClosed()) {
                await currentPage.close().catch(() => {});
              }
              // autoLogin creates a brand-new page internally — assign it as currentPage
              currentPage = await autoLogin(browser, group.username, group.password, settings.portalUrl);
            } catch (pageErr) {
              console.warn(`[VerifyAll] Could not create fresh page: ${pageErr.message}`);
            }
          }
        }
      }
      // If both attempts failed, mark as error
      if (lastErr) {
        const order = db.getWorkOrderById(orderId);
        const count = (order ? order.verifiedCount || 0 : 0) + 1;
        db.updateWorkOrder(orderId, {
          verifiedStatus: 'error',
          verifiedCount: count,
          verifiedError: `Error del agente (${Math.min(attempt, 4)} intentos): ${lastErr.message}`
        });
      }
      // Pause between orders to avoid 429 rate-limiting from Taxes.com.ar
      if (group.ids.indexOf(orderId) < group.ids.length - 1) {
        console.log(`[VerifyAll] Pausing 8s before next order to avoid rate-limiting...`);
        await delay(8000);
      }
    }

    await browser.close(); releaseBrowserLock();
  } catch (err) {
    console.error(`[VerifyAll] Browser/login error for user ${group.username}:`, err.message);
    if (browser) try { await browser.close(); } catch (_) {}
    releaseBrowserLock();
    // Mark all orders in this group as error
    for (const orderId of group.ids) {
      const order = db.getWorkOrderById(orderId);
      const count = (order ? order.verifiedCount || 0 : 0) + 1;
      db.updateWorkOrder(orderId, {
        verifiedStatus: 'error',
        verifiedCount: count,
        verifiedError: `Error de conexión: ${err.message}`
      });
    }
  }
}

async function syncExpressOtHeader(orderId) {
  let order = db.getWorkOrderById(orderId);
  if (!order) return { success: false, message: "Orden no encontrada" };

  if (order.taxesOrderNumber) {
    return { success: true, message: `O.T. ya existe (#${order.taxesOrderNumber})`, taxesOrderNumber: order.taxesOrderNumber };
  }

  // CONTROL INTERNO EN MEMORIA (Rechazo instantáneo en menos de 1 milisegundo)
  const claveCandado = `${order.interno}_${order.clasificacion}`;
  if (candadoInternosActivos.has(claveCandado)) {
    console.warn(`[Anti-Duplicado Express] 🛑 Petición duplicada veloz bloqueada para el camión: ${order.interno}`);
    return { success: false, message: "Esta orden ya se está procesando o está en cola de espera." };
  }

  candadoInternosActivos.add(claveCandado);

  const settings = db.getSettings();
  const username = settings.username;
  const password = settings.password;

  if (!username || !password) {
    db.updateWorkOrder(orderId, { syncStatus: "error", syncError: "Faltan credenciales en Ajustes." });
    candadoInternosActivos.delete(claveCandado);
    return { success: false, message: "Faltan credenciales" };
  }

  let browser = null;
  try {
    await acquireBrowserLock(`syncExpressOtHeader(${orderId})`);

    const page = await autoLogin(browser = await launchBrowser(), username, password, settings.portalUrl);

    console.log(`[Express OT] Creating OT header for Interno ${order.interno} (Clasificación: ${order.clasificacion})...`);
    await safeGoto(page, `${settings.portalUrl}/tms/produccion/ot`, { timeout: 30000 });
    await page.waitForSelector('table', { timeout: 10000 }).catch(() => {});
    await delay(1000);

    // PRE-CHECK: Check if Taxes table already has an OT for this Interno & Clasificación!
    const existingTableOt = await safeEvaluate(page, (targetInterno, targetClasif) => {
      const clean = s => (s || '').toString().trim().toUpperCase();
      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll('tbody tr'));
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td')).map(c => clean(c.textContent));
          if (cells.length >= 3) {
            const rowInterno = cells[1] || cells[0] || '';
            const rowOt = cells[2] || cells[1] || '';
            const rowClasif = cells[4] || cells[3] || '';
            const intMatch = rowInterno.includes(clean(targetInterno));
            const clasifMatch = !targetClasif || rowClasif.includes(clean(targetClasif));
            const otNum = rowOt.replace(/\D/g, '');
            if (intMatch && clasifMatch && /^\d+$/.test(otNum)) {
              return otNum;
            }
          }
        }
      }
      return null;
    }, order.interno, order.clasificacion);

    if (existingTableOt) {
      console.log(`[Express OT Pre-Check] Found pre-existing OT #${existingTableOt} in Taxes for Interno ${order.interno}! Linking immediately.`);
      db.updateWorkOrder(orderId, { taxesOrderNumber: existingTableOt, syncStatus: 'success', syncError: null });
      return { success: true, taxesOrderNumber: existingTableOt, preExisting: true };
    }

    const nuevoBtnId = await safeEvaluate(page, () => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const b = btns.find(x => (x.textContent || '').trim().toUpperCase().includes('NUEVO'));
      if (!b) return null;
      const id = 'tmp-nuevo-btn-' + Date.now();
      b.id = id;
      return id;
    });

    if (nuevoBtnId) {
      await page.click(`#${nuevoBtnId}`);
      await delay(1500);
    }

    await safeEvaluate(page, (internoTarget, clasifTarget) => {
      const selects = Array.from(document.querySelectorAll('select'));
      const intSelect = selects.find(s => {
        const name = (s.name || s.id || '').toLowerCase();
        return name.includes('interno') || name.includes('unidad');
      }) || selects[0];

      if (intSelect) {
        const targetClean = String(internoTarget).trim().toUpperCase();
        const opt = Array.from(intSelect.options).find(o => o.textContent.toUpperCase().includes(targetClean));
        if (opt) {
          intSelect.value = opt.value;
          intSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      const clasSelect = selects.find(s => {
        const name = (s.name || s.id || '').toLowerCase();
        return name.includes('clasific') || name.includes('tipo') || name.includes('categoria');
      }) || selects[1];

      if (clasSelect && clasifTarget) {
        const targetClean = String(clasifTarget).trim().toUpperCase();
        const opt = Array.from(clasSelect.options).find(o => o.textContent.toUpperCase().includes(targetClean));
        if (opt) {
          clasSelect.value = opt.value;
          clasSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }, order.interno, order.clasificacion);

    await delay(1000);

    const guardarBtnId = await safeEvaluate(page, () => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const b = btns.find(x => (x.textContent || x.value || '').trim().toLowerCase().includes('guardar'));
      if (!b || b.dataset.clicked === 'true') return null;
      b.dataset.clicked = 'true';
      const id = 'tmp-guardar-express-' + Date.now();
      b.id = id;
      return id;
    });

    if (guardarBtnId) {
      await page.click(`#${guardarBtnId}`);
      // Immediately disable button to prevent double-POST in Taxes
      await safeEvaluate(page, (btnId) => {
        const b = document.getElementById(btnId);
        if (b) {
          b.disabled = true;
          b.style.pointerEvents = 'none';
        }
      }, guardarBtnId);
      await delay(3000);
    }

    const generatedOt = await safeEvaluate(page, (targetInterno) => {
      const clean = s => (s || '').toString().trim();
      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll('tbody tr'));
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td')).map(c => clean(c.textContent));
          if (cells.length >= 3) {
            const rowInterno = cells[1] || cells[0] || '';
            const rowOt = cells[2] || cells[1] || '';
            if (rowInterno.toUpperCase().includes(String(targetInterno).toUpperCase()) && /^\d+$/.test(rowOt.replace(/\D/g, ''))) {
              return rowOt.replace(/\D/g, '');
            }
          }
        }
      }
      return null;
    }, order.interno);

    if (generatedOt) {
      console.log(`[Express OT] Generated OT #${generatedOt} for Interno ${order.interno} in 3 seconds!`);
      db.updateWorkOrder(orderId, { taxesOrderNumber: generatedOt, syncStatus: 'success', syncError: null });
      return { success: true, taxesOrderNumber: generatedOt };
    }

    return { success: false, message: "No se pudo leer el número de O.T. generado" };
  } catch (err) {
    return { success: false, message: err.message };
  } finally {
    const claveCandado = `${order.interno}_${order.clasificacion}`;
    candadoInternosActivos.delete(claveCandado);
    releaseBrowserLock();
    if (browser) try { await browser.close(); } catch (_) {}
  }
}

async function syncSingleTaskToTareasForm(orderId, taskIndex) {
  let order = db.getWorkOrderById(orderId);
  if (!order || !order.taxesOrderNumber) {
    return { success: false, message: "La orden no tiene número de O.T. asignado en Taxes" };
  }

  const tasks = Array.isArray(order.tasks) ? order.tasks : [];
  const task = tasks[taskIndex];
  if (!task) return { success: false, message: "Tarea no encontrada en la orden" };

  if (task.synced === true) {
    return { success: true, message: "La tarea ya fue sincronizada previamente" };
  }

  const settings = db.getSettings();
  const username = settings.username;
  const password = settings.password;

  if (!username || !password) {
    return { success: false, message: "Faltan credenciales de Taxes en Ajustes" };
  }

  await acquireBrowserLock(`syncSingleTask(${orderId}, ${taskIndex})`);
  let browser = null;

  try {
    browser = await launchBrowser();
    const page = await autoLogin(browser, username, password, settings.portalUrl);

    console.log(`[SyncTask] Subiendo tarea #${taskIndex + 1} para OT #${order.taxesOrderNumber} a /tms/produccion/tareas...`);
    await safeGoto(page, `${settings.portalUrl}/tms/produccion/tareas`, { timeout: 30000 });
    await page.waitForSelector('select, input', { timeout: 10000 }).catch(() => {});
    await delay(1000);

    const otNumber = String(order.taxesOrderNumber).replace(/\D/g, '');
    const taskDate = task.date || order.createdAt || new Date().toISOString();
    const targetDateStr = new Date(taskDate).toLocaleDateString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      day: '2-digit', month: '2-digit', year: 'numeric'
    });

    await safeEvaluate(page, (data) => {
      const dateInputs = Array.from(document.querySelectorAll('input')).filter(i => {
        const type = (i.type || '').toLowerCase();
        const name = (i.name || i.id || i.placeholder || '').toLowerCase();
        return type === 'date' || name.includes('fecha');
      });
      if (dateInputs.length > 0) {
        const dInp = dateInputs[0];
        const parts = data.targetDateStr.split('/');
        const iso = parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : data.targetDateStr;
        dInp.value = dInp.type === 'date' ? iso : data.targetDateStr;
        dInp.dispatchEvent(new Event('input', { bubbles: true }));
        dInp.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const selects = Array.from(document.querySelectorAll('select'));
      const otSelect = selects.find(s => {
        const name = (s.name || s.id || '').toLowerCase();
        const parentText = s.parentElement ? s.parentElement.textContent.toLowerCase() : '';
        return name.includes('ot') || parentText.includes('ot');
      }) || selects[0];

      if (otSelect) {
        const opt = Array.from(otSelect.options).find(o => o.textContent.includes(data.otNumber));
        if (opt) {
          otSelect.value = opt.value;
          otSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      const ccSelect = selects.find(s => {
        const name = (s.name || s.id || '').toLowerCase();
        const parentText = s.parentElement ? s.parentElement.textContent.toLowerCase() : '';
        return name.includes('centro') || name.includes('costo') || parentText.includes('centro');
      }) || selects[1];

      if (ccSelect) {
        const targetCC = String(data.centroCosto || 'MECANICA').toUpperCase();
        const opt = Array.from(ccSelect.options).find(o => o.textContent.toUpperCase().includes(targetCC));
        if (opt) {
          ccSelect.value = opt.value;
          ccSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      const empSelect = selects.find(s => {
        const name = (s.name || s.id || '').toLowerCase();
        const parentText = s.parentElement ? s.parentElement.textContent.toLowerCase() : '';
        return name.includes('empleado') || name.includes('operario') || parentText.includes('empleado');
      });

      if (empSelect && data.empleado) {
        const targetEmp = String(data.empleado).trim().toUpperCase();
        const opt = Array.from(empSelect.options).find(o => o.textContent.toUpperCase().includes(targetEmp));
        if (opt) {
          empSelect.value = opt.value;
          empSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      const textareas = Array.from(document.querySelectorAll('textarea, input[type="text"]'));
      const descInput = textareas.find(t => {
        const name = (t.name || t.id || t.placeholder || '').toLowerCase();
        return name.includes('descrip') || name.includes('comentario') || name.includes('tarea');
      }) || textareas[0];

      if (descInput) {
        descInput.value = data.descripcion;
        descInput.dispatchEvent(new Event('input', { bubbles: true }));
        descInput.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const toggles = Array.from(document.querySelectorAll('input[type="checkbox"], input[type="radio"], .custom-control-input, .switch input'));
      const realizadaToggle = toggles.find(t => {
        const name = (t.name || t.id || '').toLowerCase();
        const parentText = t.parentElement ? t.parentElement.textContent.toLowerCase() : '';
        return name.includes('realizad') || parentText.includes('realizad');
      });
      if (realizadaToggle && !realizadaToggle.checked) {
        realizadaToggle.click();
      }
    }, {
      otNumber,
      targetDateStr,
      centroCosto: task.centroCostoLabel || task.centroCosto || 'MECANICA',
      empleado: task.empleado || '',
      descripcion: task.descripcion || 'Tarea finalizada',
    });

    await delay(1000);

    const guardarBtnId = await safeEvaluate(page, () => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(x => (x.textContent || '').trim().toLowerCase().includes('guardar'));
      if (!b) return null;
      const id = 'tmp-guardar-tarea-' + Date.now();
      b.id = id;
      return id;
    });

    if (guardarBtnId) {
      await page.click(`#${guardarBtnId}`);
      await delay(2500);
    }

    task.synced = true;
    task.syncedAt = new Date().toISOString();
    tasks[taskIndex] = task;

    db.updateWorkOrder(orderId, { tasks });
    console.log(`[SyncTask] Tarea #${taskIndex + 1} de la OT #${order.taxesOrderNumber} guardada con éxito en Taxes (tilde verde ✔)!`);

    await browser.close(); releaseBrowserLock();
    return { success: true, message: `Tarea #${taskIndex + 1} sincronizada correctamente en Taxes.` };
  } catch (err) {
    if (browser) try { await browser.close(); } catch (_) {}
    releaseBrowserLock();
    return { success: false, message: err.message };
  }
}

async function syncCompletedTasksForOrder(orderId) {
  const order = db.getWorkOrderById(orderId);
  if (!order || !order.taxesOrderNumber) {
    return { success: false, message: "La orden no tiene N° de O.T. asignado" };
  }

  const tasks = Array.isArray(order.tasks) ? order.tasks : [];
  let syncedAny = false;

  for (let idx = 0; idx < tasks.length; idx++) {
    if (tasks[idx] && tasks[idx].synced !== true) {
      console.log(`[SyncTasksBatch] Sincronizando tarea pendiente #${idx + 1} de la orden ${orderId}...`);
      const res = await syncSingleTaskToTareasForm(orderId, idx);
      if (res.success) syncedAny = true;
    }
  }

  return { success: true, syncedAny };
}

// Alias functions matching the 2-phase API routes:
async function createCleanHeader(orderId) {
  return await syncWorkOrder(orderId);
}

async function injectTasksToExistingOrder(orderId) {
  return await syncWorkOrder(orderId);
}

module.exports = {
  startWorker,
  stopWorker,
  syncWorkOrder,
  syncWorkOrderWithTimeout,
  syncExpressOtHeader,
  createCleanHeader,
  injectTasksToExistingOrder,
  syncSingleTaskToTareasForm,
  syncCompletedTasksForOrder,
  verifyWorkOrder,
  verifyWorkOrderWithTimeout,
  verifyMultipleOrders,
  scrapeCatalogs,
  scrapeCatalogsWithTimeout,
  isScraping,
  getIsScraping: () => isScraping,
  clearAbandoned: (id) => abandonedSyncOrderIds.delete(id),
  autoLogin
};
