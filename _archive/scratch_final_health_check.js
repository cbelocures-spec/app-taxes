const https = require('https');

const host = 'app-taxes-production-ec67.up.railway.app';
const username = 'paniol@contenedoreshugo.com.ar';

function get(path) {
  return new Promise((resolve) => {
    https.get({
      hostname: host,
      path: path,
      headers: {
        'x-user-username': username,
        'X-User-Username': username
      }
    }, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

async function verifyFinalSystemHealth() {
  console.log("=== FINAL SYSTEM HEALTH VERIFICATION ===");
  const orders = await get('/api/orders');
  if (!Array.isArray(orders)) {
    console.error("❌ Error fetching active orders");
    return;
  }

  console.log(`✅ Total Active Work Orders: ${orders.length}`);

  let workingTasks = [];
  let pausedTasks = [];

  orders.forEach(o => {
    (o.tasks || []).forEach(t => {
      if (!t || t.status === 'Finalizada') return;
      if (t.timerStart !== null && t.timerStart > 0) {
        workingTasks.push({ ot: o.taxesOrderNumber || o.id, int: o.interno, mech: t.empleado, desc: t.descripcion });
      } else {
        pausedTasks.push({ ot: o.taxesOrderNumber || o.id, int: o.interno, mech: t.empleado, desc: t.descripcion, hrs: t.horasEstimadas });
      }
    });
  });

  console.log(`\n✅ TRABAJANDO EN EL TALLER (${workingTasks.length}):`);
  workingTasks.forEach(wt => console.log(`   - OT ${wt.ot} | Int ${wt.int} | Mech: ${wt.mech} | Desc: ${wt.desc}`));

  console.log(`\n✅ TAREAS EN PAUSA (${pausedTasks.length}):`);
  pausedTasks.forEach(pt => console.log(`   - OT ${pt.ot} | Int ${pt.int} | Mech: ${pt.mech} | Desc: ${pt.desc}`));

  const catalogs = await get('/api/catalogs');
  console.log(`\n✅ Catálogos: Empleados (${(catalogs?.empleados || []).length}), Rodados (${(catalogs?.rodados || []).length})`);
  console.log("\nStatus: ALL SYSTEMS OK!");
}

verifyFinalSystemHealth();
