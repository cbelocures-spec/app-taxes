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

// Helper to wait
const delay = ms => new Promise(res => setTimeout(res, ms));

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
        await element.click();
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
      // Find all form-groups or containers that have a label matching the text
      const allLabels = Array.from(document.querySelectorAll('label'));
      for (const lbl of allLabels) {
        if (lbl.textContent.trim().toLowerCase().includes(label.toLowerCase())) {
          // Find the parent container
          const parent = lbl.closest('.form-group') || lbl.closest('.taxes-form-group') || lbl.parentElement;
          if (parent) {
            // Look for the searchable-input inside this container
            const searchInput = parent.querySelector('.searchable-input, input[type="text"]');
            // Look for any hidden input in the same container (usually name ends with _id or is rodado_id / syj_empleado_id)
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

      // Focus and clear existing text reliably via keyboard
      await page.focus(searchSelector);
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await delay(300);

      // Type the query
      await page.type(searchSelector, query, { delay: 50 });
      await delay(2000); // Wait for dropdown to appear and filter

      // Click the first visible option in the dropdown that matches
      const optionClicked = await page.evaluate((targetVal) => {
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

        // 1. Try exact or full match containing targetVal
        let matched = filteredOptions.find(el => {
          const textClean = clean(el.textContent);
          return textClean.includes(targetClean) || targetClean.includes(textClean);
        });

        // 2. Try partial match: if targetVal contains brand and interno, check both
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

        // 3. Fallback: click the very first visible option in the dropdown
        if (!matched && filteredOptions.length > 0) {
          matched = filteredOptions[0];
        }

        if (matched) {
          matched.click();
          return { success: true, text: matched.textContent.trim() };
        }

        return { success: false };
      }, searchValue);

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
    const searchSelector = `#empleado_${index} input.searchable-input`;
    const hiddenSelector = `#empleado_${index} input[type="hidden"]`;

    // Try queries one by one
    const queriesToTry = [employeeName];
    if (employeeName.includes(' ')) {
      const words = employeeName.split(/\s+/).filter(w => w.length > 2);
      // For "Cuba Orosco, Kevin Genaro", words would be ["Cuba", "Orosco,", "Kevin", "Genaro"]
      // Let's add individual words as search options
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
          return text.length > 0 && !text.includes('opciones') && !text.includes('cargando') && !text.includes('no hay');
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

    console.log(`Failed to select employee after all search queries.`);
    return false;
  } catch (error) {
    console.error(`Error filling task employee searchable select:`, error);
    return false;
  }
}


// Automate login to Taxes.com.ar
async function autoLogin(page, username, password, portalUrl) {
  console.log(`Navigating to ${portalUrl}/admin ...`);
  await page.goto(`${portalUrl}/admin`, { waitUntil: 'networkidle2', timeout: 30000 });

  // Check if we are already logged in (look for user profile or logout button)
  const isLoggedIn = await page.evaluate(() => {
    return document.body.textContent.includes('BELOCURES') || 
           document.body.textContent.includes('Inicio') || 
           document.querySelector('.profile-user') !== null;
  });

  if (isLoggedIn) {
    console.log("Already logged in to Taxes portal.");
    return true;
  }

  console.log("Not logged in. Attempting credentials entry...");
  
  // Wait for login fields
  await page.waitForSelector('input', { timeout: 10000 }).catch(() => {});

  // Fill credentials using generic selectors (common in login pages)
  let usernameFilled = false;
  let passwordFilled = false;

  const inputs = await page.$$('input');
  for (const input of inputs) {
    const type = await page.evaluate(el => el.type, input);
    const name = await page.evaluate(el => el.name || '', input);
    
    if ((type === 'text' || type === 'email' || name.includes('email') || name.includes('user')) && !usernameFilled) {
      await input.focus();
      await input.type(username);
      usernameFilled = true;
    } else if ((type === 'password' || name.includes('pass')) && !passwordFilled) {
      await input.focus();
      await input.type(password);
      passwordFilled = true;
    }
  }

  if (!usernameFilled || !passwordFilled) {
    // Try filling using labels
    await fillInputByLabel(page, 'usuario', username);
    await fillInputByLabel(page, 'email', username);
    await fillInputByLabel(page, 'contraseña', password);
    await fillInputByLabel(page, 'password', password);
  }

  // Click login button
  console.log("Clicking login button...");
  const clicked = await clickByText(page, 'Iniciar Sesión', 'button') || 
                  await clickByText(page, 'Ingresar', 'button') ||
                  await clickByText(page, 'Login', 'button') ||
                  await page.click('button[type="submit"]').then(() => true).catch(() => false);

  if (!clicked) {
    // Trigger enter key
    await page.keyboard.press('Enter');
  }

  // Wait for navigation or welcome dashboard
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await delay(3000);

  // Check if login succeeded
  const loginSuccess = await page.evaluate(() => {
    return document.body.textContent.includes('Inicio') || 
           document.body.textContent.includes('Bienvenido') ||
           document.body.textContent.includes('Taller');
  });

  if (!loginSuccess) {
    throw new Error("Credenciales inválidas o error al iniciar sesión en Taxes.com.ar");
  }

  console.log("Login successful!");
  return true;
}

// 1. SCRAPE CATALOGS FUNCTION
async function scrapeCatalogs() {
  if (isScraping) return { success: false, message: "Catalog scraping is already running." };
  isScraping = true;
  
  const settings = db.getSettings();
  if (!settings.username || !settings.password) {
    isScraping = false;
    return { success: false, message: "Faltan configurar las credenciales en Ajustes." };
  }

  console.log("Starting automatic catalog extraction from Taxes.com.ar...");
  let browser = null;

  try {
    db.saveSettings({ catalogSyncStatus: "syncing", catalogSyncError: null });
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Login
    await autoLogin(page, settings.username, settings.password, settings.portalUrl);

    // ============================================================
    // STEP A: SCRAPE ALL RODADOS FROM FLOTA > FLOTA (limit 999)
    // ============================================================
    console.log("=== PASO 1/3: Scrapeando FLOTA completa ===");
    console.log("Navigating to Flota > Flota page...");
    await page.goto(`${settings.portalUrl}/tms/produccion/flota`, { waitUntil: 'networkidle2', timeout: 30000 });
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
    await page.goto(`${settings.portalUrl}/tms/produccion/ot`, { waitUntil: 'networkidle2', timeout: 30000 });
    
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
    isScraping = false;
    await browser.close();
    return { success: true, message: `Catálogos actualizados: ${rodados.length} rodados, ${mergedEmpleados.length} empleados, ${mergedCentros.length} centros de costo.` };
  } catch (error) {
    console.error("Error scraping catalogs:", error);
    db.saveSettings({ catalogSyncStatus: "error", catalogSyncError: error.message });
    isScraping = false;
    if (browser) await browser.close();
    return { success: false, message: `Error al extraer catálogos: ${error.message}` };
  }
}

// 2. SYNCHRONIZE SINGLE WORK ORDER
async function syncWorkOrder(orderId) {
  const order = db.getWorkOrderById(orderId);
  if (!order) return { success: false, message: "Order not found" };

  const settings = db.getSettings();
  if (!settings.username || !settings.password) {
    db.updateWorkOrder(orderId, {
      syncStatus: "error",
      syncError: "Faltan configurar las credenciales en Ajustes."
    });
    return { success: false, message: "Missing credentials" };
  }

  console.log(`\n=== Starting Background Sync for OT #${order.interno} (ID: ${order.id}) ===`);
  db.updateWorkOrder(orderId, { syncStatus: "syncing", syncError: null });

  let browser = null;

  try {
    // Launch browser
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // 1. LOGIN
    await autoLogin(page, settings.username, settings.password, settings.portalUrl);

    // 2. NAVIGATE TO NEW WORK ORDER FORM
    console.log("Navigating directly to Ordenes de Trabajo list page...");
    await page.goto(`${settings.portalUrl}/tms/produccion/ot`, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(3000);

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
      
      if (!matched && settings.username) {
        const prefix = settings.username.split('@')[0].toLowerCase();
        const cleanedPrefix = cleanText(prefix);
        matched = list.find(r => cleanText(r.label).includes(cleanedPrefix));
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
        const option = Array.from(classSelect.options).find(opt => opt.text.toLowerCase().includes(clasificacionVal.toLowerCase()) || opt.value === clasificacionVal);
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

      // Resolve employee name from local catalog to match dynamically on portal
      const employeeCatalog = db.getCatalogs().empleados || [];
      const employeeObj = employeeCatalog.find(e => e.value === task.empleado);
      const employeeLabel = employeeObj ? employeeObj.label : task.empleado;
      console.log(`Resolved employee ID "${task.empleado}" to label: "${employeeLabel}"`);

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
          const opt = Array.from(ccSelect.options).find(o => 
            o.text.toLowerCase().includes(taskCC.toLowerCase()) || 
            o.value.toLowerCase() === taskCC.toLowerCase()
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

      // 3. Fill Hours
      console.log(`Setting Horas Estimadas: ${task.horasEstimadas}`);
      const hoursSelector = `input#horas_${i}`;
      await page.focus(hoursSelector);
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.type(hoursSelector, String(task.horasEstimadas), { delay: 50 });

      // 4. Fill Description
      console.log(`Setting Descripción: "${task.descripcion}"`);
      const descSelector = `textarea#descripcion_${i}`;
      await page.focus(descSelector);
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.type(descSelector, task.descripcion, { delay: 50 });

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
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
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

    console.log(`Sync success for OT #${order.interno}!`);
    db.updateWorkOrder(orderId, {
      syncStatus: "success",
      syncDate: new Date().toISOString(),
      syncError: null
    });

    await browser.close();
    return { success: true, message: `Orden ${order.interno} sincronizada correctamente.` };

  } catch (error) {
    console.error(`Sync failed for OT #${order.interno}:`, error);
    db.updateWorkOrder(orderId, {
      syncStatus: "error",
      syncError: error.message
    });
    if (browser) await browser.close();
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

  while (isWorkerRunning) {
    try {
      const orders = db.getWorkOrders();
      const pendingOrder = orders.find(o => o.syncStatus === 'pending');
      
      if (pendingOrder) {
        console.log(`Found pending Work Order ID: ${pendingOrder.id}. Launching sync...`);
        await syncWorkOrder(pendingOrder.id);
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

module.exports = {
  startWorker,
  stopWorker,
  syncWorkOrder,
  scrapeCatalogs,
  isScraping
};
