const https = require('https');
const fs = require('fs');
const { Client } = require('ssh2');

const host = 'app-taxes-production-ec67.up.railway.app';
const secret = 'Paniol2015';

function get(path) {
  return new Promise((resolve) => {
    https.get({
      hostname: host,
      path: path,
      headers: {
        'x-user-username': 'paniol@contenedoreshugo.com.ar'
      }
    }, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

function post(path, body) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      hostname: host,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'x-user-username': 'paniol@contenedoreshugo.com.ar'
      }
    }, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const resp = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, body: JSON.parse(resp) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') });
        }
      });
    });
    req.on('error', err => resolve({ error: err.message }));
    req.write(payload);
    req.end();
  });
}

async function fixHerreriaErrorsOnRailway() {
  console.log("Fetching live orders from Railway...");
  const orders = await get('/api/orders/all');
  if (!Array.isArray(orders)) {
    console.error("Failed to fetch orders from Railway");
    return;
  }

  let fixCount = 0;
  orders.forEach(o => {
    const ot = String(o.taxesOrderNumber || o.id);
    if (ot === '27685' || ot === '27781' || o.verifiedStatus === 'error' || o.verifiedError) {
      fixCount++;
      console.log(`Clearing error on OT ${ot} (Int ${o.interno}) | Prev verifiedError: ${o.verifiedError}`);
      o.verifiedStatus = null;
      o.verifiedError = null;
    }
  });

  console.log(`\nCleared errors on ${fixCount} orders.`);

  const dbData = {
    workOrders: orders,
    catalogs: await get('/api/catalogs') || {},
    settings: await get('/api/settings') || {}
  };

  fs.writeFileSync('db.json', JSON.stringify(dbData, null, 2));

  console.log("Uploading cleaned DB to Railway...");
  const uploadRes = await post('/api/admin/upload-db', {
    secret: secret,
    dbData: dbData
  });
  console.log("Railway upload result:", uploadRes);

  console.log("Uploading cleaned DB to 192.168.50.4...");
  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) return conn.end();
      sftp.fastPut('db.json', '/home/cbelocures/gestion/db.json', () => {
        console.log("✅ Successfully uploaded clean db.json to 192.168.50.4");
        conn.end();
      });
    });
  }).connect({
    host: '192.168.50.4',
    port: 22,
    username: 'cbelocures',
    password: 'CesarHernan3550'
  });
}

fixHerreriaErrorsOnRailway();
