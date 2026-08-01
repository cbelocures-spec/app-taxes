const https = require('https');
const fs = require('fs');

const host = 'app-taxes-production-ec67.up.railway.app';
const username = 'paniol@contenedoreshugo.com.ar';

function get(path) {
  return new Promise((resolve) => {
    https.get({
      hostname: host,
      path: path,
      headers: { 'x-user-username': username }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// Minimal DOM mock
const mockElements = {
  'order-search': { value: '' },
  'orders-list-container': { innerHTML: '' },
  'grid-working': { innerHTML: '' },
  'grid-paused': { innerHTML: '' },
  'list-free-employees': { innerHTML: '' },
  'count-working': { textContent: '' },
  'count-paused': { textContent: '' }
};

global.window = {};
global.document = {
  getElementById: (id) => mockElements[id] || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {}
};
global.localStorage = {
  getItem: () => null,
  setItem: () => {}
};
global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) });

const appJs = fs.readFileSync('public/app.js', 'utf8');
eval(appJs);

async function testRenderAll() {
  const orders = await get('/api/orders');
  console.log(`Fetched ${orders.length} orders from Railway.`);

  global.activeOrders = orders;
  global.cachedCatalogs = { rodados: [], empleados: [], centrosCosto: [] };

  try {
    renderOrders();
    const html = mockElements['orders-list-container'].innerHTML;
    console.log("✅ renderOrders() completed successfully!");
    console.log(`Container HTML length: ${html.length}`);
    console.log(`Contains 'order-card': ${html.includes('order-card')}`);
  } catch (e) {
    console.error("❌ renderOrders() THREW AN ERROR:", e.message, e.stack);
  }
}

testRenderAll();
