const https = require('https');

const host = 'app-taxes-production-ec67.up.railway.app';

function testUser(username) {
  return new Promise((resolve) => {
    const headers = username ? { 'x-user-username': username } : {};
    https.get({
      hostname: host,
      path: '/api/orders',
      headers: headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const orders = JSON.parse(data);
          resolve({ username: username || '(None)', count: orders.length });
        } catch (e) {
          resolve({ username: username || '(None)', error: e.message, status: res.statusCode });
        }
      });
    }).on('error', err => resolve({ username: username || '(None)', error: err.message }));
  });
}

async function testUsers() {
  const users = [
    null,
    'paniol@contenedoreshugo.com.ar',
    'jcarmona@contenedoreshugo.com.ar',
    'ftoledo@contenedoreshugo.com.ar',
    'sergios@contenedoreshugo.com.ar'
  ];

  for (const u of users) {
    const res = await testUser(u);
    console.log(`User: ${res.username.padEnd(35)} -> Orders returned: ${res.count !== undefined ? res.count : res.error}`);
  }
}

testUsers();
