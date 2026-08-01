const fs = require('fs');
const https = require('https');
const { Client } = require('ssh2');

const host = 'app-taxes-production-ec67.up.railway.app';
const secret = 'Paniol2015';

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

async function clearVerificationErrors() {
  const dbPath = 'db.json';
  if (!fs.existsSync(dbPath)) {
    console.error("db.json not found!");
    return;
  }

  const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const orders = dbData.workOrders || dbData.orders || [];

  let clearedCount = 0;
  orders.forEach(order => {
    if (order.verifiedStatus === 'error' || order.verifiedError) {
      clearedCount++;
      console.log(`Clearing verification error for OT ${order.taxesOrderNumber || order.id} (Int ${order.interno}) | Prev: ${order.verifiedError}`);
      order.verifiedStatus = null;
      order.verifiedError = null;
    }
  });

  console.log(`\nCleared verification errors on ${clearedCount} orders.`);

  // Save to local db.json
  fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2));

  // Upload to Railway
  console.log("Uploading cleared DB to Railway...");
  const uploadRes = await post('/api/admin/upload-db', {
    secret: secret,
    dbData: dbData
  });
  console.log("Railway upload result:", uploadRes);

  // Upload to local SSH server 192.168.50.4
  console.log("Uploading cleared DB to 192.168.50.4...");
  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) return conn.end();
      sftp.fastPut('db.json', '/home/cbelocures/gestion/db.json', (putErr) => {
        if (putErr) console.error("SFTP error:", putErr.message);
        else console.log("✅ Successfully uploaded db.json to 192.168.50.4");
        conn.end();
      });
    });
  }).connect({
    host: '192.168.50.4',
    port: 22,
    username: 'cbelocures',
    password: 'CesarHernan3550',
    readyTimeout: 10000
  });
}

clearVerificationErrors();
