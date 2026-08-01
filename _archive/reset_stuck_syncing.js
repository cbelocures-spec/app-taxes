#!/usr/bin/env node
/**
 * reset_stuck_syncing.js
 * 
 * Resetea INMEDIATAMENTE todas las órdenes atascadas en estado 'syncing'
 * Uso local:  node reset_stuck_syncing.js
 * Uso prod:   node reset_stuck_syncing.js https://tu-app.railway.app Paniol2015
 */

const http = require('http');
const https = require('https');

const BASE_URL = process.argv[2] || 'http://localhost:3000';
const ADMIN_SECRET = process.argv[3] || 'Paniol2015';

async function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const lib = isHttps ? https : http;
    const req = lib.request(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function main() {
  console.log(`\n🔍 Buscando órdenes atascadas en: ${BASE_URL}`);
  
  // 1. Get all orders
  const ordersRes = await fetchJson(`${BASE_URL}/api/orders`, { method: 'GET' });
  if (ordersRes.status !== 200) {
    console.error('❌ Error obteniendo órdenes:', ordersRes.body);
    process.exit(1);
  }

  const orders = ordersRes.body;
  const stuckOrders = orders.filter(o => o.syncStatus === 'syncing');
  
  if (stuckOrders.length === 0) {
    console.log('✅ No hay órdenes atascadas en "syncing". Todo está bien.');
    return;
  }

  console.log(`\n⚠️  Encontradas ${stuckOrders.length} órdenes atascadas en 'syncing':\n`);
  for (const o of stuckOrders) {
    const started = o.syncStartedAt ? new Date(o.syncStartedAt).toLocaleString('es-AR') : 'desconocido';
    const elapsed = o.syncStartedAt 
      ? `${Math.round((Date.now() - new Date(o.syncStartedAt).getTime()) / 60000)} min`
      : 'N/A';
    console.log(`  - OT #${o.interno} (ID: ${o.id}) | Iniciado: ${started} | Tiempo: ${elapsed}`);
  }

  console.log('\n🔄 Reseteando órdenes a "pending"...\n');

  for (const o of stuckOrders) {
    const payload = JSON.stringify({ orderId: o.id, status: 'pending', secret: ADMIN_SECRET });
    const res = await fetchJson(`${BASE_URL}/api/admin/reset-order-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_SECRET },
      body: payload
    });

    if (res.status === 200) {
      console.log(`  ✅ OT #${o.interno} → reseteada a 'pending'`);
    } else {
      console.log(`  ❌ OT #${o.interno} → error: ${JSON.stringify(res.body)}`);
    }
  }

  console.log('\n✅ Listo. Las órdenes se pondrán en cola para reintento automático.');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
