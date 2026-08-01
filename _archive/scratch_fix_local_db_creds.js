const fs = require('fs');
const { Client } = require('ssh2');

const dbPath = 'db.json';
if (!fs.existsSync(dbPath)) {
  console.error("db.json not found!");
  process.exit(1);
}

const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

// 1. Fix global settings credentials to paniol@
if (!dbData.settings) dbData.settings = {};
console.log("Updating settings credentials...");
console.log(`Previous username: "${dbData.settings.username}"`);
dbData.settings.username = "paniol@contenedoreshugo.com.ar";
dbData.settings.password = "Paniol2015";
console.log(`Updated username:  "${dbData.settings.username}"`);

// 2. Reset error orders to 'pending'
const orders = dbData.workOrders || dbData.orders || [];
let resetCount = 0;

orders.forEach(order => {
  if (order.syncStatus === 'error') {
    resetCount++;
    console.log(`Resetting error for OT ${order.taxesOrderNumber || order.id} (Int ${order.interno}) | Prev error: ${order.syncError}`);
    order.syncStatus = 'pending';
    order.syncError = null;
  }
});

console.log(`Reset ${resetCount} errored orders to 'pending'.`);

// Save updated db.json
fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2));

// Upload db.json to 192.168.50.4
console.log("\nUploading updated db.json to 192.168.50.4...");
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
  console.error("SSH error:", err.message);
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550',
  readyTimeout: 10000
});
