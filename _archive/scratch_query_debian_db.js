const { Client } = require('ssh2');

const DEBIAN_CONFIG = {
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
};

const conn = new Client();
conn.on('ready', () => {
  conn.exec('cat /home/cbelocures/data/db.json', (err, stream) => {
    let out = '';
    stream.on('close', () => {
      try {
        const db = JSON.parse(out);
        console.log("=== DEBIAN PERSISTENT DB VERIFICATION ===");
        let count = 0;
        (db.workOrders || []).forEach(o => {
          if (!o.archived && !o.deleted) {
            (o.tasks || []).forEach(t => {
              if (t.status === 'Pendiente' || !t.status) {
                count++;
                console.log(`[#${count}] OT Interno ${o.interno} (${o.rodado}):`);
                console.log(`     Empleado: ${t.empleado}`);
                console.log(`     TimerStart: ${t.timerStart} (Started: ${t.timerStarted})`);
                console.log(`     TimerHistory: ${JSON.stringify(t.timerHistory)}`);
                console.log(`     Descripcion: ${t.descripcion}\n`);
              }
            });
          }
        });
        console.log(`TOTAL ACTIVE WORKING TASKS ON DEBIAN PERSISTENT DB: ${count}`);
      } catch(e) { console.error("Parse error:", e.message); }
      conn.end();
    }).on('data', d => out += d);
  });
}).connect(DEBIAN_CONFIG);
