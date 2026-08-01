const https = require('https');

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

function isHerreriaOrder(order) {
  if (!order) return false;
  const cls = String(order.clasificacion || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const rod = String(order.rodado || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const inter = String(order.interno || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

  if (cls.includes('herrer') || cls.includes('herrera')) return true;

  const herreriaKeywords = [
    'prensa', 'fabricacion', 'contenedor', 'roll-off', 'roll off', 'volquete', 'canasto', 'rep. contenedor', 'rep. caja', 'rep. volquete'
  ];
  for (const kw of herreriaKeywords) {
    if (rod.includes(kw) || inter.includes(kw)) return true;
  }
  return false;
}

function isEdilicioOrder(order) {
  if (!order) return false;
  const cls = String(order.clasificacion || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  return cls.includes('edilic');
}

async function testSectors() {
  const activeOrders = await get('/api/orders');
  if (!Array.isArray(activeOrders)) {
    console.error("Failed to fetch active orders");
    return;
  }

  console.log(`Total active orders returned by /api/orders: ${activeOrders.length}`);

  const herreriaList = activeOrders.filter(o => isHerreriaOrder(o));
  const edilicioList = activeOrders.filter(o => isEdilicioOrder(o));
  const tallerList = activeOrders.filter(o => !isHerreriaOrder(o) && !isEdilicioOrder(o));

  console.log(`Herrería Tab Count: ${herreriaList.length}`);
  console.log(`Edilicio Tab Count: ${edilicioList.length}`);
  console.log(`Taller Tab Count:   ${tallerList.length}`);

  if (tallerList.length === 0) {
    console.log("\nSample clasificaciones of the active orders:");
    const classifications = {};
    activeOrders.forEach(o => {
      classifications[o.clasificacion] = (classifications[o.clasificacion] || 0) + 1;
    });
    console.log(classifications);
  }
}

testSectors();
