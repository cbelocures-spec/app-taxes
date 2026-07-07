const fs = require('fs');
const path = require('path');
const https = require('https');

const localDbPath = path.resolve(__dirname, 'db.json');
const HOST = 'app-taxes-production-ec67.up.railway.app';
const PATH = '/api/admin/upload-db';
const SECRET = process.env.ADMIN_SECRET || 'Paniol2015';

console.log("=== DB Uploader: Local PC → Railway Cloud ===");

if (!fs.existsSync(localDbPath)) {
  console.error(`Error: local database not found at ${localDbPath}`);
  process.exit(1);
}

let dbData;
try {
  const content = fs.readFileSync(localDbPath, 'utf8');
  dbData = JSON.parse(content);
} catch (e) {
  console.error(`Error reading or parsing local db.json:`, e.message);
  process.exit(1);
}

const payload = JSON.stringify({
  secret: SECRET,
  dbData: dbData
});

console.log(`Loaded local database.`);
console.log(`  Orders: ${dbData.workOrders ? dbData.workOrders.length : 0}`);
console.log(`  Rodados: ${dbData.catalogs && dbData.catalogs.rodados ? dbData.catalogs.rodados.length : 0}`);
console.log(`  Employees: ${dbData.catalogs && dbData.catalogs.empleados ? dbData.catalogs.empleados.length : 0}`);
console.log(`  Users count: ${dbData.users ? Object.keys(dbData.users).length : 0}`);

console.log(`\nUploading to https://${HOST}${PATH} ...`);

const options = {
  hostname: HOST,
  path: PATH,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log(`Status Code: ${res.statusCode}`);
    try {
      const response = JSON.parse(body);
      console.log("Response:", response);
      if (res.statusCode === 200 && response.success) {
        console.log("\n✅ Base de datos subida y sincronizada en la nube con éxito!");
      } else {
        console.error("\n❌ Error en la subida:", response.error || response);
      }
    } catch (e) {
      console.error("\n❌ Response parse error:", e.message, body);
    }
  });
});

req.on('error', (err) => {
  console.error("\n❌ Network error:", err.message);
});

req.write(payload);
req.end();
