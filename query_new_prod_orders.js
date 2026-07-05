const https = require('https');

const host = 'app-taxes-production-ec67.up.railway.app';
const username = 'paniol@contenedoreshugo.com.ar';

function get(path, callback) {
  https.get({
    hostname: host,
    path: path,
    headers: { 'x-user-username': username }
  }, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => { callback(null, data); });
  }).on('error', (err) => { callback(err); });
}

get('/api/orders', (err, data) => {
  if (err) {
    console.error('Error:', err.message);
    return;
  }
  try {
    const orders = JSON.parse(data);
    console.log(`Total Orders on new Railway: ${orders.length}`);
    const target = orders.find(o => o.taxesOrderNumber === '25530' || o.id === '1782926000451');
    if (target) {
      console.log('Target OT found on Railway:', JSON.stringify(target, null, 2));
    } else {
      console.log('Target OT NOT found on Railway!');
    }
  } catch (e) {
    console.error('Parse error:', e.message);
    console.log('Response content:', data);
  }
});
