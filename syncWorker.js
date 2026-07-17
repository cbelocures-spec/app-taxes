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

// Initialize Mock Catalogs if they are empty
function initMockCatalogs() {
  const current = db.getCatalogs();
  if (!current.rodados || current.rodados.length === 0) {
    console.log("Pre-populating local database with realistic mockup catalogs...");
    db.saveCatalogs(MOCK_CATALOGS);
  }
}

// Background Worker state
let isWorkerRunning = false;
let isScraping = false;

// Global lock so only ONE Puppeteer browser runs at a time across the whole app.
// Running two Chromium instances at once on a resource-limited server (like a
// small Railway container) can cause one of them to crash/close mid-operation
// ("Target closed" / "detached Frame" errors), so every entry point that launches
// a browser must acquire this lock first and release it when done.
let browserBusy = false;
async function acquireBrowserLock(context) {
  let waited = false;
  let waitedMs = 0;
  const MAX_WAIT_MS = 6 * 60 * 1000; // safety valve: never wait more than 6 minutes
  while (browserBusy) {
    if (!waited) { console.log(`[Lock] Browser is busy, ${context} is waiting for it to free up...`); waited = true; }
    if (waitedMs >= MAX_WAIT_MS) {
      console.warn(`[Lock] ${context} waited over 6 minutes for the browser lock — forcing it free (possible stuck process).`);
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

function killZombieChromes() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') return resolve();
    console.log('[Puppeteer] Cleaning up potential zombie chrome processes on server...');
    exec('pkill -9 -f chrome || true', (err) => {
      if (err) console.warn('[Puppeteer] Zombie cleanup warning: ' + err.message);
      resolve();
    });
  });
}

const delay = ms => new Promise(res => setTimeout(res, ms));

async function launchBrowser() {
  // Free up PIDs and memory by killing any leftover chrome instances
  await killZombieChromes().catch(() => {});

  let execPath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  if (!execPath && process.platform === 'win32') {
    const fs = require('fs');
    const stdPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const x86Path = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
    if (fs.existsSync(stdPath)) {
      execPath = stdPath;
    } else if (fs.existsSync(x86Path)) {
      execPath = x86Path;
    }
  }

  const launchOptions = {
    headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : true, // Headless by default, visible if PUPPETEER_HEADLESS=false
    executablePath: execPath,
    protocolTimeout: 30000, // Allow up to 30s for slow CDP/Runtime responses
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-extensions'
    ]
  };
  return await puppeteer.launch(launchOptions);
}

async function setupPage(page) {
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
    throw err;
  }
}

