const https = require('https');

function testEndpoint(path) {
  return new Promise((resolve) => {
    const start = Date.now();
    https.get('https://app-taxes-production-ec67.up.railway.app' + path, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const elapsed = Date.now() - start;
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(body);
          resolve({ path, status: res.statusCode, elapsed, count: Array.isArray(parsed) ? parsed.length : 'not-array' });
        } catch (e) {
          resolve({ path, status: res.statusCode, elapsed, raw: body.substring(0, 100) });
        }
      });
    }).on('error', err => resolve({ path, error: err.message }));
  });
}

async function testAll() {
  console.log("Testing Railway endpoints...");
  console.log(await testEndpoint('/api/orders/all'));
  console.log(await testEndpoint('/api/orders/archived'));
}

testAll();
