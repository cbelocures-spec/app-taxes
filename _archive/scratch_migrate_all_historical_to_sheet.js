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

async function migrate() {
  const dbFile = './db.json';
  if (!fs.existsSync(dbFile)) {
    console.error("db.json not found!");
    return;
  }

  const raw = fs.readFileSync(dbFile, 'utf8');
  const dbData = JSON.parse(raw);
  const allOrders = dbData.workOrders || [];
  const catalogs = dbData.catalogs || {};

  const empleadosList = catalogs.empleados || [];
  const ccList = catalogs.centrosCosto || [];

  // Helper resolvers
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

  // Filter historical / deleted orders to migrate
  const historicalToMigrate = allOrders.filter(o => o.archived || o.deleted);
  const activeToKeep = allOrders.filter(o => !o.archived && !o.deleted);

  console.log(`Total orders in DB: ${allOrders.length}`);
  console.log(`Orders to migrate to Google Sheets: ${historicalToMigrate.length}`);
  console.log(`Active orders to keep in db.json: ${activeToKeep.length}`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < historicalToMigrate.length; i++) {
    const order = historicalToMigrate[i];
    const task = (order.tasks && order.tasks[0]) ? order.tasks[0] : {};
    
    // Format timestamp
    let fechaStr = order.fechaEntrega || order.fecha || "—";
    if (fechaStr.includes("T")) {
      try { fechaStr = new Date(fechaStr).toLocaleDateString("es-AR"); } catch(e){}
    }

    const ccResolved = resolveCC(order.centroCosto || task.centroCosto, order.clasificacion);
    const empResolved = resolveEmployee(task.empleado);

    const payload = {
      accion: "crear",
      fecha: fechaStr,
      interno: String(order.interno || "—"),
      ot: String(order.taxesOrderNumber || order.taxesOtId || order.id || "—"),
      centro_costo: ccResolved,
      categoria: String(order.clasificacion || order.tipoUnidad || "MECANICA"),
      empleado: empResolved,
      horas: String(task.horasEstimadas || "0.01"),
      descripcion: String(task.descripcion || order.incidente || "—"),
      status: "Finalizada",
      hora_inicio: "08:00",
      hora_fin: "17:00",
      estado_sincro: order.syncStatus === 'success' ? "OK Sincronizada" : (order.syncStatus || "Sincronizada")
    };

    try {
      const resText = await sendPost(SHEET_URL, payload);
      if (resText.includes("success") || resText.includes("Paso 1") || resText.includes("registrada")) {
        successCount++;
      } else {
        failCount++;
      }
    } catch(err) {
      failCount++;
    }

    if ((i + 1) % 25 === 0 || i === historicalToMigrate.length - 1) {
      console.log(`Migrated ${i + 1}/${historicalToMigrate.length} orders... (Success: ${successCount}, Fail: ${failCount})`);
    }

    // Small 30ms pause
    await new Promise(r => setTimeout(r, 30));
  }

  console.log(`\n=== MIGRATION TO GOOGLE SHEETS FINISHED ===`);
  console.log(`Successfully migrated ${successCount} orders with full names and resolved labels.`);

  // Backup original db.json before purge
  fs.writeFileSync(`./db_backup_before_purge_${Date.now()}.json`, raw);

  // Purge db.json to keep ONLY active orders!
  dbData.workOrders = activeToKeep;
  fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));

  console.log(`\n✅ db.json PURGED AND CLEANED!`);
  console.log(`New db.json count: ${dbData.workOrders.length} active orders.`);
}

migrate();
