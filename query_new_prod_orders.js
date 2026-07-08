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
    console.log(`Total Orders on new Railway: ${orders.length}`);
    const ot1 = orders.find(o => o.taxesOrderNumber === '25530');
    const ot2 = orders.find(o => o.taxesOrderNumber === '25534');
    
    if (ot1) {
      console.log('OT 25530 state on Railway:', {
        syncStatus: ot1.syncStatus,
        syncError: ot1.syncError,
        syncDate: ot1.syncDate
      });
    }
    if (ot2) {
      console.log('OT 25534 state on Railway:', {
        syncStatus: ot2.syncStatus,
        syncError: ot2.syncError,
        syncDate: ot2.syncDate
      });
    }
  } catch (e) {
    console.error('Parse error:', e.message);
  }
});
