const https = require('https');

const url = 'https://app-taxes-production.up.railway.app/api/orders';
const headers = { 'x-user-username': 'paniol@contenedoreshugo.com.ar' };

console.log(`Fetching orders from: ${url}`);

const req = https.get(url, { headers }, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const orders = JSON.parse(data);
      const ot = orders.find(o => String(o.taxesOrderNumber) === '25530');
      if (ot) {
        console.log('Found OT 25530 on production server:');
        console.log(JSON.stringify(ot, null, 2));
      } else {
        console.log('OT 25530 NOT found in production orders list!');
        console.log(`All orders:`, orders.map(o => o.taxesOrderNumber).join(', '));
      }
    } catch (e) {
      console.error('Error parsing response:', e.message);
      console.log('Raw response:', data.slice(0, 500));
    }
  });
});

req.on('error', (err) => {
  console.error('Request error:', err.message);
});
