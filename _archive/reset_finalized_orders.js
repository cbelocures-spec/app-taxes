const https = require('https');
const HOST = 'app-taxes-production-ec67.up.railway.app';
const USERNAME = 'paniol@contenedoreshugo.com.ar';

function apiCall(method, path, bodyData) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      path: path,
      method: method,
      headers: {
        'x-user-username': USERNAME,
      }
    };

    let payload = '';
    if (bodyData) {
      payload = JSON.stringify(bodyData);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    } else {
      options.headers['Content-Length'] = 0;
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { resolve(data); });
    });
    req.on('error', (err) => { reject(err); });
    if (bodyData) req.write(payload);
    req.end();
  });
}

async function run() {
  const ids = ['1782954704116', '1782954805574'];
  console.log('Resetting verifiedStatus to error for Interno 104 and 112 on Railway...');
  
  for (const id of ids) {
    console.log(`Resetting order ${id}...`);
    await apiCall('POST', `/api/orders/local-sync-result/${id}`, {
      verifiedStatus: 'error',
      verifiedError: 'Re-verificación requerida para sincronizar tareas finalizadas recientemente.',
      verifiedCount: 0
    });
    console.log(`  ✓ Reset complete for ${id}`);
  }
  
  console.log('All resets finished.');
}

run().catch(console.error);
