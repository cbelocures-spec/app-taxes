const fs = require('fs');

try {
  const data = JSON.parse(fs.readFileSync('./db.json', 'utf8'));
  console.log("=== CENTROS DE COSTO CATALOG ===");
  console.log(data.catalogs ? data.catalogs.centrosCosto : "No catalogs.centrosCosto");
  console.log("\n=== EMPLEADOS CATALOG (first 10) ===");
  console.log((data.catalogs ? data.catalogs.empleados : []).slice(0, 10));
} catch (e) {
  console.error("Error reading catalogs:", e.message);
}
