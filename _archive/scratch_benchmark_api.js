const https = require('https');

const start = Date.now();
https.get('https://app-taxes-production-ec67.up.railway.app/api/orders/archived', res => {
  let chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    const elapsed = Date.now() - start;
    const body = Buffer.concat(chunks).toString('utf8');
    console.log(`[Railway API] /api/orders/archived status ${res.statusCode} | Time: ${elapsed}ms | Payload size: ${body.length} bytes`);
    try {
      const orders = JSON.parse(body);
      console.log(`Total archived orders count: ${orders.length}`);
    } catch (e) {
      console.error("JSON parse error:", e.message);
    }
  });
}).on('error', err => console.error("API error:", err.message));
