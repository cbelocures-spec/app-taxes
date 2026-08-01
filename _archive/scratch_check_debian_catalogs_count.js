const http = require('http');

http.get('http://192.168.50.4/api/catalogs', res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    try {
      const cat = JSON.parse(body);
      console.log("=== DEBIAN CATALOGS API VERIFICATION ===");
      console.log("Rodados count:", cat.rodados ? cat.rodados.length : 0);
      console.log("Responsables count:", cat.responsables ? cat.responsables.length : 0);
      console.log("Empleados count:", cat.empleados ? cat.empleados.length : 0);
      if (cat.rodados && cat.rodados.length > 5) {
        console.log("\nSample Rodados:", cat.rodados.slice(0, 10).map(r => r.label));
      }
    } catch(e) { console.error("Parse error:", e.message); }
  });
}).on('error', e => console.error(e.message));
