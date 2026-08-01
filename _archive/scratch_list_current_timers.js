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

async function listAllTimers() {
  const orders = await get('/api/orders');
  if (!Array.isArray(orders)) return;

  const running = [];
  orders.forEach(o => {
    (o.tasks || []).forEach(t => {
      if (t && (t.timerStarted || (t.timerStart !== null && t.timerStart > 0))) {
        running.push({
          orderId: o.id,
          ot: o.taxesOrderNumber || o.id,
          interno: o.interno,
          rodado: o.rodado,
          clasificacion: o.clasificacion,
          empleado: t.empleado,
          descripcion: t.descripcion,
          timerStart: t.timerStart,
          timerStartISO: t.timerStart ? new Date(t.timerStart).toISOString() : 'N/A',
          createdAt: o.createdAt
        });
      }
    });
  });

  console.log(`Total running timers currently in DB: ${running.length}`);
  running.sort((a, b) => (b.timerStart || 0) - (a.timerStart || 0));

  console.log('\nAll running timers sorted by newest start time:');
  running.forEach((t, i) => {
    console.log(`${i+1}. [OT ${t.ot} | Int ${t.interno} | Mech ${t.empleado} | Sector ${t.clasificacion}] Start: ${t.timerStartISO} | Desc: ${t.descripcion}`);
  });
}

listAllTimers();
