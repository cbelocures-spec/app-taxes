const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, 'local_sync_run.log');
const content = fs.readFileSync(logPath, 'utf8');

// Find the line that has "Stage: After clicks"
const match = content.match(/\[Reconcile-Debug\] Stage: After clicks \| Page inputs: (\[[\s\S]*?\])\r?\n/);
if (!match) {
  console.log('Could not find Stage: After clicks input array in log.');
  process.exit(0);
}

const inputs = JSON.parse(match[1]);
console.log(`Total inputs on screen after clicks: ${inputs.length}`);

// Filter inputs that might be related to tasks
const taskInputs = inputs.filter(i => {
  const s = JSON.stringify(i).toLowerCase();
  return s.includes('horas') || s.includes('estim') || s.includes('tarea') || s.includes('desc') || s.includes('empl') || s.includes('operario');
});

console.log('--- Task/Employee/Hours related inputs after clicks ---');
console.log(JSON.stringify(taskInputs, null, 2));
