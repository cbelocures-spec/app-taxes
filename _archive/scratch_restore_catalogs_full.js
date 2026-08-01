const fs = require('fs');
const { Client } = require('ssh2');

// Official catalog mappings from Taxes
const OFFICIAL_EMPLEADOS = [
  { value: "426", label: "Belocures, Cesar Hernán" },
  { value: "552", label: "Canaviri Fernandez, Jesús" },
  { value: "365", label: "Rocha, Walter" },
  { value: "512", label: "PEREZ FACUNDO" },
  { value: "238", label: "Ojeda, Francisco" },
  { value: "259", label: "Dominic, Dylan" },
  { value: "348", label: "Vera, Daniel" },
  { value: "579", label: "Morel, Luis Maximiliano" },
  { value: "389", label: "Lizarraga, Victor" },
  { value: "369", label: "Lizarraga, Victor (Herrería)" },
  { value: "601", label: "GODOY DAVID" },
  { value: "602", label: "Toledo" },
  { value: "283", label: "Carmona, Juan" },
  { value: "253", label: "González, Javier" },
  { value: "508", label: "Montiel" },
  { value: "223", label: "Ríos" },
  { value: "591", label: "Gerry Cristian Marcelo" },
  { value: "CALOMINO DARIO", label: "CALOMINO DARIO" },
  { value: "Cuba Orosco", label: "Cuba Orosco" },
  { value: "Gustavo Javier Benitez", label: "Gustavo Javier Benitez" },
  { value: "LOPEZ GUSTAVO", label: "LOPEZ GUSTAVO" },
  { value: "Monzon", label: "Monzon" },
  { value: "MUSDALINO FRANCO", label: "MUSDALINO FRANCO" },
  { value: "OJEDA FERNANDEZ JOSE ENRIQUE", label: "OJEDA FERNANDEZ JOSE ENRIQUE" },
  { value: "PANETTA ALBARRACIN FEDERICO", label: "PANETTA ALBARRACIN FEDERICO" },
  { value: "Perino Martin Adrian", label: "Perino Martin Adrian" },
  { value: "RODRIGUEZ CARLOS FERNANDO", label: "RODRIGUEZ CARLOS FERNANDO" },
  { value: "RODRIGUEZ MARCELO", label: "RODRIGUEZ MARCELO" },
  { value: "RODRIGUEZ NICOLAS", label: "RODRIGUEZ NICOLAS" },
  { value: "Sosa", label: "Sosa" },
  { value: "Federico", label: "Federico" },
  { value: "Luciano", label: "Luciano" },
  { value: "Digno", label: "Digno" }
];

const OFFICIAL_CENTROS_COSTO = [
  { value: "4", label: "CHOFERES" },
  { value: "8", label: "EDILICIO" },
  { value: "11", label: "HERRERIA" },
  { value: "13", label: "LAVADERO" },
  { value: "15", label: "MECANICA" },
  { value: "16", label: "HERRERIA REPARACIONES" },
  { value: "17", label: "PLAYA" },
  { value: "20", label: "RECOLECCION" },
  { value: "26", label: "MDQ" }
];

const dbFile = './db.json';
if (fs.existsSync(dbFile)) {
  const dbData = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  if (!dbData.catalogs) dbData.catalogs = {};
  
  // Merge missing catalog entries
  const currentEmp = dbData.catalogs.empleados || [];
  OFFICIAL_EMPLEADOS.forEach(emp => {
    if (!currentEmp.some(e => String(e.value) === String(emp.value))) {
      currentEmp.push(emp);
    }
  });
  dbData.catalogs.empleados = currentEmp;

  const currentCC = dbData.catalogs.centrosCosto || [];
  OFFICIAL_CENTROS_COSTO.forEach(cc => {
    if (!currentCC.some(c => String(c.value) === String(cc.value))) {
      currentCC.push(cc);
    }
  });
  dbData.catalogs.centrosCosto = currentCC;

  fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));
  console.log(`✅ Restored complete catalogs in local db.json (${currentEmp.length} empleados, ${currentCC.length} centros de costo)!`);
}

// Upload to 192.168.50.4 via SSH
const conn = new Client();
conn.on('ready', () => {
  console.log("✅ SSH Connected to 192.168.50.4!");
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.fastPut('./db.json', '/home/cbelocures/data/db.json', (err1) => {
      console.log("✅ Uploaded db.json with restored catalogs to 192.168.50.4!");
      conn.exec("echo CesarHernan3550 | sudo -S systemctl restart app-taxes.service", (err2, stream) => {
        let out = '';
        stream.on('data', d => out += d);
        stream.on('close', () => {
          console.log("=== APP-TAXES RESTARTED ON 192.168.50.4 ===");
          console.log(out);
          conn.end();
        });
      });
    });
  });
}).on('error', (err) => {
  console.error("SSH error:", err.message);
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550',
  readyTimeout: 30000
});
