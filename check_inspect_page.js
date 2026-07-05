const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, 'inspect_page.html');
if (!fs.existsSync(htmlPath)) {
  console.log('inspect_page.html does not exist.');
  process.exit(0);
}

const html = fs.readFileSync(htmlPath, 'utf8');

// Find all inputs with hours-like IDs or names
const matches = [];
const regex = /<input[^>]*?(id|name|class|type)="[^"]*?(horas|desc|empl|tarea|select)[^"]*?"[^>]*?>/gi;
let m;
while ((m = regex.exec(html)) !== null) {
  matches.push(m[0]);
}

console.log(`Found ${matches.length} matching input tags:`);
console.log(matches.slice(0, 30).join('\n'));

// Let's also count how many times id="horas_0" or similar appears
const horas0 = html.includes('id="horas_0"') || html.includes("id='horas_0'");
const horasEstimadas = html.includes('name="horas_estimadas"') || html.includes("name='horas_estimadas'");
console.log(`Contains id="horas_0": ${horas0}`);
console.log(`Contains name="horas_estimadas": ${horasEstimadas}`);

// Let's count total card-like elements or headers
const taskHeaders = html.match(/Tarea #\d+/g);
console.log(`Task header matches (e.g. Tarea #1):`, taskHeaders);
