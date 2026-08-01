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
        'x-user-username': 'paniol@contenedoreshugo.com.ar',
        'X-User-Username': 'paniol@contenedoreshugo.com.ar'
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

async function fixCredentialsAndResetErrors() {
  console.log("Fetching DB state from Railway...");
  const orders = await get('/api/orders/all');
  const catalogs = await get('/api/catalogs') || {};
  const settings = await get('/api/settings') || {};

  if (!Array.isArray(orders)) {
    console.error("Could not fetch orders from Railway");
    return;
  }

  console.log(`Fetched ${orders.length} orders.`);

  // 1. Fix global settings to use valid Pañol credentials
  console.log(`Updating settings: previous username = "${settings.username}"`);
  settings.username = "paniol@contenedoreshugo.com.ar";
  settings.password = "Paniol2015";
  console.log(`New settings: username = "${settings.username}"`);

  // 2. Reset errored orders to 'pending'
  let resetCount = 0;
  orders.forEach(order => {
    if (order.syncStatus === 'error') {
      resetCount++;
      order.syncStatus = 'pending';
      order.syncError = null;
    }
  });

  console.log(`Reset ${resetCount} errored orders to 'pending'.`);

  const dbData = {
    workOrders: orders,
    catalogs: catalogs,
    settings: settings
  };

  // Save to local db.json
  fs.writeFileSync('db.json', JSON.stringify(dbData, null, 2));

  console.log("Uploading fixed DB to Railway...");
  const uploadRes = await post('/api/admin/upload-db', {
    secret: secret,
    dbData: dbData
  });
  console.log("Railway Upload result:", uploadRes);

  // Upload db.json to local SSH server 192.168.50.4
  console.log("Uploading fixed db.json to local SSH server 192.168.50.4...");
  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) {
        console.error("SFTP error:", err.message);
        return conn.end();
      }
      sftp.fastPut('db.json', '/home/cbelocures/gestion/db.json', (putErr) => {
        if (putErr) console.error("SFTP upload error:", putErr.message);
        else console.log("✅ Successfully uploaded db.json to 192.168.50.4");
        conn.end();
      });
    });
  }).on('error', (err) => {
    console.error("SSH Connection error:", err.message);
  }).connect({
    host: '192.168.50.4',
    port: 22,
    username: 'cbelocures',
    password: 'CesarHernan3550',
    readyTimeout: 10000
  });
}

fixCredentialsAndResetErrors();
