const https = require('https');

const url = 'https://app-taxes-production.up.railway.app/api/worker/status';

console.log(`Fetching worker status from: ${url}`);

https.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('Worker Status response:', data);
  });
}).on('error', (err) => {
  console.error('Request error:', err.message);
});
