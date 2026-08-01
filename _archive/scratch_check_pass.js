const fs = require('fs');
const path = require('path');

const dbPath = 'c:\\Users\\admin\\.gemini\\antigravity\\scratch\\app_taxes\\db.json';
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

const pw = db.settings ? db.settings.password : null;
console.log("Global Password:", pw);
console.log("Is literal bullets?:", pw === "••••••••••••");
console.log("Length:", pw ? pw.length : 0);
