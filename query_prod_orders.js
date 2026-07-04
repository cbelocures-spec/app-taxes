const https = require('https');

const host = 'app-taxes-production.up.railway.app';
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
    console.log(`Total Orders: ${orders.length}`);
    const pending = orders.filter(o => o.syncStatus === 'pending' || o.syncStatus === 'syncing');
    console.log(`Pending/Syncing Orders: ${pending.length}`);
    pending.forEach(o => {
      console.log(`  - ID: ${o.id} | OT: ${o.taxesOrderNumber} | Status: ${o.syncStatus}`);
    });
  } catch (e) {
    console.error('Parse error:', e.message);
  }
});
