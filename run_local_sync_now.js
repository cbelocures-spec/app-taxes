/**
 * SCRIPT: Ejecuta la sincronización local de la OT 25530 de forma visible (headless: false)
 * para que el usuario pueda ver el comportamiento del robot en vivo.
 */
const worker = require('./syncWorker');

console.log('=== Iniciando Sincronización Local de OT 25530 ===');
console.log('Preparando navegador visible (headless: false)...');

worker.syncWorkOrder('1782926000451')
  .then((res) => {
    console.log('=== Sincronización Local Completada con Éxito ===');
    console.log('Resultado:', JSON.stringify(res, null, 2));
    // Esperar 35 segundos antes de cerrar para que el usuario pueda mirar el navegador
    setTimeout(() => { process.exit(0); }, 35000);
  })
  .catch((err) => {
    console.error('=== ERROR en la Sincronización Local ===');
    console.error(err);
    setTimeout(() => { process.exit(1); }, 35000);
  });