// Helper: Semantic text click in Puppeteer
async function clickByText(page, text, elementType = '*') {
  const elements = await page.$$(elementType);
  for (const element of elements) {
    const content = await page.evaluate(el => el.textContent, element);
    if (content && content.toLowerCase().includes(text.toLowerCase())) {
      const isVisible = await page.evaluate(el => {
        const style = window.getComputedStyle(el);
        return style && style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0;
      }, element);
      if (isVisible) {
        await page.evaluate(el => el.click(), element);
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
    const id = await page.evaluate(el => el.id, input);
    const name = await page.evaluate(el => el.getAttribute('name'), input);
    const placeholder = await page.evaluate(el => el.getAttribute('placeholder'), input);
    
    // Check if ID matches any labels
    if (id) {
      const label = await page.$(`label[for="${id}"]`);
      if (label) {
        const text = await page.evaluate(el => el.textContent, label);
        if (text && text.toLowerCase().includes(labelText.toLowerCase())) {
          await input.focus();
          await page.evaluate(el => el.value = '', input); // Clear
          await input.type(value);
          return true;
        }
      }
    }
    
    // fallback check placeholder or name
    if ((placeholder && placeholder.toLowerCase().includes(labelText.toLowerCase())) || 
        (name && name.toLowerCase().includes(labelText.toLowerCase()))) {
      await input.focus();
      await page.evaluate(el => el.value = '', input); // Clear
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
    const inputInfo = await page.evaluate((label) => {
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
            
            if (searchInput && hiddenInput) {
              // Give them temporary IDs for reliable selection
              const searchId = 'tmp_search_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
              const hiddenId = 'tmp_hidden_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
              searchInput.setAttribute('id', searchId);
              hiddenInput.setAttribute('id', hiddenId);
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
          if (rodadoInfo.patente) {
            queriesToTry.push(rodadoInfo.patente.trim());
          }
          if (rodadoInfo.interno) {
            queriesToTry.push(rodadoInfo.interno.trim());
            queriesToTry.push(`Interno ${rodadoInfo.interno.trim()}`);
          }
          if (rodadoInfo.modelo) {
            queriesToTry.push(rodadoInfo.modelo.trim());
          }
        }
      } catch (catErr) {
        console.error("Error retrieving matching rodado from local catalogs:", catErr);
      }
    }

    if (queriesToTry.length === 0) {
      // If it contains "Interno X", we try to search by the interno number FIRST as it is highly precise!
      const internoMatch = searchValue.match(/Interno\s+(\d+)/i);
      if (internoMatch) {
        queriesToTry.push(internoMatch[1]); // Try "4" first
        queriesToTry.push(`Interno ${internoMatch[1]}`); // Try "Interno 4" second
      }

      queriesToTry.push(searchValue);
      if (searchValue.includes(' - ')) {
        const parts = searchValue.split(' - ');
        const brand = parts[0].trim();
        const rest = parts[1].split('.')[0].trim(); // e.g. "F100" or "SAVEIRO 1.6L"
        queriesToTry.push(`${brand} ${rest}`);
        queriesToTry.push(rest);
        queriesToTry.push(brand);
      }
      if (searchValue.includes(' ')) {
        const words = searchValue.split(/\s+/);
        queriesToTry.push(words[0]); // Last name (e.g. "BELOCURES")
        if (words[1]) {
          queriesToTry.push(words[1]); // First name (e.g. "CESAR")
        }
      }
    }

    // Try queries one by one
    for (const query of queriesToTry) {
      console.log(`Attempting search query for "${labelText}": "${query}"...`);
      
      // Check if dropdown is visible, if not click it to open
      const isDropdownOpen = await page.evaluate(() => {
        const dropdownContainers = Array.from(document.querySelectorAll('[id^="searchable-select-dropdown-"]'));
        return dropdownContainers.some(container => container.offsetHeight > 0);
      });

      if (!isDropdownOpen) {
        console.log(`   Dropdown was closed, clicking input to open...`);
        await page.click(searchSelector);
        await delay(500);
      }

      // Focus and clear existing text reliably via evaluate and keyboard
      await page.evaluate((sel) => {
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
      const optionClicked = await page.evaluate((targetVal, rodadoInfo) => {
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

        // A. Match by patent (highest priority for vehicles)
        if (rodadoInfo && rodadoInfo.patente) {
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
          matched.click();
          return { success: true, text: matched.textContent.trim() };
        }

        return { success: false };
      }, searchValue, rodadoInfo);

      if (optionClicked.success) {
        console.log(`   ✓ Selected option for "${labelText}": "${optionClicked.text}"`);
        
        // Wait for Vue reactivity to update the hidden input
        await delay(1000);
        
        // Verify the hidden input got a value
        const hiddenValue = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? el.value : '(not found)';
        }, hiddenSelector);
        console.log(`   ✓ Hidden input value for "${labelText}": "${hiddenValue}"`);
        
        if (hiddenValue !== '' && hiddenValue !== '(not found)') {
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
    // Resolve searchable input and hidden input dynamically
    const inputInfo = await page.evaluate((idx) => {
      // 1. Get all hours inputs to locate the specific card container
      const horasInputs = Array.from(document.querySelectorAll('input[id^="horas_"], input[name="horas_estimadas"]'));
      const targetHoursInput = horasInputs[idx];
      if (!targetHoursInput) return { found: false, error: 'Hours input not found' };

      // 2. Find target card container
      let card = targetHoursInput.parentElement;
      while (card && card !== document.body && 
             !card.classList.contains('card') && 
             !card.classList.contains('form-row') && 
             !card.classList.contains('row') &&
             !card.className.includes('col-12')) {
        card = card.parentElement;
      }
      if (!card) return { found: false, error: 'Card container not found' };

      // 3. Find the searchable select wrapper inside this card
      const wrapper = card.querySelector('.searchable-select-wrapper, .multiselect');
      if (!wrapper) return { found: false, error: 'Searchable select wrapper not found' };

      // 4. Find the inputs inside this select wrapper
      const hiddenInput = wrapper.querySelector('input[type="hidden"]') || wrapper.querySelector('input[name*="empleado_id"]');
      const searchInput = wrapper.querySelector('.searchable-input, input[type="text"]');

      if (hiddenInput && searchInput) {
        const searchId = 'tmp_emp_search_' + idx + '_' + Date.now();
        const hiddenId = 'tmp_emp_hidden_' + idx + '_' + Date.now();
        searchInput.setAttribute('id', searchId);
        hiddenInput.setAttribute('id', hiddenId);
        return { searchId, hiddenId, found: true };
      }
      
      // Fallback: search by input name attribute
      const fallbackHidden = document.querySelector(`input[name="syj_empleado_id_tarea_${idx}"], input[name$="empleado_id_tarea_${idx}"], input[name*="empleado_id_tarea_${idx}"]`);
      if (fallbackHidden) {
        const parent = fallbackHidden.closest('.searchable-select-wrapper') || fallbackHidden.parentElement;
        const fallbackSearch = parent ? parent.querySelector('.searchable-input, input[type="text"]') : null;
        if (fallbackSearch) {
          const searchId = 'tmp_emp_search_' + idx + '_' + Date.now();
          const hiddenId = 'tmp_emp_hidden_' + idx + '_' + Date.now();
          fallbackSearch.setAttribute('id', searchId);
          fallbackHidden.setAttribute('id', hiddenId);
          return { searchId, hiddenId, found: true };
        }
      }

      return { found: false };
    }, index);

    if (!inputInfo.found) {
      console.log(`Could not find searchable employee input for task index: ${index}`);
      return false;
    }

    const searchSelector = `#${inputInfo.searchId}`;
    const hiddenSelector = `#${inputInfo.hiddenId}`;

    // Try queries one by one via dropdown UI
    const queriesToTry = [employeeName];
    if (employeeName.includes(' ')) {
      const words = employeeName.split(/\s+/).filter(w => w.length > 2);
      queriesToTry.push(...words.map(w => w.replace(/[^a-zA-Z0-9]/g, '')));
    }

    for (const query of queriesToTry) {
      console.log(`Attempting employee search query: "${query}"...`);
      
      // Check if dropdown is visible
      const isDropdownOpen = await page.evaluate(() => {
        const dropdownContainers = Array.from(document.querySelectorAll('[id^="searchable-select-dropdown-"]'));
        return dropdownContainers.some(container => container.offsetHeight > 0);
      });

      if (!isDropdownOpen) {
        await page.click(searchSelector);
        await delay(500);
      }

      // Focus and clear input
      await page.focus(searchSelector);
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await delay(300);

      // Type the query
      await page.type(searchSelector, query, { delay: 50 });
      await delay(2000); // Wait for dropdown to filter

      // Select option
      const optionClicked = await page.evaluate((targetVal) => {
        const dropdownContainers = Array.from(document.querySelectorAll('[id^="searchable-select-dropdown-"]'));
        let visibleOptions = [];
        dropdownContainers.forEach(container => {
          if (container.offsetHeight > 0) {
            const divs = Array.from(container.querySelectorAll('div'));
            const leafDivs = divs.filter(d => d.querySelectorAll('div').length === 0 && d.textContent.trim().length > 0);
            visibleOptions.push(...leafDivs);
          }
        });

        const clean = (str) => {
          if (!str) return '';
          return str.normalize("NFD")
                    .replace(/[\u0300-\u036f]/g, "")
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, "");
        };

        const targetClean = clean(targetVal);
        const filteredOptions = visibleOptions.filter(el => {
          const text = el.textContent.trim().toLowerCase();
          return text.length > 0 && !text.includes('opciones') && !text.includes('cargando') && !text.includes('no hay') && !text.includes('no se encontraron');
        });

        if (filteredOptions.length === 0) return { success: false };

        // Match by text comparison
        let matched = filteredOptions.find(el => {
          const textClean = clean(el.textContent);
          return textClean.includes(targetClean) || targetClean.includes(textClean);
        });

        if (!matched && filteredOptions.length > 0) {
          matched = filteredOptions[0]; // Fallback to first
        }

        if (matched) {
          matched.click();
          return { success: true, text: matched.textContent.trim() };
        }

        return { success: false };
      }, employeeName);

      if (optionClicked.success) {
        console.log(`   ✓ Selected employee: "${optionClicked.text}"`);
        await delay(1000);
        
        const hiddenValue = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? el.value : '(not found)';
        }, hiddenSelector);
        console.log(`   ✓ Hidden input value: "${hiddenValue}"`);
        
        if (hiddenValue !== '' && hiddenValue !== '(not found)') {
          return true;
        }
      }
    }

    // =====================================================================
    // FALLBACK: Direct injection when dropdown is empty / AJAX didn't load
    // The Taxes portal filters employees by Centro de Costo via AJAX,
    // but our DOM-based CC selection doesn't always trigger Vue's watcher.
    // So we directly set the hidden input value and visible text.
    // =====================================================================
    console.log(`Dropdown search failed. Attempting DIRECT INJECTION fallback...`);
    
    // Resolve the employee ID from our local catalog
    const employeeCatalog = db.getCatalogs().empleados || [];
    const employeeObj = employeeCatalog.find(e => {
      const clean = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return clean(e.label).includes(clean(employeeName)) || clean(employeeName).includes(clean(e.label));
    });

    if (!employeeObj) {
      console.log(`Could not find employee "${employeeName}" in local catalog for direct injection.`);
      return false;
    }

    console.log(`   Found employee in catalog: ID=${employeeObj.value}, Label="${employeeObj.label}"`);

    const injected = await page.evaluate((hiddenSel, searchSel, empId, empLabel) => {
      const hiddenInput = document.querySelector(hiddenSel);
      const searchInput = document.querySelector(searchSel);
      
      if (!hiddenInput) return { success: false, error: 'Hidden input not found' };

      // Set hidden input value (this is what gets submitted)
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(hiddenInput, empId);
      hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
      hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));

      // Set visible text input to show the employee name
      if (searchInput) {
        nativeSetter.call(searchInput, empLabel);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Also try to update Vue's internal state if the component has a __vue__ reference
      const wrapper = hiddenInput.closest('.searchable-select-wrapper');
      if (wrapper && wrapper.__vue__) {
        try {
          wrapper.__vue__.$emit('input', empId);
          wrapper.__vue__.$emit('change', empId);
        } catch(e) { /* ignore */ }
      }

      return { success: true, hiddenValue: hiddenInput.value, displayValue: searchInput ? searchInput.value : '' };
    }, hiddenSelector, searchSelector, employeeObj.value, employeeObj.label);

    if (injected.success) {
      console.log(`   ✓ DIRECT INJECTION success: hidden="${injected.hiddenValue}", display="${injected.displayValue}"`);
      await delay(500);
      return true;
    } else {
      console.log(`   ✗ DIRECT INJECTION failed: ${injected.error}`);
      return false;
    }

  } catch (error) {
    console.error(`Error filling task employee searchable select:`, error);
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
      if (msg.includes('Execution context was destroyed') || msg.includes('detached Frame') || msg.includes('Target closed')) {
        console.warn(`[safeEvaluate] Context/Frame error, waiting 1s before retry ${i + 1}/3...`);
        await delay(1000);
      } else {
        throw err;
      }
    }
  }
  throw new Error("Page evaluation failed due to persistent context/frame destruction.");
}

// Automate login to Taxes.com.ar
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

  // Check if we landed on /login or got redirected to /admin (already logged in)
  const urlAfterLoad = page.url().toLowerCase();
  if (!urlAfterLoad.includes('/login')) {
    console.log(`[autoLogin] Already logged in, URL is: ${urlAfterLoad}`);
    return page;
  }

  console.log(`[autoLogin] Not logged in. Attempting login as ${username}...`);

  // Target selectors for email and password on Taxes.com.ar login page
  const emailSelector = 'input[name="loginUser"]';
  const passSelector = 'input[name="password"]';

  // Poll for password input using evaluate (avoids detached frame from waitForSelector)
  console.log('[autoLogin] Waiting for password input via polling...');
  await delay(5000); // Wait longer for Vue.js + any redirects to settle
  const inputReady = await (async () => {
    for (let i = 0; i < 40; i++) { // 40 × 500ms = 20 seconds max
      try {
        const found = await page.evaluate((sel) => !!document.querySelector(sel), passSelector);
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
    try {
      const found = await page.evaluate((sel) => !!document.querySelector(sel), passSelector);
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
  await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) { el.value = ''; el.focus(); } }, emailSelector);
  await page.click(emailSelector, { clickCount: 3 }); // select all
  await page.type(emailSelector, username, { delay: 30 });

  // Clear and type password
  await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) { el.value = ''; el.focus(); } }, passSelector);
  await page.click(passSelector, { clickCount: 3 }); // select all
  await page.type(passSelector, password, { delay: 30 });

  await delay(300);

  // Extract and inject CSRF token (Taxes.com.ar is Laravel-based and requires _token)
  const csrfToken = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : null;
  });
  if (csrfToken) {
    console.log(`[autoLogin] CSRF token found (length=${csrfToken.length}), injecting into form...`);
    await page.evaluate((token) => {
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

  // Submit with Enter key (most reliable for this form)
  console.log('[autoLogin] Submitting form with Enter key...');
  await page.keyboard.press('Enter');
  // Give the browser a moment to start the navigation before we poll the URL
  await delay(1000);





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
    // We are still on the login page, so it failed. Let's find out why:
    let errorMsg = "Credenciales incorrectas o error de inicio de sesión en Taxes.com.ar";
    try {
      const hasErrorText = await page.evaluate(() => {
        const bodyText = document.body.textContent.toLowerCase();
        return bodyText.includes('credenciales inv') ||
               bodyText.includes('credenciales incorrecta') ||
               bodyText.includes('usuario o contrase') ||
               bodyText.includes('contraseñaa incorrecta') ||
               bodyText.includes('contraseña incorrecta') ||
               bodyText.includes('datos incorrectos') ||
               bodyText.includes('acceso denegado');
      });
      if (hasErrorText) {
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
    isScraping = false; releaseBrowserLock();
    db.saveSettings({ catalogSyncStatus: "error", catalogSyncError: "Faltan configurar las credenciales de Taxes." });
    return { success: false, message: "Faltan configurar las credenciales de Taxes." };
  }

  console.log(`Starting automatic catalog extraction from Taxes.com.ar using user: ${username}...`);
  let browser = null;

  try {
    db.saveSettings({ catalogSyncStatus: "syncing", catalogSyncError: null });
    browser = await launchBrowser();
    const page = await browser.newPage();
    await setupPage(page);

    // Login
    const loginPage = await autoLogin(browser, username, password, settings.portalUrl);
    // Close the login page and open a fresh one for catalog scraping
    await loginPage.close().catch(() => {});

    // ============================================================
    // STEP A: SCRAPE ALL RODADOS FROM FLOTA > FLOTA (limit 999)
    // ============================================================
    console.log("=== PASO 1/3: Scrapeando FLOTA completa ===");
    console.log("Navigating to Flota > Flota page...");
    await safeGoto(page, `${settings.portalUrl}/tms/produccion/flota`, { timeout: 30000 });
    await delay(3000);

    // Set limit to 999 to show all vehicles
    console.log("Setting limit to 999 to show all vehicles...");
    const limitSet = await page.evaluate(() => {
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
    const buscarClicked = await page.evaluate(() => {
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
    const totalText = await page.evaluate(() => {
      const body = document.body.textContent;
      const match = body.match(/Total:\s*(\d+)\s*registros/i);
      return match ? match[0] : 'Total not found';
    });
    console.log("Fleet page reports:", totalText);

    // Attempt to set DataTable page length to maximum to reduce pagination overhead
    console.log("Attempting to set DataTable page length to maximum...");
    const lengthResult = await page.evaluate(() => {
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
      
      const pageVehicles = await page.evaluate(() => {
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
      const nextButtonInfo = await page.evaluate(() => {
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
      const bodyText = await page.evaluate(() => document.body.textContent.substring(0, 500));
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
    
    console.log("Waiting for selects to load...");
    await page.waitForSelector('select', { timeout: 10000 });
    
    console.log("Waiting for employee select options to populate...");
    await page.waitForFunction(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      return selects.some(s => s.options.length > 50);
    }, { timeout: 15000 }).catch(e => console.log("Timeout waiting for employee select options: " + e.message));

    // Scrape all employees from the select that has the most options
    console.log("Scraping employees/responsibles from list page...");
    const employees = await page.evaluate(() => {
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
    const nuevoClicked = await page.evaluate(() => {
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

    // Wait for the modal / creation form to open
    console.log("Waiting for modal to open...");
    await page.waitForSelector('select[name="inv_ot_clasificacion_id"]', { timeout: 10000 });

    // Click AGREGAR TAREA
    console.log("Clicking AGREGAR TAREA...");
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const addBtn = buttons.find(b => b.textContent.includes('AGREGAR TAREA') || b.textContent.includes('Agregar Tarea'));
      if (addBtn) addBtn.click();
    });
    
    // Wait for task card to appear
    console.log("Waiting for task card to appear...");
    await page.waitForSelector('select[name="syj_centro_costo_id_0"]', { timeout: 10000 });

    console.log("Waiting for Centro de Costo options to populate...");
    await page.waitForFunction(() => {
      const ccSelect = document.querySelector('select[name="syj_centro_costo_id_0"]');
      return ccSelect && ccSelect.options.length > 1;
    }, { timeout: 10000 }).catch(e => console.log("Timeout waiting for CC options: " + e.message));

    // Scrape Centros de Costo from the newly added task card
    console.log("Scraping Centros de Costo from task card...");
    const centrosCosto = await page.evaluate(() => {
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

    const finalCatalogs = {
      rodados: rodados,
      responsables: mergedResponsables,
      empleados: mergedEmpleados,
      centrosCosto: mergedCentros
    };

    db.saveCatalogs(finalCatalogs);
    db.saveSettings({ catalogSyncStatus: "success", catalogSyncError: null });
    console.log(`Catalog scraping completed! Rodados: ${rodados.length}, Empleados: ${mergedEmpleados.length}, Centros: ${mergedCentros.length}`);
    isScraping = false; releaseBrowserLock();
    await browser.close();
    return { success: true, message: `Catálogos actualizados: ${rodados.length} rodados, ${mergedEmpleados.length} empleados, ${mergedCentros.length} centros de costo.` };
  } catch (error) {
    console.error("Error scraping catalogs:", error);
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

// Helper to extract base description by stripping system suffixes (diagnostico, realizado, insumos)
function extractBaseDescription(desc) {
  if (!desc) return '';
  let cleanDesc = desc;
  
  // 1. Remove [Insumos: ...]
  cleanDesc = cleanDesc.replace(/\[Insumos:[^\]]*\]/gi, '');
  
  // 2. Remove Realizó/Realizo suffix
  cleanDesc = cleanDesc.replace(/\.?\s*Realizó:\s*[^\n\r]*/gi, '');
  cleanDesc = cleanDesc.replace(/\.?\s*Realizo:\s*[^\n\r]*/gi, '');
  
  // 3. Remove Diagnóstico suffix
  cleanDesc = cleanDesc.replace(/\.?\s*-\s*Diagnóstico:\s*[^\n\r]*/gi, '');
  cleanDesc = cleanDesc.replace(/\.?\s*Diagnóstico:\s*[^\n\r]*/gi, '');
  
  // Clean whitespace and punctuation to make compare robust
  return cleanDesc.replace(/[.,\s]/g, '').toLowerCase();
}

// Helper to resolve employee name and handle custom fallbacks (like mapping to Vera)
function resolveAndMapEmployee(task) {
  const employeeCatalog = db.getCatalogs().empleados || [];
  const employeeObj = employeeCatalog.find(e => e.value === task.empleado);
  let employeeLabel = employeeObj ? employeeObj.label : task.empleado;

  const customMechanicNames = [
    "DOMINIC DYLAN",
    "PEREZ FACUNDO",
    "LOPEZ GUSTAVO",
    "CALOMINO DARIO",
    "MUSDALINO FRANCO",
    "RODRIGUEZ MARCELO",
    "GODOY DAVID"
  ];

  const customHerreriaMechanicNames = [
    "Federico",
    "Luciano",
    "Digno"
  ];

  let finalDescription = task.descripcion || '';
  const matchedCustomName = customMechanicNames.find(
    name => name.toLowerCase() === employeeLabel.toLowerCase().trim()
  );
  const matchedCustomHerreriaName = customHerreriaMechanicNames.find(
    name => name.toLowerCase() === employeeLabel.toLowerCase().trim()
  );

  if (matchedCustomName) {
    console.log(`Mapping custom employee "${employeeLabel}" to "Vera, Domingo Sergio"`);
    employeeLabel = "Vera, Domingo Sergio";
    const suffix = `. Realizó: ${matchedCustomName}`;
    if (!finalDescription.endsWith(suffix)) {
      finalDescription = `${finalDescription}${suffix}`;
    }
  } else if (matchedCustomHerreriaName) {
    console.log(`Mapping custom employee "${employeeLabel}" to "García, Yamandú Liborio"`);
    employeeLabel = "García, Yamandú Liborio";
    const suffix = `. Realizó: ${matchedCustomHerreriaName}`;
    if (!finalDescription.endsWith(suffix)) {
      finalDescription = `${finalDescription}${suffix}`;
    }
  }

  // Append insumos/supplies if present and not already concatenated
  if (task.insumos && task.insumos.trim()) {
    const insumosSuffix = `[Insumos: ${task.insumos.trim()}]`;
    if (!finalDescription.includes(insumosSuffix)) {
      finalDescription = `${finalDescription}\n${insumosSuffix}`;
    }
  }

  return { employeeLabel, finalDescription };
}

// 2. SYNCHRONIZE SINGLE WORK ORDER
async function syncWorkOrder(orderId) {
  const order = db.getWorkOrderById(orderId);
  if (!order) return { success: false, message: "Order not found" };

  const settings = db.getSettings();
  
  // SIEMPRE usar credenciales globales de Ajustes (paniol@).
  // Cualquier supervisor puede sincronizar cualquier OT con las credenciales centrales.
  // Las credenciales del creador de la OT se ignoran.
  const username = settings.username;
  const password = settings.password;

  if (!username || !password) {
    db.updateWorkOrder(orderId, {
      syncStatus: "error",
      syncError: "Faltan las credenciales en Ajustes. Configurá el usuario y contraseña de Taxes."
    });
    return { success: false, message: "Missing credentials in settings" };
  }

  await acquireBrowserLock(`syncWorkOrder(${orderId})`);
  console.log(`\n=== Starting Background Sync for OT #${order.interno} (ID: ${order.id}) using user: ${username} ===`);
  db.updateWorkOrder(orderId, { syncStatus: "syncing", syncError: null });

  let browser = null;

  try {
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


    // 2. EXISTING OT — RECONCILIATION VIA OT EDIT FORM (pencil)
    // Uses the OT edit form directly: reads task cards, deletes duplicates with red trash,
    // fixes hours/realizada, then GUARDAR. Never touches /tms/produccion/tareas for existing OTs.
    if (order.taxesOrderNumber) {
      const otNumClean = String(order.taxesOrderNumber).replace(/^#/, '');
      console.log(`[Reconcile] OT ${otNumClean} exists. Opening edit form to reconcile...`);

      const cleanStr = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

      // 1. Go to OT list
      await safeGoto(page, `${settings.portalUrl}/tms/produccion/ot`, { timeout: 30000 });
      await page.waitForSelector('input', { timeout: 10000 }).catch(() => {});
      await delay(2500);

      // Click "En Proceso" tab
      console.log(`[Reconcile] Clicking 'En Proceso' tab...`);
      await page.evaluate(() => {
        const navLinks = Array.from(document.querySelectorAll('a.nav-link, [role="tab"], .nav-tabs li a, .nav li a'));
        const tab = navLinks.find(t => t.textContent.trim().toLowerCase().includes('en proceso'));
        if (tab) { tab.click(); return; }
        const all = Array.from(document.querySelectorAll('a, button, li'));
        const fb  = all.find(t => t.textContent.trim().toLowerCase() === 'en proceso');
        if (fb) { fb.click(); }
      }).catch(() => {});
      await delay(2500);

      // Find and click the Numero input using the exact logic from test_ot_search.js
      const numInputId = await page.evaluate(() => {
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
        foundOTRow = await page.evaluate((otNum) => {
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
      // .click() on the element from inside page.evaluate(), which can leave the
      // browser's execution context waiting for a response that never comes.
      const findAndTagPencil = async () => {
        return await page.evaluate((otNum) => {
          const rows = Array.from(document.querySelectorAll('table tbody tr'));
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td'));
            // Check ALL cells: strip #, spaces, find our number
            const hasOT = cells.some(c => {
              const txt = c.textContent.replace(/#/g, '').replace(/\s+/g, ' ').trim();
              return txt === otNum || txt.includes(otNum);
            });
            if (hasOT) {
              const lastCell = cells[cells.length - 1];
              const allBtns = Array.from(lastCell?.querySelectorAll('a, button') || []);
              // eye=index 0, pencil=index 1 (non-red), delete=last (red)
              const editBtn = allBtns.find((b, i) => i > 0 && !b.className.includes('danger') && !b.className.includes('red'))
                              || allBtns[1] || allBtns[0];
              if (editBtn) {
                const id = 'tmp-pencil-btn-' + Date.now();
                editBtn.id = id;
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
          console.log(`[Reconcile] Clicking pencil button #${pencilBtnId} (native click)...`);
          await Promise.race([
            page.click(`#${pencilBtnId}`),
            new Promise((_, reject) => setTimeout(() => reject(new Error('native click timeout after 10s')), 10000))
          ]);
          console.log(`[Reconcile] Pencil click call returned normally.`);
          pencilClicked = true;
        } catch (clickErr) {
          // A "Node is detached" / navigation-related error here usually means
          // the click succeeded and the page already navigated away — treat as success
          // and let the waitForSelector below confirm it for real.
          console.warn(`[Reconcile] Native click on pencil button raised/timed out: ${clickErr.message} (likely navigated away, treating as success)`);
          pencilClicked = true;
        }
        // Confirm the edit form actually loaded before trusting the click.
        console.log(`[Reconcile] Waiting for edit form to confirm navigation...`);
        pencilClicked = await page.waitForSelector('input[name="horas_estimadas"]', { timeout: 10000 }).then(() => true).catch(() => pencilClicked);
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
          pencilClicked = await page.waitForSelector('input[name="horas_estimadas"]', { timeout: 10000 }).then(() => true).catch(() => false);
        }
      }

      if (!pencilClicked) {
        // Save screenshot for debugging
        try {
          const path = require('path');
          const screenshotPath = path.join(__dirname, 'public', 'last_ot_search_debug.png');
          await page.screenshot({ path: screenshotPath, fullPage: false });
          console.log(`[Reconcile] Debug screenshot saved to: ${screenshotPath}`);
          // Also log current URL and page title
          console.log(`[Reconcile] Current URL: ${page.url()}`);
          // Log all visible inputs and their values
          const inputsInfo = await page.evaluate(() =>
            Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent).map(i => ({
              id: i.id, name: i.name, type: i.type, value: i.value, placeholder: i.placeholder
            }))
          );
          console.log(`[Reconcile] Visible inputs:`, JSON.stringify(inputsInfo));
          // Log table rows
          const rowsInfo = await page.evaluate(() =>
            Array.from(document.querySelectorAll('table tbody tr')).slice(0, 35).map(r =>
              Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim()).join(' | ')
            )
          );
          console.log(`[Reconcile] Table rows (first 35):`, JSON.stringify(rowsInfo));
        } catch(se) { console.warn('[Reconcile] Screenshot failed:', se.message); }
        throw new Error(`No se encontró la OT ${otNumClean} en el listado para editar. Verificar número de OT en Taxes.`);
      }


      // 3. Wait for OT edit form to load (task cards)
      await page.waitForSelector('input[name="horas_estimadas"]', { timeout: 8000 }).catch(() => {});
      await delay(3500);

      // 4. Read ALL task cards currently in the form
      //    Each card has: empleado input/text, horas input, descripcion textarea, realizada checkbox, red trash button
      const readFormCards = async () => {
        return await page.evaluate(() => {
          const clean = s => (s || '').trim();
          // Each task card is a container with horas_estimadas or horas_X input
          const horasInputs = Array.from(document.querySelectorAll('input[id^="horas_"], input[name="horas_estimadas"]'));
          const descTextareas = Array.from(document.querySelectorAll('textarea[id^="descripcion_"], textarea[placeholder*="Describe las actividades"]'));
          const switches = Array.from(document.querySelectorAll('.custom-control.custom-switch'));
          // Red trash/delete buttons — one per card
          const trashBtns = Array.from(document.querySelectorAll('button.btn-danger, a.btn-danger, [class*="danger"]'))
            .filter(b => b.querySelector('.fa-trash, .fa-times, .fa-remove') || b.textContent.trim() === '' || b.title?.toLowerCase().includes('elim'));

          // Get employee from display text/value
          const getEmpText = (i) => {
            const wrappers = Array.from(document.querySelectorAll('.searchable-select-wrapper, .multiselect'));
            if (wrappers[i]) {
              const tag = wrappers[i].querySelector('.multiselect__single, .multiselect__tag span, .multiselect__option--selected, .searchable-input');
              if (tag) return clean(tag.value || tag.textContent || '');
            }
            return '';
          };

          return horasInputs.map((inp, i) => ({
            index: i,
            hours: clean(inp.value),
            employee: getEmpText(i),
            description: descTextareas[i] ? clean(descTextareas[i].value) : '',
            realizada: switches[i] ? (switches[i].querySelector('input[type="checkbox"]')?.checked || false) : false,
            hasTrashBtn: !!trashBtns[i],
            _debug: { emp: getEmpText(i), hrs: inp.value }
          }));
        });
      };

      let formCards = await readFormCards();
      console.log(`[Reconcile] OT edit form has ${formCards.length} task cards. App has ${order.tasks.length} tasks.`);
      console.log(`[Reconcile] Form cards:`, JSON.stringify(formCards));

      // Add missing task cards if app has more tasks than form
      const diff = order.tasks.length - formCards.length;
      if (diff > 0) {
        console.log(`[Reconcile] Form has ${formCards.length} cards, but app has ${order.tasks.length}. Clicking AGREGAR TAREA ${diff} times...`);
        for (let i = 0; i < diff; i++) {
          const added = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, a, [role="button"], .btn'));
            const addBtn = btns.find(b => b.textContent.toLowerCase().includes('agregar tarea'));
            if (addBtn) {
              addBtn.click();
              return true;
            }
            return false;
          });
          console.log(`[Reconcile] Added task card ${i + 1}: ${added}`);
          await delay(2500); // Wait for the new card to render
        }
        // Re-read form cards after adding
        formCards = await readFormCards();
        console.log(`[Reconcile] After adding missing tasks: ${formCards.length} cards now in form`);
      }

      // 5. DELETE duplicate/extra cards (reverse order to keep indices valid)
      //    Strategy: for each app task, find ONE matching form card. Mark rest for deletion.
      const usedCardIndices = new Set();
      const cardToAppMap = []; // for each form card index: matched app task index or -1

      for (let ai = 0; ai < order.tasks.length; ai++) {
        const appTask = order.tasks[ai];
        const { employeeLabel, finalDescription } = resolveAndMapEmployee(appTask);
        for (let ci = 0; ci < formCards.length; ci++) {
          if (usedCardIndices.has(ci)) continue;
          const card = formCards[ci];
          const empOk = cleanStr(card.employee).includes(cleanStr(employeeLabel)) || cleanStr(employeeLabel).includes(cleanStr(card.employee)) || card.employee === '';
          const descOk = cleanStr(card.description).includes(cleanStr(appTask.descripcion)) || cleanStr(appTask.descripcion).includes(cleanStr(card.description)) || card.description === '';
          if (empOk || descOk) { // loose match — one of the two must match
            usedCardIndices.add(ci);
            cardToAppMap[ci] = ai;
            break;
          }
        }
      }

      // Cards not matched to any app task → delete
      const toDeleteIndices = [];
      for (let ci = 0; ci < formCards.length; ci++) {
        if (!usedCardIndices.has(ci)) toDeleteIndices.push(ci);
      }

      if (toDeleteIndices.length > 0) {
        console.log(`[Reconcile] Deleting ${toDeleteIndices.length} extra/unmatched cards at indices: ${toDeleteIndices.join(', ')}`);
        // Delete in reverse order
        for (let di = toDeleteIndices.length - 1; di >= 0; di--) {
          const cardIdx = toDeleteIndices[di];
          page.once('dialog', d => d.accept().catch(() => {}));
          const deleted = await page.evaluate((idx) => {
            const clickConfirm = () => {
              // Look for common confirmation dialog buttons in Vue/Bootstrap modals
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
            // Fallback: global search
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

      // 6. Update each remaining card with correct hours and realizada
      for (let ci = 0; ci < formCards.length; ci++) {
        const appIdx = cardToAppMap[ci];
        if (appIdx === undefined || appIdx === null || appIdx < 0) continue;
        const appTask = order.tasks[appIdx];
        if (!appTask) continue;

        // 1. Fill/Fix Centro de Costo if empty
        const ccCatalog = db.getCatalogs().centrosCosto || [];
        const ccObj = ccCatalog.find(c => c.value === appTask.centroCosto);
        const ccLabel = ccObj ? ccObj.label : appTask.centroCosto;
        console.log(`[Reconcile] Card #${ci} Centro de Costo: "${ccLabel}" (ID: ${appTask.centroCosto})`);
        await page.evaluate((idx, taskCC) => {
          // Find CC select by proximity inside target card container
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
        await delay(1000);

        // 2. Fill Employee if empty, placeholder, or mismatch
        const { employeeLabel } = resolveAndMapEmployee(appTask);
        const isEmpEmptyOrPlaceholder = formCards[ci].employee === '' || 
                                       formCards[ci].employee.toLowerCase().includes('seleccionar') || 
                                       formCards[ci].employee.toLowerCase().includes('buscar');
        const isEmpMismatch = !cleanStr(formCards[ci].employee).includes(cleanStr(employeeLabel)) && 
                              !cleanStr(employeeLabel).includes(cleanStr(formCards[ci].employee));
                              
        if (isEmpEmptyOrPlaceholder || isEmpMismatch) {
          console.log(`[Reconcile] Card #${ci} needs employee. Current: "${formCards[ci].employee}". Target: "${employeeLabel}"...`);
          const empFilled = await fillTaskEmployeeSearchableSelect(page, ci, employeeLabel);
          console.log(`[Reconcile] Card #${ci} employee select result: ${empFilled}`);
          await delay(2000);
        }

        // 3. Fill/Fix Description if empty or doesn't match what the app has
        const { finalDescription } = resolveAndMapEmployee(appTask);
        const localDescBase = (appTask.descripcion || '').replace(/[.,\s]/g, '').toLowerCase();
        const taxesDescBase = extractBaseDescription(formCards[ci].description);
        const descMismatch = formCards[ci].description === '' ||
          (localDescBase !== taxesDescBase &&
           !cleanStr(formCards[ci].description).includes(cleanStr(finalDescription)) &&
           !cleanStr(finalDescription).includes(cleanStr(formCards[ci].description)));
        if (descMismatch) {
          console.log(`[Reconcile] Card #${ci} description mismatch (Taxes: "${formCards[ci].description}"). Writing: "${finalDescription}"...`);
          const descId = await page.evaluate((idx) => {
            const textareas = Array.from(document.querySelectorAll('textarea[id^="descripcion_"], textarea[placeholder*="Describe las actividades"]'));
            const el = textareas[idx];
            if (!el) return null;
            if (!el.id) el.id = `rc-desc-${idx}-${Date.now()}`;
            return el.id;
          }, ci);
          if (descId) {
            const sel = `#${descId}`;
            await page.focus(sel).catch(() => {});
            await page.click(sel).catch(() => {});
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await page.type(sel, finalDescription, { delay: 50 });
            await page.evaluate((s) => {
              const el = document.querySelector(s);
              if (el) {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, sel);
            await delay(1000);
          }
        }

        // horasEstimadas is already decimal hours from the timer — use directly, no H.MM conversion.
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
            console.log(`[Reconcile] Card #${ci} Using timer-derived hours: ${expectedHoursNum}h`);
          }
        }
        const expectedHours = expectedHoursNum.toFixed(2); // Keep period decimal separator for number input value
        const expectedHoursNum2 = parseFloat(expectedHoursNum.toFixed(2)); // numeric version for comparisons
        const actualHours = parseFloat(formCards[ci].hours.replace(',', '.')) || 0;
        const hoursOk = (actualHours === 0 && expectedHoursNum2 > 0) ? false : (Math.abs(expectedHoursNum2 - actualHours) <= 0.05);
        const realizadaNeeded = appTask.status === 'Finalizada' && !formCards[ci].realizada;

        console.log(`[Reconcile] Card #${ci}: hours exp=${expectedHours} actual=${actualHours} ok=${hoursOk} | realizada needed=${realizadaNeeded}`);

        if (!hoursOk) {
          console.log(`[Reconcile] Fixing hours for card #${ci} to "${expectedHours}"...`);
          const hoursId = await page.evaluate((idx) => {
            const inputs = Array.from(document.querySelectorAll('input[id^="horas_"], input[name="horas_estimadas"]'));
            const el = inputs[idx];
            if (!el) return null;
            if (!el.id) el.id = `rc-hours-${idx}-${Date.now()}`;
            return el.id;
          }, ci);
          if (hoursId) {
            const sel = `#${hoursId}`;
            await page.focus(sel).catch(() => {});
            await page.click(sel, { clickCount: 3 }).catch(() => {});
            await page.keyboard.press('Backspace').catch(() => {});
            await page.type(sel, expectedHours, { delay: 50 });
            await page.keyboard.press('Tab').catch(() => {}); // Force Vue blur to persist the value
            await page.evaluate((s) => {
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

        if (realizadaNeeded) {
          console.log(`[Reconcile] Toggling Realizada for card #${ci}...`);
          await page.evaluate((idx) => {
            const switches = Array.from(document.querySelectorAll('.custom-control.custom-switch'));
            const sw = switches[idx];
            if (!sw) return;
            const cb = sw.querySelector('input[type="checkbox"]');
            if (cb && !cb.checked) {
              const lbl = sw.querySelector('label, .custom-control-label');
              if (lbl) lbl.click(); else cb.click();
            }
          }, ci);
          await delay(3500); // 3.5s delay to show toggled Realizada switch in slow motion
          appTask.taxesRealizadaSynced = true;
        }

        appTask.synced = true;
        appTask.needsHoursUpdate = false;
      }

      db.updateWorkOrder(orderId, { tasks: order.tasks });
      console.log(`[Reconcile] Pausing 4 seconds for user visual check before clicking GUARDAR...`);
      await delay(4000);
      const guardarBtnId = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('guardar'));
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
      // or if there are validation error banners displayed.
      const isFormStillOpen = await page.evaluate(() => {
        const formInput = document.querySelector('input[name="horas_estimadas"], textarea[id^="descripcion_"]');
        return !!formInput;
      });

      const validationErrors = await page.evaluate(() => {
        const alertElements = document.querySelectorAll('.alert-danger, .is-invalid, .invalid-feedback, .text-danger');
        return Array.from(alertElements)
          .map(el => el.textContent.trim())
          .filter(t => t.length > 0 && t.length < 200 && !t.includes('soporte') && !t.includes('comprobante'));
      });

      if (isFormStillOpen || validationErrors.length > 0) {
        const errMsg = validationErrors.length > 0
          ? `Errores de validación en la web de Taxes al guardar edición: ${validationErrors.join(" | ")}`
          : "El formulario de edición de OT no se guardó correctamente (sigue abierto tras hacer click en Guardar).";
        throw new Error(errMsg);
      }

      db.updateWorkOrder(orderId, {
        syncStatus: 'success',
        syncDate: new Date().toISOString(),
        syncError: null,
        autoSyncRetryCount: 0
      });

      console.log(`[Reconcile] Running verification for OT #${order.interno}...`);
      await verifyWorkOrderWithPage(page, orderId);

      await browser.close(); releaseBrowserLock();
      try { db.purgeSyncedOrders(5); } catch(pe) { console.error('[Purge] Error:', pe.message); }
      return { success: true, message: `Orden ${otNumClean} reconciliada correctamente.` };
    }



    console.log("Navigating directly to Ordenes de Trabajo list page...");
    await safeGoto(page, `${settings.portalUrl}/tms/produccion/ot`, { timeout: 30000 });
    
    // Wait for the portal page catalogs/dropdowns to load completely
    console.log("Waiting for filter selects to load on list page...");
    await page.waitForSelector('select', { timeout: 10000 }).catch(() => {});
    
    console.log("Waiting for catalog select options to populate on list page...");
    await page.waitForFunction(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      return selects.some(s => s.options.length > 50);
    }, { timeout: 15000 }).catch(e => console.log("Timeout waiting for select options on list page: " + e.message));
    
    await delay(1000); // Small extra buffer to be absolutely sure Vue is ready

    console.log("Clicking NUEVO button to open create form modal...");
    const nuevoClicked = await page.evaluate(() => {
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
    let targetResponsable = order.responsable;
    if (targetResponsable === 'AUTO') {
      console.log("Resolving Responsable automatically...");
      const profileName = await page.evaluate(() => {
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
      } else if (list.length > 0) {
        // Fallback to Cesar Belocures if we can find him in the list, otherwise first item
        const defaultBelocures = list.find(r => r.label.toLowerCase().includes('belocures'));
        targetResponsable = defaultBelocures ? defaultBelocures.label : list[0].label;
        console.log("Fallback to matching/default Responsable in list:", targetResponsable);
      } else {
        targetResponsable = "Belocures, Cesar Hernán"; // Absolute fallback
        console.log("Fallback to default Responsable string:", targetResponsable);
      }
    }

    // Fill searchable select fields (Rodado and Responsable)
    const rodadoFilled = await fillSearchableSelect(page, 'Rodado', order.rodado);
    if (!rodadoFilled) throw new Error("No se pudo seleccionar el Rodado. Asegúrese de que el valor sea válido.");

    const respFilled = await fillSearchableSelect(page, 'Responsable', targetResponsable);
    if (!respFilled) throw new Error("No se pudo seleccionar el Responsable. Asegúrese de que el valor sea válido.");

    // Fill standard fields (Clasificacion, Interno, Date, Horario, Incidente)
    console.log("Filling standard fields (Clasificación, Interno, Date, Horario, Incidente)...");
    
    // Fill Fecha (Set both visible and hidden)
    await page.evaluate((dateVal) => {
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
    await page.evaluate((time) => {
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
    await page.evaluate((clasificacionVal, internoVal, incidenteVal) => {
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
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const addBtn = btns.find(b => b.textContent.includes('TAREA') || b.textContent.includes('Tarea') || b.textContent.includes('+'));
          if (addBtn) addBtn.click();
        });
      }
      
      await delay(1500); // Wait for task form to expand

      // 1. Select Centro de Costo
      console.log(`Setting Centro de Costo to: "${task.centroCosto}" (label: "${ccLabel}")`);
      const ccSelectSelector = `select#centro_costo_${i}`;
      await page.waitForSelector(ccSelectSelector, { timeout: 5000 });
      await page.evaluate((sel, taskCC) => {
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
      const hoursInputId = await page.evaluate((idx) => {
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
        await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (el) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          }
        }, sel);

        await delay(800);

        // Verification step — re-read the input to confirm the value stuck
        const hoursVerify = await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return { found: false };
          return { found: true, value: el.value };
        }, sel).catch(() => ({ found: false }));

        hoursFilled = hoursVerify.found && Math.abs(parseFloat(String(hoursVerify.value).replace(',', '.')) - parseFloat(String(hoursVal3).replace(',', '.'))) < 0.005;
        console.log(`[Hours] Verification attempt 1 — value: "${hoursVerify.value}", expected: "${hoursVal3}", success: ${hoursFilled}`);

        // Attempt 2 (fallback): use Vue-compatible native setter if value didn't stick
        if (!hoursFilled) {
          console.log(`[Hours] Attempt 1 failed. Retrying with Vue-native setter for index ${i}...`);
          await page.evaluate((s, val) => {
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

          const hoursVerify2 = await page.evaluate((s) => {
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
        const toggled = await page.evaluate((index) => {
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
        const verifyState = await page.evaluate((index) => {
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
    const saved = await page.evaluate(() => {
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
    const errors = await page.evaluate(() => {
      // Filter out global informative banners, only check real invalid field labels or error popups
      const alertElements = document.querySelectorAll('.alert-danger, .is-invalid, .invalid-feedback, .text-danger');
      return Array.from(alertElements)
        .map(el => el.textContent.trim())
        .filter(t => t.length > 0 && t.length < 200 && !t.includes('soporte') && !t.includes('comprobante'));
    });

    const isModalClosed = await page.evaluate(() => {
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
    const taxesOrderNumber = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('.toast, .b-toast, .alert, div, p, span'));
      for (const el of elements) {
        const text = el.textContent.trim();
        const match = text.match(/Orden de Trabajo N\s*(\d+)\s*Creada/i) || 
                      text.match(/Orden\s*N\s*(\d+)/i) || 
                      text.match(/N\s*(\d+)\s*Creada/i);
        if (match && match[1]) {
          return match[1];
        }
      }
      return null;
    });

    if (taxesOrderNumber) {
      console.log(`Successfully captured Taxes Order Number: ${taxesOrderNumber}`);
    } else {
      console.log("Warning: Could not capture Taxes Order Number from toast notifications.");
    }

    // Close any visible toast notifications by clicking close button inside them
    await page.evaluate(() => {
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

    db.updateWorkOrder(orderId, {
      syncStatus: "success",
      syncDate: new Date().toISOString(),
      syncError: null,
      autoSyncRetryCount: 0,
      taxesOrderNumber: taxesOrderNumber || null,
      tasks: updatedTasks
    });

    console.log(`Running post-sync verification for brand new OT #${order.interno}...`);
    await verifyWorkOrderWithPage(page, orderId);

    await browser.close(); releaseBrowserLock();
    return { success: true, message: `Orden ${order.interno} sincronizada correctamente.` };

  } catch (error) {
    console.error(`Sync failed for OT #${order.interno}:`, error);
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
    if (browser) await browser.close(); releaseBrowserLock();
    return { success: false, message: error.message };
  }
}

// 2b. AGENT VERIFICATION SYSTEM FOR OT TASKS
async function verifyWorkOrderWithPage(page, orderId) {
  const order = db.getWorkOrderById(orderId);
  if (!order || !order.taxesOrderNumber) {
    console.log(`[Verify] Cannot verify: order not found or missing Taxes OT number.`);
    return;
  }
  const settings = db.getSettings();
  const otNumClean = String(order.taxesOrderNumber).replace(/^#/, '').trim();
  console.log(`[Verify] Starting tasks-list verification for OT #${order.interno} (Taxes: ${otNumClean})...`);

  try {
    // 1. Navigate to tasks list
    await safeGoto(page, `${settings.portalUrl}/tms/produccion/tareas`, { timeout: 30000 });

    // 1b. Robust selector resolution for the OT search input
    // Since Taxes removed placeholders on their search inputs, we locate the input next to label or by name/type.
    const getSearchInputId = async () => {
      return await page.evaluate(() => {
        const cleanText = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        const labels = Array.from(document.querySelectorAll('label'));
        
        // 1. Try finding label containing "buscar por numero" and "ot"
        let targetLabel = labels.find(l => {
          const txt = cleanText(l.textContent);
          return txt.includes('buscar por numero') && txt.includes('ot');
        });
        
        // 2. Try finding label containing just "numero" or "nro" or "ot"
        if (!targetLabel) {
          targetLabel = labels.find(l => {
            const txt = cleanText(l.textContent);
            return txt === 'numero' || txt === 'nro' || txt === 'ot';
          });
        }
        
        if (targetLabel) {
          if (targetLabel.getAttribute('for')) {
            const input = document.getElementById(targetLabel.getAttribute('for'));
            if (input) return '#' + input.id;
          }
          // Search closest field-compact or form-group container
          const container = targetLabel.closest('.field-compact, .form-group, .col, [class*="col"]') || targetLabel.parentElement?.parentElement;
          if (container) {
            const input = container.querySelector('input[type="text"], input:not([type="hidden"])');
            if (input) {
              if (!input.id) input.id = 'tmp-search-ot-input';
              return '#' + input.id;
            }
          }
        }
        
        // Suffix fallback: search by name/id containing "ot" or "numero"
        const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
        const otInput = inputs.find(i => {
          const labelText = cleanText(i.closest('.field-compact, .form-group, [class*="col"]')?.textContent || '');
          return labelText.includes('buscar por numero') || labelText.includes('titulo de ot') || labelText === 'numero' || labelText === 'ot';
        });
        if (otInput) {
          if (!otInput.id) otInput.id = 'tmp-search-ot-input-fallback';
          return '#' + otInput.id;
        }
        
        return null;
      });
    };

    let searchInpSelector = await getSearchInputId();
    if (!searchInpSelector) {
      console.warn(`[Verify] Search input not resolved. Reloading and retrying...`);
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      searchInpSelector = await getSearchInputId();
    }

    if (!searchInpSelector) {
      try {
        const path = require('path');
        await page.screenshot({ path: path.join(__dirname, 'public', 'last_verify_error.png'), fullPage: true });
        console.warn(`[Verify] Debug screenshot saved to public/last_verify_error.png. URL: ${page.url()}`);
      } catch (se) {}
      throw new Error(`No se pudo localizar el selector del input de búsqueda de OT en la página.`);
    }

    await page.waitForSelector(searchInpSelector, { timeout: 15000 });
    await delay(1500);

    // 2. Search for OT number with Vue events triggered via native setter
    console.log(`[Verify] Searching for OT ${otNumClean} in tasks page...`);
    await page.evaluate((sel, val) => {
      const el = document.querySelector(sel);
      if (el) {
        // Use HTMLInputElement native setter to bypass Vue reactivity cache
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, val);
        } else {
          el.value = val;
        }
        el.focus();
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      }
    }, searchInpSelector, otNumClean);

    // Keyboard simulation fallback and focus trigger
    await page.focus(searchInpSelector).catch(() => {});
    await page.click(searchInpSelector, { clickCount: 3 }).catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.type(otNumClean, { delay: 60 }).catch(() => {});
    await page.keyboard.press('Tab').catch(() => {});
    await delay(500);

    // 3. Set 'Realizada' filter to 'Todos' (empty string) to make completed tasks visible
    console.log(`[Verify] Setting 'Realizada' filter to 'Todos'...`);
    await page.evaluate(() => {
      const cleanText = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const labels = Array.from(document.querySelectorAll('label, div, span'));
      const targetLabel = labels.find(l => cleanText(l.textContent) === 'realizada');
      if (targetLabel) {
        const container = targetLabel.closest('.field-compact, .form-group') || targetLabel.parentElement?.parentElement;
        if (container) {
          const select = container.querySelector('select');
          if (select) {
            select.value = ''; // 'Todos'
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }
    });
    await delay(500);

    const clickedBuscar = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
      const btn = buttons.find(b => b.textContent.trim().toUpperCase().includes('BUSCAR') || (b.value || '').toUpperCase().includes('BUSCAR'));
      if (btn) { btn.click(); return true; }
      return false;
    });
    console.log(`[Verify] Clicked BUSCAR button via JS: ${clickedBuscar}`);
    await delay(4500); // Wait for results to load

    // Helper to read table tasks
    const readTableTasks = async () => {
      return await page.evaluate(() => {
        const cleanText = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        const tables = Array.from(document.querySelectorAll('table'));
        const taskTable = tables.find(t => {
          const headers = Array.from(t.querySelectorAll('th')).map(h => cleanText(h.textContent));
          const hasTecnico = headers.some(h => h.includes('tecnico') || h.includes('empleado'));
          const hasDesc = headers.some(h => h.includes('descripcion') || h.includes('detalle'));
          return hasTecnico && hasDesc;
        });

        if (!taskTable) return [];

        const headers = Array.from(taskTable.querySelectorAll('th')).map(h => cleanText(h.textContent));
        const empIdx = headers.findIndex(h => h.includes('tecnico') || h.includes('empleado'));
        const hrsIdx = headers.findIndex(h => h.includes('uni/hrs') || h.includes('horas') || h.includes('hs'));
        const descIdx = headers.findIndex(h => h.includes('descripcion') || h.includes('detalle'));
        const realIdx = headers.findIndex(h => h.includes('estado') || h.includes('realizada'));

        const rows = Array.from(taskTable.querySelectorAll('tbody tr'));
        if (rows.length === 0) return [];
        if (rows.length === 1 && (rows[0].textContent.includes('No hay datos') || rows[0].textContent.includes('mostrar'))) return [];

        return rows.map((r, idx) => {
          const cells = Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim());
          
          return {
            rowIndex: idx,
            employee: empIdx !== -1 ? cells[empIdx] : '',
            hours: hrsIdx !== -1 ? cells[hrsIdx] : '0',
            description: descIdx !== -1 ? cells[descIdx] : '',
            realizada: realIdx !== -1 ? (cells[realIdx].toUpperCase().includes('FIN') ? 'SI' : 'NO') : 'NO'
          };
        });
      });
    };

    let tableTasks = await readTableTasks();
    const initialTableRowCount = tableTasks.length; // Save before loop mutates tableTasks
    console.log(`[Verify] Found ${tableTasks.length} tasks in Taxes table:`, JSON.stringify(tableTasks));

    // Helper: use the page's own "Empleado" filter (in addition to the OT number
    // already typed) to narrow results down to the exact task server-side —
    // far more reliable than comparing description text on our end.
    const filterByEmployee = async (employeeName) => {
      try {
        const empFieldId = await page.evaluate(() => {
          // Try locating input by placeholder first
          const directInput = document.querySelector('input[placeholder*="Empleado" i], input[placeholder*="Operario" i], input[placeholder*="Responsable" i], input[placeholder*="Personal" i]');
          if (directInput) {
            if (!directInput.id) directInput.id = 'tmp-emp-filter-' + Date.now();
            return '#' + directInput.id;
          }
          // Fallback to labels search
          const labels = Array.from(document.querySelectorAll('label, div, span'));
          const empLabel = labels.find(l => {
            const txt = l.textContent.trim().toLowerCase();
            return txt.includes('empleado') || txt.includes('operario') || txt.includes('responsable') || txt.includes('personal');
          });
          let container = empLabel ? (empLabel.closest('.form-group') || empLabel.parentElement) : null;
          if (container) {
            const input = container.querySelector('input[type="text"], input.searchable-input, input:not([type])');
            if (input) {
              if (!input.id) input.id = 'tmp-emp-filter-' + Date.now();
              return '#' + input.id;
            }
          }
          return null;
        });
        if (!empFieldId) {
          console.warn('[Verify] Could not locate the "Empleado" filter field on the tasks page.');
          return false;
        }
        await page.click(empFieldId, { clickCount: 3 }).catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await page.keyboard.type(employeeName, { delay: 60 });
        await delay(1200);
        // If a dropdown suggestion appears, pick the first option
        await page.evaluate(() => {
          const opts = Array.from(document.querySelectorAll('[id^="searchable-select-dropdown-"] li, .multiselect__option, .dropdown-item, ul[role="listbox"] li'));
          if (opts.length > 0) opts[0].click();
        }).catch(() => {});
        await delay(500);
        const clicked = await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().toUpperCase().includes('BUSCAR'));
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (clicked) await delay(3500);
        return clicked;
      } catch (e) {
        console.warn('[Verify] Employee-narrowed search failed:', e.message);
        return false;
      }
    };

    const clearEmployeeFilterAndResearch = async () => {
      await page.evaluate(() => {
        const directInput = document.querySelector('input[placeholder*="Empleado" i], input[placeholder*="Operario" i], input[placeholder*="Responsable" i], input[placeholder*="Personal" i]');
        if (directInput) {
          directInput.value = '';
          directInput.dispatchEvent(new Event('input', { bubbles: true }));
          directInput.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
        const labels = Array.from(document.querySelectorAll('label, div, span'));
        const empLabel = labels.find(l => {
          const txt = l.textContent.trim().toLowerCase();
          return txt.includes('empleado') || txt.includes('operario') || txt.includes('responsable') || txt.includes('personal');
        });
        const container = empLabel ? (empLabel.closest('.form-group') || empLabel.parentElement) : null;
        const input = container ? container.querySelector('input') : null;
        if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
      }).catch(() => {});
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().toUpperCase().includes('BUSCAR'));
        if (btn) btn.click();
      }).catch(() => {});
      await delay(3000);
    };

    const errors = [];
    let madeChanges = false;
    const clean = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

    for (let idx = 0; idx < order.tasks.length; idx++) {
      const t = order.tasks[idx];
      const { employeeLabel, finalDescription } = resolveAndMapEmployee(t);
      // Compute expected hours using the same logic as syncWorkOrder:
      // horasEstimadas is already decimal hours from the timer — use directly, no conversion.
      let expectedHours = parseFloat(String(t.horasEstimadas || '0').replace(',', '.')) || 0;
      if (expectedHours === 0 && t.timerHistory && Array.isArray(t.timerHistory) && t.timerHistory.length >= 1) {
        let totalMs = 0;
        const sorted = [...t.timerHistory].sort((a, b) => a.timestamp - b.timestamp);
        let currentStart = null;
        sorted.forEach(ev => {
          const type = String(ev.type || '').trim().toLowerCase();
          if (type.startsWith('inici') || type.startsWith('reanud')) currentStart = ev.timestamp;
          else if ((type.startsWith('paus') || type.startsWith('fin')) && currentStart !== null) {
            totalMs += (ev.timestamp - currentStart);
            currentStart = null;
          }
        });
        if (totalMs > 0) expectedHours = Math.round((totalMs / 3600000) * 100) / 100;
      }
      if (expectedHours === 0 && t.status === 'Finalizada') expectedHours = 0.01;
      const expectedHoursStr = expectedHours.toFixed(2);
      const expectedHoursComma = expectedHoursStr.replace('.', ',');

      // Find matching row
      let matchedRow = null;
      if (tableTasks.length > 0) {
        for (const row of tableTasks) {
          const empOk = clean(row.employee).includes(clean(employeeLabel)) || clean(employeeLabel).includes(clean(row.employee));
          const descOk = clean(row.description).includes(clean(t.descripcion)) || clean(t.descripcion).includes(clean(row.description)) ||
                         clean(row.description).includes(clean(finalDescription)) || clean(finalDescription).includes(clean(row.description));
          if (empOk && descOk) {
            matchedRow = row;
            break;
          }
        }
        // Fallback: if description was garbled/truncated on Taxes (typing issue on creation),
        // match by employee alone when unambiguous (only one task and one candidate row).
        if (!matchedRow && order.tasks.length === 1) {
          const empCandidates = tableTasks.filter(row =>
            clean(row.employee).includes(clean(employeeLabel)) || clean(employeeLabel).includes(clean(row.employee))
          );
          if (empCandidates.length === 1) {
            console.log(`[Verify] Task #${idx+1}: description didn't match but employee matched uniquely. Using loose match.`);
            matchedRow = empCandidates[0];
          }
        }

        // Fallback: match by description alone (when Taxes shows vehicle in employee column).
        // Only use if description is unique across all table rows to avoid false positives.
        if (!matchedRow && tableTasks.length > 0) {
          const descCandidates = tableTasks.filter(row =>
            clean(row.description).includes(clean(t.descripcion)) ||
            clean(t.descripcion).includes(clean(row.description)) ||
            clean(row.description).includes(clean(finalDescription)) ||
            clean(finalDescription).includes(clean(row.description))
          );
          if (descCandidates.length === 1) {
            console.log(`[Verify] Task #${idx+1}: employee column shows vehicle, matched by description alone.`);
            matchedRow = descCandidates[0];
          }
        }

        // Last resort positional fallback: if there is exactly one unmatched row and one unmatched task, pair them.
        if (!matchedRow && tableTasks.length === order.tasks.length && tableTasks[idx]) {
          const alreadyMatchedRowIndices = new Set();
          // We can't know previously matched indices here without refactor, so only use when single row
          if (tableTasks.length === 1) {
            console.log(`[Verify] Task #${idx+1}: using positional fallback (single row in table).`);
            matchedRow = tableTasks[0];
          }
        }
      }

      let usedNarrowedSearch = false;
      if (!matchedRow) {
        console.log(`[Verify] Task #${idx+1}: no match by description. Narrowing search on Taxes by employee "${employeeLabel}"...`);
        const narrowed = await filterByEmployee(employeeLabel);
        if (narrowed) {
          usedNarrowedSearch = true;
          const narrowedTasks = await readTableTasks();
          if (narrowedTasks.length >= 1) {
            matchedRow = narrowedTasks.find(row =>
              clean(row.employee).includes(clean(employeeLabel)) || clean(employeeLabel).includes(clean(row.employee))
            ) || (narrowedTasks.length === 1 ? narrowedTasks[0] : null);
            if (matchedRow) {
              console.log(`[Verify] Task #${idx+1}: found via employee-narrowed search.`);
              tableTasks = narrowedTasks; // keep this view active — matchedRow.rowIndex refers to it
            }
          }
        }
      }

      if (!matchedRow) {
        if (usedNarrowedSearch) await clearEmployeeFilterAndResearch().then(() => readTableTasks()).then(t => { tableTasks = t; });
        console.warn(`[Verify] Task #${idx+1} (${employeeLabel}) NOT found in tasks list table.`);
        errors.push(`Tarea #${idx + 1} (${employeeLabel}): No encontrada en el listado de tareas`);
      } else {
        const actualHours = parseFloat(String(matchedRow.hours).replace(',', '.')) || 0;
        // Also flag mismatch if tarea is Finalizada and Taxes shows 0 hours (blank field)
        const hoursOk = (actualHours === 0 && (expectedHours > 0 || t.status === 'Finalizada'))
          ? false
          : (expectedHours === 0 ? true : (Math.abs(expectedHours - actualHours) <= 0.05));
        const expectedRealizada = t.status === 'Finalizada' ? 'SI' : 'NO';
        const realizadaOk = matchedRow.realizada.toUpperCase() === expectedRealizada;
        const localDescBase = (t.descripcion || '').replace(/[.,\s]/g, '').toLowerCase();
        const taxesDescBase = extractBaseDescription(matchedRow.description);
        const descOkFinal = localDescBase === taxesDescBase ||
          clean(matchedRow.description).includes(clean(finalDescription)) ||
          clean(finalDescription).includes(clean(matchedRow.description));

        console.log(`[Verify] Task #${idx+1}: hours expected=${expectedHoursStr} actual=${actualHours} OK=${hoursOk} | realizada expected=${expectedRealizada} actual=${matchedRow.realizada} OK=${realizadaOk} | description OK=${descOkFinal}`);

        if (!hoursOk || !realizadaOk || !descOkFinal) {
          console.log(`[Verify] Mismatch found for Task #${idx+1}. Clicking eye edit button...`);
          const eyeBtnId = await page.evaluate((rowIdx) => {
            const cleanText = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
            const tables = Array.from(document.querySelectorAll('table'));
            const taskTable = tables.find(t => {
              const headers = Array.from(t.querySelectorAll('th')).map(h => cleanText(h.textContent));
              return headers.some(h => h.includes('tecnico') || h.includes('empleado')) &&
                     headers.some(h => h.includes('descripcion') || h.includes('detalle'));
            });
            if (!taskTable) return null;
            const rows = Array.from(taskTable.querySelectorAll('tbody tr'));
            const row = rows[rowIdx];
            const btn = row ? row.querySelector('a, button') : null;
            if (!btn) return null;
            const id = 'tmp-eye-btn-' + Date.now();
            btn.id = id;
            return id;
          }, matchedRow.rowIndex);
          if (eyeBtnId) {
            try { await page.click(`#${eyeBtnId}`); }
            catch (e) { console.warn(`[Verify] Native click on eye button raised: ${e.message} (likely navigated away)`); }
          }
          
          await delay(5000); // Wait for task edit page/modal to load

          // Update description if mismatch
          if (!descOkFinal) {
            console.log(`[Verify] Setting description to "${finalDescription}"...`);
            const descId = await page.evaluate(() => {
              const el = document.querySelector('textarea[name="descripcion"]') || document.querySelector('textarea');
              if (!el) return null;
              if (!el.id) el.id = 'temp-fix-desc-single-' + Date.now();
              return el.id;
            });
            if (descId) {
              const sel = `#${descId}`;
              await page.focus(sel).catch(() => {});
              await page.click(sel).catch(() => {});
              await page.keyboard.down('Control');
              await page.keyboard.press('A');
              await page.keyboard.up('Control');
              await page.keyboard.press('Backspace');
              await page.type(sel, finalDescription, { delay: 50 });
              await page.evaluate((s) => {
                const el = document.querySelector(s);
                if (el) {
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }, sel);
              await delay(1500);
              madeChanges = true;
            }
          }

          // Update hours if mismatch
          if (!hoursOk) {
            // HTML5 input type="number" programmatic value expects period (.) separator
            const expectedHoursDot = expectedHoursStr;
            console.log(`[Verify] Setting hours to "${expectedHoursDot}" via keyboard simulation...`);

            const hoursInputId = await page.evaluate(() => {
              // 1. Try the exact CSS path discovered in the Taxes DOM for the hours input.
              let el = document.querySelector('div.card-body > div > p > div:nth-child(2) > div:nth-child(1) > input');
              // 2. Fallback to the known input name used by the Taxes edit form.
              if (!el) el = document.querySelector('input[id^="horas_"], input[name="horas_estimadas"]');
              // 3. Last resort — fuzzy match
              if (!el) {
                const inputs = Array.from(document.querySelectorAll('input'));
                el = inputs.find(i => {
                  const name = (i.name || '').toLowerCase();
                  const placeholder = (i.placeholder || '').toLowerCase();
                  const label = i.closest('.form-group')?.textContent.toLowerCase() || '';
                  return name.includes('horas') || placeholder.includes('horas') || label.includes('horas');
                });
              }
              if (!el) return null;
              if (!el.id) el.id = 'temp-fix-hours-single-' + Date.now();
              return el.id;
            });

            let hoursStuck = false;
            if (hoursInputId) {
              const sel = `#${hoursInputId}`;

              // Attempt 1: keyboard simulation
              await page.focus(sel).catch(() => {});
              await page.click(sel, { clickCount: 3 }).catch(() => {});
              await page.keyboard.press('Backspace').catch(() => {});
              await page.type(sel, expectedHoursDot, { delay: 50 });
              await page.keyboard.press('Tab').catch(() => {}); // Force Vue blur to persist the value
              await page.evaluate((s) => {
                const el = document.querySelector(s);
                if (el) {
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
                }
              }, sel);

              await delay(800);

              // Re-read to confirm it stuck
              const recheck = await page.evaluate((s) => {
                const el = document.querySelector(s);
                return el ? { value: el.value } : null;
              }, sel).catch(() => null);

              if (recheck) {
                const recheckNum = parseFloat(String(recheck.value).replace(',', '.'));
                const expectedNum = parseFloat(expectedHoursDot);
                hoursStuck = !Number.isNaN(recheckNum) && Math.abs(recheckNum - expectedNum) < 0.005;
                console.log(`[Verify] Re-read hours value attempt 1: "${recheck.value}" — stuck: ${hoursStuck}`);
              }

              // Attempt 2 (fallback): Vue-native setter if keyboard didn't work
              if (!hoursStuck) {
                console.log(`[Verify] Hours not stuck after attempt 1. Retrying with Vue-native setter...`);
                await page.evaluate((s, val) => {
                  const el = document.querySelector(s);
                  if (!el) return;
                  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
                  if (nativeSetter && nativeSetter.set) {
                    nativeSetter.set.call(el, val);
                  } else {
                    el.value = val;
                  }
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
                }, sel, expectedHoursDot);
                await delay(500);

                const recheck2 = await page.evaluate((s) => {
                  const el = document.querySelector(s);
                  return el ? { value: el.value } : null;
                }, sel).catch(() => null);

                if (recheck2) {
                  const recheckNum2 = parseFloat(String(recheck2.value).replace(',', '.'));
                  const expectedNum = parseFloat(expectedHoursDot);
                  hoursStuck = !Number.isNaN(recheckNum2) && Math.abs(recheckNum2 - expectedNum) < 0.005;
                  console.log(`[Verify] Re-read hours value attempt 2: "${recheck2.value}" — stuck: ${hoursStuck}`);
                }
              }
            } else {
              console.warn(`[Verify] Could not locate hours input to edit.`);
            }

            madeChanges = true;
          }

          // Update status if mismatch
          if (!realizadaOk) {
            console.log(`[Verify] Setting status to ${t.status}...`);
            await page.evaluate((targetStatus) => {
              const container = document.querySelector('.modal-content, .modal-dialog, .modal') || document;
              // 1. Try to find a select dropdown first
              const selects = Array.from(container.querySelectorAll('select'));
              const statusSelect = selects.find(s => {
                const options = Array.from(s.options).map(o => o.text.toLowerCase().trim());
                const hasSiNo = options.includes('si') && options.includes('no');
                const label = s.closest('.form-group, .col, [class*="col"]')?.textContent.toLowerCase() || '';
                return options.includes('finalizada') || options.includes('realizada') || options.includes('pendiente') || label.includes('realizada') || label.includes('estado') || hasSiNo;
              });
              if (statusSelect) {
                const opt = Array.from(statusSelect.options).find(o => 
                  o.text.toLowerCase().includes(targetStatus.toLowerCase()) || 
                  (targetStatus === 'Finalizada' && (o.text.toLowerCase() === 'si' || o.text.toLowerCase().includes('finalizada'))) || 
                  (targetStatus === 'Pendiente' && (o.text.toLowerCase() === 'no' || o.text.toLowerCase().includes('pendiente')))
                );
                if (opt) {
                  statusSelect.value = opt.value;
                  statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
                  statusSelect.dispatchEvent(new Event('input', { bubbles: true }));
                  return true;
                }
              }
              // 2. Try to find switch toggle or checkbox on the task edit page
              const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
              const cb = checkboxes.find(c => {
                const id = (c.id || '').toLowerCase();
                const name = (c.name || '').toLowerCase();
                const label = c.closest('.custom-control, .form-group')?.textContent.toLowerCase() || '';
                return id.includes('realizada') || id.includes('completada') || name.includes('realizada') || label.includes('realizada') || label.includes('completada') || label.includes('finalizada');
              }) || checkboxes[0];

              if (cb) {
                const shouldBeChecked = targetStatus === 'Finalizada';
                if (cb.checked !== shouldBeChecked) {
                  const label = cb.closest('.custom-control, .form-group')?.querySelector('label');
                  if (label) {
                    label.click();
                  } else {
                    cb.click();
                  }
                  cb.dispatchEvent(new Event('change', { bubbles: true }));
                  cb.dispatchEvent(new Event('input', { bubbles: true }));
                  return true;
                }
              }
              return false;
            }, t.status);
            await delay(1500);
            madeChanges = true;
          }

          // Click GUARDAR
          console.log(`[Verify] Saving task edit...`);
          const guardarBtnId2 = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('guardar'));
            if (!btn) return null;
            const id = 'tmp-guardar-verify-btn-' + Date.now();
            btn.id = id;
            return id;
          });
          if (guardarBtnId2) {
            try { await page.click(`#${guardarBtnId2}`); }
            catch (e) { console.warn(`[Verify] Native click on GUARDAR raised: ${e.message} (likely navigated away)`); }
            await delay(4500);
            console.log(`[Verify] Task edit saved successfully!`);
          }

          // Return to tasks list page and search again to verify remaining tasks
          await safeGoto(page, `${settings.portalUrl}/tms/produccion/tareas`, { timeout: 30000 });
          searchInpSelector = await getSearchInputId() || searchInpSelector;
          await page.waitForSelector(searchInpSelector, { timeout: 15000 });
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) {
              el.focus();
              el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, searchInpSelector);
          await delay(200);
          await page.keyboard.type(otNumClean, { delay: 80 });
          await delay(500);
          const clickedBuscarRetry = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
            const btn = buttons.find(b => b.textContent.trim().toUpperCase().includes('BUSCAR') || (b.value || '').toUpperCase().includes('BUSCAR'));
            if (btn) { btn.click(); return true; }
            return false;
          });
          console.log(`[Verify] Clicked BUSCAR button via JS (retry): ${clickedBuscarRetry}`);
          await delay(4500);

          tableTasks = await readTableTasks();
        } else if (usedNarrowedSearch) {
          // Task was fine as-is — still need to reset the employee filter
          // before the next task in this loop searches again.
          await clearEmployeeFilterAndResearch();
          tableTasks = await readTableTasks();
        }
      }
    }

    // Double-check verification after all edits are done to ensure they actually persisted in Taxes.
    if (madeChanges && errors.length === 0) {
      console.log(`[Verify] Re-reading tasks table to verify that edits actually persisted in Taxes...`);
      tableTasks = await readTableTasks();

      // DIAG: log what the table contains after re-read
      const diagHeaders = await page.evaluate(() => Array.from(document.querySelectorAll('table th')).map(h => `"${h.textContent.trim()}"`).join(', '));
      console.log(`[Verify-DIAG] Table headers: ${diagHeaders}`);
      console.log(`[Verify-DIAG] tableTasks after double-read: ${JSON.stringify(tableTasks)}`);

      for (let idx = 0; idx < order.tasks.length; idx++) {
        const t = order.tasks[idx];
        const { employeeLabel, finalDescription } = resolveAndMapEmployee(t);
        const expectedHours = parseFloat(String(t.horasEstimadas || '0').replace(',', '.')) || 0;
        const expectedHoursStr = expectedHours.toFixed(2);
        
        let matchedRow = null;
        if (tableTasks.length > 0) {
          for (const row of tableTasks) {
            const empOk = clean(row.employee).includes(clean(employeeLabel)) || clean(employeeLabel).includes(clean(row.employee));
            const descOk = clean(row.description).includes(clean(t.descripcion)) || clean(t.descripcion).includes(clean(row.description)) ||
                           clean(row.description).includes(clean(finalDescription)) || clean(finalDescription).includes(clean(row.description));
            if (empOk && descOk) {
              matchedRow = row;
              break;
            }
          }
          if (!matchedRow && order.tasks.length === 1) {
            const empCandidates = tableTasks.filter(row =>
              clean(row.employee).includes(clean(employeeLabel)) || clean(employeeLabel).includes(clean(row.employee))
            );
            if (empCandidates.length === 1) matchedRow = empCandidates[0];
          }
        }

        if (!matchedRow) {
          errors.push(`Tarea #${idx + 1} (${employeeLabel}): No se encontró la tarea tras guardar cambios.`);
        } else {
          const actualHours = parseFloat(String(matchedRow.hours).replace(',', '.')) || 0;
          // hoursOk: mismatch if expected > 0 but actual is 0 (blank in Taxes).
          // Also block archiving if tarea is Finalizada and has 0 hours in Taxes (field was blank/unfilled).\
          const hoursOk = (actualHours === 0 && (expectedHours > 0 || t.status === 'Finalizada')) 
            ? false 
            : (expectedHours === 0 ? true : (Math.abs(expectedHours - actualHours) <= 0.05));
          const expectedRealizada = t.status === 'Finalizada' ? 'SI' : 'NO';
          const realizadaOk = matchedRow.realizada.toUpperCase() === expectedRealizada;
          const localDescBase = (t.descripcion || '').replace(/[.,\s]/g, '').toLowerCase();
          const taxesDescBase = extractBaseDescription(matchedRow.description);
          const descOkFinal = localDescBase === taxesDescBase ||
            clean(matchedRow.description).includes(clean(finalDescription)) ||
            clean(finalDescription).includes(clean(matchedRow.description));

          console.log(`[Verify-DIAG] Task #${idx+1} double-check: expected=${expectedHoursStr} actual=${actualHours} hoursOk=${hoursOk} realizada=${realizadaOk} desc=${descOkFinal}`);
          
          if (!hoursOk) {
            errors.push(`Tarea #${idx + 1} (${employeeLabel}): Horas en blanco o no coincidieron tras guardar (esperadas: ${expectedHoursStr}, en Taxes: ${actualHours}).`);
          }
          if (!realizadaOk) {
            console.log(`[Verify-Info] Tarea #${idx + 1} (${employeeLabel}): Estado reporta '${matchedRow.realizada}' en listado secundario de Taxes (esperado: ${expectedRealizada}), pero tarea y horas existen correctamente.`);
          }
          if (!descOkFinal) {
            errors.push(`Tarea #${idx + 1} (${employeeLabel}): Descripción no coincidió tras guardar.`);
          }
        }
      }
    }


    const count = (order.verifiedCount || 0) + 1;
    if (errors.length > 0) {
      console.log(`[Verify] Completed with issues:`, errors);
      db.updateWorkOrder(orderId, { verifiedStatus: 'error', verifiedCount: count, verifiedError: errors.join(' | '), lastVerifyAttempt: new Date().toISOString() });
    } else {
      const msg = madeChanges ? 'Verificado y corregido correctamente vía listado de tareas.' : 'Todo correcto, verificado sin cambios necesarios.';
      console.log(`[Verify] SUCCESS. ${msg}`);
      const shouldArchive = order.estadoUnidad !== 'fuera_de_servicio';
      const updatePayload = {
        verifiedStatus: 'success',
        verifiedCount: count,
        verifiedError: null,
        lastVerifyAttempt: new Date().toISOString()
      };
      if (shouldArchive) {
        updatePayload.archived = true;
        updatePayload.archivedAt = new Date().toISOString();
      } else {
        updatePayload.archived = false;
        updatePayload.archivedAt = null;
      }
      db.updateWorkOrder(orderId, updatePayload);
      if (shouldArchive) {
        console.log(`[Verify] Order ${orderId} fully verified and synced. Auto-archived to history.`);
      } else {
        console.log(`[Verify] Order ${orderId} fully verified and synced. Kept active because unit is Out of Service.`);
      }
    }

  } catch (err) {
    console.error(`[Verify] Error:`, err);
    const count = (order.verifiedCount || 0) + 1;
    db.updateWorkOrder(orderId, {
      verifiedStatus: 'error',
      verifiedCount: count,
      verifiedError: `Error del verificador: ${err.message}`,
      lastVerifyAttempt: new Date().toISOString()
    });
    throw err;
  }
}

// Standalone verify function for manual verification triggers
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
  try {
    browser = await launchBrowser();
    const page = await autoLogin(browser, username, password, settings.portalUrl);
    await verifyWorkOrderWithPage(page, orderId);

    await browser.close(); releaseBrowserLock();
    
    // Get updated status
    const updated = db.getWorkOrderById(orderId);
    return { 
      success: updated.verifiedStatus === 'success', 
      status: updated.verifiedStatus, 
      error: updated.verifiedError, 
      count: updated.verifiedCount 
    };
  } catch (error) {
    if (browser) await browser.close();
    releaseBrowserLock();
    return { success: false, message: error.message };
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

  // Reset any orders stuck in 'syncing' back to 'pending' on startup
  try {
    const orders = db.getWorkOrders();
    for (const o of orders) {
      if (o.syncStatus === 'syncing') {
        console.log(`Resetting stuck sync status for order ID: ${o.id} to 'pending' on worker startup.`);
        db.updateWorkOrder(o.id, { syncStatus: 'pending', syncError: 'Sincronización interrumpida por reinicio del servidor.' });
      }
    }
  } catch (err) {
    console.error("Error resetting stuck orders on startup:", err);
  }

 // Auto-fix settings for tasks that failed verification (wrong hours/status in Taxes)
  const MAX_AUTO_VERIFY_RETRIES = 5;
  const AUTO_VERIFY_COOLDOWN_MS = 2 * 60 * 1000; // wait 2 min between auto retries per order

  while (isWorkerRunning) {
    try {
      const orders = db.getWorkOrders();
      const pendingOrder = orders.find(o => o.syncStatus === 'pending');

      if (pendingOrder) {
        console.log(`Found pending Work Order ID: ${pendingOrder.id}. Launching sync...`);
        await syncWorkOrder(pendingOrder.id);
      } else {
        // No new orders to sync — look for orders that need an automatic retry:
        // either their tasks failed the control check (verifiedStatus: 'error'),
        // or a later re-sync attempt itself failed (syncStatus: 'error') even
        // though they were already synced before (have a taxesOrderNumber).
        const brokenOrder = orders.find(o => {
          if (!o.taxesOrderNumber) return false;

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
          // Use the full sync/reconcile function (not just verify) so it can also
          // create tasks that are completely missing on Taxes, not just fix field mismatches.
          await syncWorkOrder(brokenOrder.id);
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
const MAX_PARALLEL_BROWSERS = 2;

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

  // Process groups in batches of MAX_PARALLEL_BROWSERS
  for (let i = 0; i < groupList.length; i += MAX_PARALLEL_BROWSERS) {
    const batch = groupList.slice(i, i + MAX_PARALLEL_BROWSERS);
    await Promise.allSettled(batch.map(group => verifyGroupWithBrowser(group, settings)));
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
    for (const orderId of group.ids) {
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await Promise.race([
            verifyWorkOrderWithPage(page, orderId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout: verificaci\u00f3n tard\u00f3 m\u00e1s de 90 segundos')), 90000))
          ]);
          lastErr = null;
          break; // success — go to next order
        } catch (err) {
          lastErr = err;
          console.warn(`[VerifyAll] Order ${orderId} attempt ${attempt}/2 failed: ${err.message}`);
          if (attempt < 2) {
            console.log(`[VerifyAll] Retrying order ${orderId} after 3s...`);
            await delay(3000);
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
          verifiedError: `Error del agente (2 intentos): ${lastErr.message}`
        });
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

module.exports = {
  startWorker,
  stopWorker,
  syncWorkOrder,
  verifyWorkOrder,
  verifyMultipleOrders,
  scrapeCatalogs,
  isScraping,
  getIsScraping: () => isScraping,
  autoLogin
};
