/**
 * SCRIPT: Corre el sync y guarda el log completo en un archivo de texto
 */
const fs = require('fs');
const path = require('path');
const worker = require('./syncWorker');

const logPath = path.join(__dirname, 'local_sync_run.log');
const logStream = fs.createWriteStream(logPath, { flags: 'w' });

// Redirigir console.log y console.error
const originalLog = console.log;
const originalError = console.error;

function logMessage(...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' ');
  logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
  originalLog.apply(console, args);
}

function logError(...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' ');
  logStream.write(`[${new Date().toISOString()}] ERROR: ${msg}\n`);
  originalError.apply(console, args);
}

console.log = logMessage;
console.error = logError;

console.log('=== INICIANDO SYNC LOCAL CON REGISTRO DE LOGS ===');

worker.syncWorkOrder('1782926000451')
  .then((res) => {
    console.log('=== SYNC LOCAL FINALIZADO ===');
    console.log('Resultado:', res);
    logStream.end();
    setTimeout(() => { process.exit(0); }, 35000);
  })
  .catch((err) => {
    console.error('=== ERROR EN SYNC LOCAL ===', err.message);
    logStream.end();
    setTimeout(() => { process.exit(1); }, 35000);
  });
