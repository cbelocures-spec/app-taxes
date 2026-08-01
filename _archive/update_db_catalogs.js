const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'db.json');
const prodCatsPath = path.join(__dirname, 'prod_catalogs.json');

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const prodCats = JSON.parse(fs.readFileSync(prodCatsPath, 'utf8'));

db.catalogs = db.catalogs || {};
db.catalogs.rodados = prodCats.rodados || [];
if (prodCats.empleados && prodCats.empleados.length) db.catalogs.empleados = prodCats.empleados;
if (prodCats.responsables && prodCats.responsables.length) db.catalogs.responsables = prodCats.responsables;
if (prodCats.centrosCosto && prodCats.centrosCosto.length) db.catalogs.centrosCosto = prodCats.centrosCosto;

fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
console.log('Successfully updated db.json with', db.catalogs.rodados.length, 'rodados!');
