const https = require('https');

const host = 'app-taxes-production.up.railway.app';
const orderId = '1782926000451';
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

console.log('Fetching order status...');
get('/api/orders', (err, ordersData) => {
  if (err) {
    console.error('Error fetching orders:', err.message);
    return;
  }
  try {
    const orders = JSON.parse(ordersData);
    const ot = orders.find(o => o.id === orderId);
    console.log('OT Status:');
    console.log(JSON.stringify({
      syncStatus: ot.syncStatus,
      syncError: ot.syncError,
      syncDate: ot.syncDate
    }, null, 2));
  } catch (e) {
    console.error('Parse error:', e.message);
  }

  console.log('\nFetching server debug logs...');
  get('/api/debug/logs', (err, logsData) => {
    if (err) {
      console.error('Error fetching logs:', err.message);
      return;
    }
    try {
      const logs = JSON.parse(logsData);
      console.log(`Last 25 console logs:`);
      logs.slice(-25).forEach((l) => {
        console.log(`  [${l.timestamp}] ${l.args.join(' ')}`);
      });
    } catch (e) {
      console.error('Parse error:', e.message);
    }
  });
});
