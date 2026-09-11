// Runs in the main server process. Owns the single "sync child" process (syncChildEntry.js)
// that does all the Puppeteer/Taxes work, so a slow or hung sync never blocks the main
// Express event loop from answering every other connected supervisor's request.
//
// callSync(fnName, ...args) sends a job to the child and resolves/rejects with its result,
// exactly like calling that function in-process used to - callers don't need to know the work
// now happens in a different process.
const { fork } = require('child_process');
const path = require('path');

let child = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject }

// Más largo que cualquier timeout interno que ya tenga syncWorker.js (el más largo hoy es de
// 40 min) - esto es solo la red de seguridad para el caso de que el proceso hijo entero se
// cuelgue del todo y ni siquiera su propio timeout interno llegue a correr.
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

function rejectAllPending(reason) {
  for (const [, p] of pending) {
    p.reject(new Error(reason));
  }
  pending.clear();
}

function spawnChild() {
  const c = fork(path.join(__dirname, 'syncChildEntry.js'), [], { serialization: 'advanced' });

  c.on('message', (msg) => {
    if (!msg || msg.ready) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'Error desconocido en el proceso de sincronización.'));
  });

  c.on('exit', (code, signal) => {
    console.error(`[SyncChildManager] El proceso de sincronización terminó (code=${code}, signal=${signal}). Se reinicia solo en el próximo pedido.`);
    if (child === c) child = null;
    rejectAllPending('El proceso de sincronización se cerró inesperadamente (posible crash de Chrome). Reintentá la acción.');
  });

  c.on('error', (err) => {
    console.error('[SyncChildManager] Error en el proceso de sincronización:', err.message);
  });

  return c;
}

function getChild() {
  if (!child) child = spawnChild();
  return child;
}

function callSync(fnName, ...args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const c = getChild();

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Tiempo de espera agotado esperando a "${fnName}" en el proceso de sincronización.`));
    }, DEFAULT_TIMEOUT_MS);

    pending.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (err) => { clearTimeout(timer); reject(err); }
    });

    c.send({ id, fn: fnName, args });
  });
}

module.exports = { callSync };
