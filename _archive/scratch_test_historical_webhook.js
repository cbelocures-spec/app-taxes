const https = require('https');

const url = 'https://script.google.com/macros/s/AKfycbxbCEe6CPyN02seTWd0VO6mYljxX5N27oT2I5QJS-ZtRn7_PTm-oxI54p5rN6RCU8anVA/exec';

function sendPost(targetUrl, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const u = new URL(targetUrl);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`Redirecting to: ${res.headers.location}`);
        return resolve(sendPost(res.headers.location, payload));
      }
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    req.on('error', err => resolve(err.message));
    req.write(data);
    req.end();
  });
}

async function runTest() {
  console.log("=== TEST PASO 1: CREAR FILA PROVISIONAL ===");
  const paso1 = await sendPost(url, {
    accion: "crear",
    fecha: "30/07/2026",
    interno: "999",
    ot: "Procesando...",
    centro_costo: "15",
    categoria: "COMPACTADOR",
    empleado: "Prueba Sistema",
    horas: "0.01",
    descripcion: "Prueba de Sincronizacion Historica",
    status: "Pendiente",
    hora_inicio: "19:20",
    estado_sincro: "Procesando..."
  });
  console.log("Paso 1 Response:", paso1);

  console.log("\n=== TEST PASO 2: CONFIRMAR OT OFICIAL ===");
  const paso2 = await sendPost(url, {
    accion: "confirmar_ot",
    interno: "999",
    ot_numero: "27999",
    status: "Finalizada",
    hora_fin: "19:21",
    estado_sincro: "OK Sincronizada"
  });
  console.log("Paso 2 Response:", paso2);
}

runTest();
