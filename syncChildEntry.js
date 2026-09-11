// Entry point for the "sync child" process, forked once by syncChildManager.js and kept
// alive. Runs syncWorker.js's real Puppeteer/Taxes automation completely unchanged - same
// functions, same browser lock, same direct db.json access - just in its own OS process so a
// slow or hung Chrome never blocks the main server (server.js) from answering everyone else.
const syncWorker = require('./syncWorker');
const { generarPdfParteTaller } = require('./pdfGenerator');

// Extra callable functions beyond syncWorker's own exports (kept in one place so
// syncChildManager.callSync('generarPdfParteTaller', html) works the same way as any
// syncWorker function call).
const extraFns = { generarPdfParteTaller };

process.on('message', async (msg) => {
  const { id, fn, args } = msg || {};
  if (!id || !fn) return;
  try {
    const target = extraFns[fn] || syncWorker[fn];
    if (typeof target !== 'function') {
      throw new Error(`"${fn}" no es una función válida en el proceso de sincronización.`);
    }
    const result = await target(...(args || []));
    process.send({ id, ok: true, result });
  } catch (e) {
    process.send({ id, ok: false, error: (e && e.message) || String(e) });
  }
});

process.on('uncaughtException', (err) => {
  console.error('[SyncChild] Excepción no capturada:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[SyncChild] Promesa rechazada sin capturar:', err);
});

process.send({ ready: true });
console.log(`[SyncChild] Proceso de sincronización iniciado (pid ${process.pid}).`);
