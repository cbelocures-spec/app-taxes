const fs = require('fs');
const https = require('https');

const SHEET_URL = 'https://script.google.com/macros/s/AKfycbxbCEe6CPyN02seTWd0VO6mYljxX5N27oT2I5QJS-ZtRn7_PTm-oxI54p5rN6RCU8anVA/exec';

function sendPost(targetUrl, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const u = new URL(targetUrl);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(sendPost(res.headers.location, payload));
      }
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    req.on('error', err => resolve(err.message));
    req.write(data);
    req.end();
  });
}

async function fastMigrate() {
  const dbFile = './db.json';
  if (!fs.existsSync(dbFile)) return;

  const raw = fs.readFileSync(dbFile, 'utf8');
  const dbData = JSON.parse(raw);
  const allOrders = dbData.workOrders || [];
  const catalogs = dbData.catalogs || {};

  const empleadosList = catalogs.empleados || [];
  const ccList = catalogs.centrosCosto || [];

  const resolveEmployee = (val) => {
    if (!val) return "—";
    const found = empleadosList.find(e => String(e.value) === String(val) || e.label === val);
    return found ? found.label : String(val);
  };

  const resolveCC = (val, clasif) => {
    if (!val && !clasif) return "MECANICA";
    const vStr = String(val || '').trim();
    const found = ccList.find(c => String(c.value) === vStr || c.label === vStr);
    if (found) return found.label;
    if (clasif) return String(clasif).toUpperCase();
    return vStr || "MECANICA";
  };

  const historicalToMigrate = allOrders.filter(o => o.archived || o.deleted);
  const activeToKeep = allOrders.filter(o => !o.archived && !o.deleted);

  console.log(`Starting FAST parallel migration of ${historicalToMigrate.length} orders...`);

  // Process in parallel batches of 15 requests
  const BATCH_SIZE = 15;
  let successCount = 0;

  for (let i = 0; i < historicalToMigrate.length; i += BATCH_SIZE) {
    const batch = historicalToMigrate.slice(i, i + BATCH_SIZE);
    const promises = batch.map(order => {
      const task = (order.tasks && order.tasks[0]) ? order.tasks[0] : {};
      let fechaStr = order.fechaEntrega || order.fecha || "—";
      if (fechaStr.includes("T")) {
        try { fechaStr = new Date(fechaStr).toLocaleDateString("es-AR"); } catch(e){}
      }

      const payload = {
        accion: "crear",
        fecha: fechaStr,
        interno: String(order.interno || "—"),
        ot: String(order.taxesOrderNumber || order.taxesOtId || order.id || "—"),
        centro_costo: resolveCC(order.centroCosto || task.centroCosto, order.clasificacion),
        categoria: String(order.clasificacion || order.tipoUnidad || "MECANICA"),
        empleado: resolveEmployee(task.empleado),
        horas: String(task.horasEstimadas || "0.01"),
        descripcion: String(task.descripcion || order.incidente || "—"),
        status: "Finalizada",
        hora_inicio: "08:00",
        hora_fin: "17:00",
        estado_sincro: order.syncStatus === 'success' ? "OK Sincronizada" : (order.syncStatus || "Sincronizada")
      };

      return sendPost(SHEET_URL, payload);
    });

    const results = await Promise.all(promises);
    successCount += results.filter(r => String(r).includes("success") || String(r).includes("Paso 1")).length;
    console.log(`Progress: ${Math.min(i + BATCH_SIZE, historicalToMigrate.length)}/${historicalToMigrate.length} migrated...`);
  }

  console.log(`\n✅ FAST MIGRATION COMPLETED! Total: ${successCount} orders.`);

  // Backup and purge db.json
  fs.writeFileSync(`./db_backup_before_purge_${Date.now()}.json`, raw);
  dbData.workOrders = activeToKeep;
  fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));

  console.log(`✅ Local db.json purged down to ${activeToKeep.length} active orders!`);
}

fastMigrate();
