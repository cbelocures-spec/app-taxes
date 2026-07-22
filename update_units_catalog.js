const fs = require('fs');
const path = require('path');

// Authoritative fleet catalog extracted from official unit list image ("la unidad")
const rawFleet = [
  { interno: "1", modelo: "FORD F4000", patente: "S08084", equipo: "CAMIONETA" },
  { interno: "2", modelo: "VOLKSWAGEN SANTANA 2.0", patente: "AA412SM", equipo: "CAMIONETA" },
  { interno: "4", modelo: "VOLKSWAGEN AMAROK", patente: "IVT558", equipo: "CAMIONETA" },
  { interno: "5", modelo: "VOLKSWAGEN AMAROK", patente: "AB038SP", equipo: "CAMIONETA" },
  { interno: "7", modelo: "VOLKSWAGEN AMAROK", patente: "AB417SE", equipo: "CAMIONETA" },
  { interno: "8", modelo: "FIAT CRONOS", patente: "AE616WH", equipo: "SEDAN" },
  { interno: "9", modelo: "FIAT CRONOS", patente: "AE616WI", equipo: "SEDAN" },
  { interno: "9B", modelo: "HANGCHA S-30 CPCD25T8", patente: "0130", equipo: "AUTOELEVADOR" },
  { interno: "10", modelo: "HANGCHA S-30 CPCD35N", patente: "0007", equipo: "AUTOELEVADOR" },
  { interno: "17", modelo: "MERCEDES BENZ 1718", patente: "BTP439", equipo: "VOLQUETE" },
  { interno: "25", modelo: "MERCEDES BENZ 1215", patente: "VDL751", equipo: "CAMION" },
  { interno: "26", modelo: "IVECO DAILY 3510", patente: "ISL302", equipo: "CAMIONETA" },
  { interno: "27", modelo: "IVECO DAILY 3510", patente: "ISL303", equipo: "CAMIONETA" },
  { interno: "28", modelo: "MERCEDES BENZ 1215", patente: "VDL528", equipo: "CAMION" },
  { interno: "38", modelo: "MERCEDES BENZ 1215", patente: "OOM151", equipo: "CAMION" },
  { interno: "43", modelo: "MERCEDES BENZ 1215", patente: "OOM434", equipo: "CAMION" },
  { interno: "44", modelo: "MERCEDES BENZ 1215", patente: "PFN081", equipo: "CAMION" },
  { interno: "45", modelo: "MERCEDES BENZ 1215", patente: "PGC084", equipo: "CAMION" },
  { interno: "46", modelo: "MERCEDES BENZ 1620", patente: "FNC849", equipo: "CAMION" },
  { interno: "47", modelo: "MERCEDES BENZ 1215", patente: "PUM470", equipo: "CAMION" },
  { interno: "50", modelo: "MERCEDES BENZ 1624 L.EC.", patente: "GCH627", equipo: "CAMION" },
  { interno: "51", modelo: "MERCEDES BENZ ATEGO", patente: "GAP155", equipo: "CAMION" },
  { interno: "52", modelo: "MERCEDES BENZ ATEGO", patente: "HFF660", equipo: "CAMION" },
  { interno: "53", modelo: "MERCEDES BENZ ATEGO", patente: "HFF661", equipo: "CAMION" },
  { interno: "54", modelo: "MERCEDES BENZ ATEGO", patente: "IFB029", equipo: "CAMION" },
  { interno: "56", modelo: "MERCEDES BENZ 1624 L.EC.", patente: "IHB828", equipo: "CAMION" },
  { interno: "57", modelo: "MERCEDES BENZ 1215", patente: "IYP604", equipo: "CAMION" },
  { interno: "59", modelo: "MERCEDES BENZ 1624 L.EC.", patente: "JAV230", equipo: "CAMION" },
  { interno: "60", modelo: "MERCEDES BENZ 1624 L.EC.", patente: "JAV237", equipo: "CAMION" },
  { interno: "61", modelo: "MERCEDES BENZ ATEGO", patente: "IUG098", equipo: "CAMION" },
  { interno: "62", modelo: "MERCEDES BENZ ATEGO 1729", patente: "LDR689", equipo: "CAMION" },
  { interno: "64", modelo: "MERCEDES BENZ 1620", patente: "LIZ424", equipo: "CAMION" },
  { interno: "65", modelo: "MERCEDES BENZ 1620", patente: "LNC661", equipo: "CAMION" },
  { interno: "66", modelo: "MERCEDES BENZ ATEGO 1725", patente: "MNB984", equipo: "CAMION" },
  { interno: "67", modelo: "MERCEDES BENZ ATEGO 1725", patente: "MNB985", equipo: "CAMION" },
  { interno: "68", modelo: "MERCEDES BENZ ATEGO 1725", patente: "MNB986", equipo: "CAMION" },
  { interno: "69", modelo: "MERCEDES BENZ ATEGO 1725", patente: "MNB987", equipo: "CAMION" },
  { interno: "70", modelo: "MERCEDES BENZ ATEGO 1725", patente: "MNB988", equipo: "CAMION" },
  { interno: "75", modelo: "MERCEDES BENZ 1620", patente: "PFA178", equipo: "CAMION" },
  { interno: "77", modelo: "MERCEDES BENZ 1620 L.EC.", patente: "PFA174", equipo: "CAMION" },
  { interno: "78", modelo: "MERCEDES BENZ 1620", patente: "PFA177", equipo: "CAMION" },
  { interno: "79", modelo: "MERCEDES BENZ 1620", patente: "PFA176", equipo: "CAMION" },
  { interno: "80", modelo: "MERCEDES BENZ 1620", patente: "PFA175", equipo: "CAMION" },
  { interno: "81", modelo: "MERCEDES BENZ 1215", patente: "OOM508", equipo: "CAMION" },
  { interno: "82", modelo: "MERCEDES BENZ 1215", patente: "A001AA", equipo: "CAMION" },
  { interno: "83", modelo: "MERCEDES BENZ 1215", patente: "AB628AA", equipo: "CAMION" },
  { interno: "84", modelo: "MERCEDES BENZ 1215", patente: "AC831AN", equipo: "CAMION" },
  { interno: "87", modelo: "MERCEDES BENZ ATEGO 1725", patente: "HSG736", equipo: "CAMION" },
  { interno: "88", modelo: "MERCEDES BENZ ATEGO 1725", patente: "HSG737", equipo: "CAMION" },
  { interno: "89", modelo: "MERCEDES BENZ ATEGO 1709", patente: "HSC787", equipo: "CAMION" },
  { interno: "90", modelo: "MERCEDES BENZ ATEGO 1709", patente: "HSC788", equipo: "CAMION" },
  { interno: "91", modelo: "MERCEDES BENZ ATEGO 1709", patente: "HSC789", equipo: "CAMION" },
  { interno: "92", modelo: "MERCEDES BENZ ATEGO 1709", patente: "HSC771", equipo: "CAMION" },
  { interno: "93", modelo: "MERCEDES BENZ 1215", patente: "GDA021", equipo: "CAMION" },
  { interno: "94", modelo: "MERCEDES BENZ ATEGO 1726", patente: "IYF625", equipo: "CAMION" },
  { interno: "95", modelo: "MERCEDES BENZ ATEGO 1725", patente: "IYF623", equipo: "CAMION" },
  { interno: "96", modelo: "MERCEDES BENZ ATEGO 1725", patente: "IYF622", equipo: "CAMION" },
  { interno: "97", modelo: "MERCEDES BENZ ATEGO 1709", patente: "IYF647", equipo: "CAMION" },
  { interno: "98", modelo: "MERCEDES BENZ ATEGO 1709", patente: "IYF648", equipo: "CAMION" },
  { interno: "99", modelo: "MERCEDES BENZ ATEGO 1725", patente: "IYF624", equipo: "CAMION" },
  { interno: "100", modelo: "MERCEDES BENZ ATEGO 1725", patente: "IYF621", equipo: "CAMION" },
  { interno: "101", modelo: "MERCEDES BENZ ATEGO 1725", patente: "IYF646", equipo: "CAMION" },
  { interno: "104", modelo: "TOYOTA HILUX", patente: "AA484MA", equipo: "CAMIONETA" },
  { interno: "105", modelo: "VOLKSWAGEN BUS 15190", patente: "HCL568", equipo: "OMNIBUS" },
  { interno: "109", modelo: "IVECO 170 E22", patente: "AB083PV", equipo: "CAMION" },
  { interno: "110", modelo: "IVECO 170 E22", patente: "AB083PW", equipo: "CAMION" },
  { interno: "111", modelo: "VOLKSWAGEN CONSTELLATION 17.280", patente: "AB083PX", equipo: "CAMION" },
  { interno: "127", modelo: "MERCEDES BENZ ATEGO 1725", patente: "AA454PE", equipo: "CAMION" },
  { interno: "128", modelo: "MERCEDES BENZ ATEGO 1725", patente: "AA454PD", equipo: "CAMION" },
  { interno: "130", modelo: "VOLKSWAGEN BUS 15190", patente: "HCL568", equipo: "OMNIBUS" },
  { interno: "131", modelo: "IVECO 170 E22", patente: "AB083PV", equipo: "CAMION" },
  { interno: "133", modelo: "IVECO 170 E22", patente: "AB083PZ", equipo: "CAMION" },
  { interno: "134", modelo: "IVECO 170 E22", patente: "FJB320", equipo: "CAMION" },
  { interno: "135", modelo: "IVECO 170 E22", patente: "FJB321", equipo: "CAMION" },
  { interno: "136", modelo: "VOLKSWAGEN TECTOR", patente: "AA454PM", equipo: "CAMION" },
  { interno: "137", modelo: "IVECO 170 E22", patente: "FJB327", equipo: "CAMION" },
  { interno: "138", modelo: "IVECO 170 E22", patente: "AC328VZ", equipo: "CAMION" },
  { interno: "139", modelo: "IVECO 170 E22", patente: "LLQ177", equipo: "CAMION" },
  { interno: "140", modelo: "IVECO 170 E22", patente: "LLQ178", equipo: "CAMION" },
  { interno: "141", modelo: "IVECO TECTOR 24-250", patente: "AA883AY", equipo: "CAMION" },
  { interno: "142", modelo: "VOLKSWAGEN TECTOR L280 4X2", patente: "AA454PN", equipo: "CAMION" },
  { interno: "143", modelo: "IVECO 170 E22", patente: "AA903AM", equipo: "CAMION" },
  { interno: "144", modelo: "IVECO 170 E22", patente: "AA903AM", equipo: "CAMION" },
  { interno: "145", modelo: "VOLKSWAGEN TECTOR", patente: "AB083PX", equipo: "CAMION" },
  { interno: "146", modelo: "VOLKSWAGEN 17-220", patente: "LDR680", equipo: "CAMION" },
  { interno: "147", modelo: "IVECO 170 E22", patente: "AA903AO", equipo: "CAMION" },
  { interno: "148", modelo: "VOLKSWAGEN 31.390 6X4 LR SC", patente: "AB083PY", equipo: "CAMION" },
  { interno: "149", modelo: "IVECO 170 E22", patente: "PGC084", equipo: "CAMION" },
  { interno: "150", modelo: "IVECO 170 E22 L17280 SR", patente: "PUM470", equipo: "CAMION" },
  { interno: "151", modelo: "VOLKSWAGEN 31.390 6X4 LR SC", patente: "AB083PZ", equipo: "CAMION" },
  { interno: "152", modelo: "MERCEDES BENZ BMT 1618", patente: "AB198IN", equipo: "CAMION" },
  { interno: "153", modelo: "IVECO 170 E22", patente: "AA454PM", equipo: "CAMION" },
  { interno: "154", modelo: "IVECO 170 E22", patente: "AB083PZ", equipo: "CAMION" },
  { interno: "155", modelo: "MERCEDES BENZ ATEGO 1725", patente: "AA454PB", equipo: "CAMION" },
  { interno: "156", modelo: "MERCEDES BENZ ATEGO 1725", patente: "AA454PC", equipo: "CAMION" },
  { interno: "157", modelo: "MERCEDES BENZ ATEGO 1725", patente: "AA454PD", equipo: "CAMION" },
  { interno: "158", modelo: "MERCEDES BENZ ATEGO 1725", patente: "AA454PE", equipo: "CAMION" },
  { interno: "159", modelo: "MERCEDES BENZ ATEGO 1725", patente: "AA454PF", equipo: "CAMION" },
  { interno: "160", modelo: "IVECO 170 E22", patente: "AA903AH", equipo: "CAMION" },
  { interno: "161", modelo: "IVECO 170 E22", patente: "AA903AI", equipo: "CAMION" },
  { interno: "162", modelo: "VOLKSWAGEN TECTOR", patente: "AA903AJ", equipo: "CAMION" },
  { interno: "163", modelo: "VOLKSWAGEN TECTOR", patente: "AA903AK", equipo: "CAMION" },
  { interno: "164", modelo: "VOLKSWAGEN TECTOR 17280", patente: "AB213JV", equipo: "CAMION" },
  { interno: "165", modelo: "VOLKSWAGEN TECTOR", patente: "AB213JW", equipo: "CAMION" },
  { interno: "353", modelo: "AUTOELEVADOR", patente: "AA220AA", equipo: "AUTOELEVADOR" },
  { interno: "354", modelo: "AUTOELEVADOR", patente: "AA402MA", equipo: "AUTOELEVADOR" },
  { interno: "1000", modelo: "TANQUE CISTERNA", patente: "XPT644", equipo: "TANQUE CISTERNA" },
  { interno: "2000", modelo: "REMOLQUE 1 EJE", patente: "AVP434", equipo: "REMOLQUE" },
  { interno: "2001", modelo: "CHASSIS", patente: "AB290KB", equipo: "CHASSIS" },
  { interno: "3000", modelo: "PALA LIUGONG", patente: "ACC625", equipo: "MAQUINARIA" },
  { interno: "3001", modelo: "PALA LIUGONG", patente: "AF628YI", equipo: "MAQUINARIA" },
  { interno: "3002", modelo: "LIUGONG CLG", patente: "WCP37", equipo: "MAQUINARIA" },
  { interno: "5002", modelo: "VOLKSWAGEN GOL 1.4", patente: "PMG367", equipo: "AUTO" },
  { interno: "5003", modelo: "TOYOTA HILUX", patente: "DBC824", equipo: "CAMIONETA" },
  { interno: "5004", modelo: "IVECO DAILY 5010", patente: "AVP298", equipo: "CAMIONETA" },
  { interno: "5005", modelo: "VOLKSWAGEN GOL", patente: "AC831AN", equipo: "AUTO" },
  { interno: "5007", modelo: "TANQUE CISTERNA", patente: "AA821MB", equipo: "TANQUE CISTERNA" },
  { interno: "5008", modelo: "FIAT STRADA", patente: "AA484MA", equipo: "CAMIONETA" },
  { interno: "5009", modelo: "CHEVROLET MONTANA", patente: "AC328VX", equipo: "CAMIONETA" },
  { interno: "5010", modelo: "CHEVROLET TRACKER", patente: "AD360VM", equipo: "CAMIONETA" },
  { interno: "5011", modelo: "RENAULT MASTER DCI 120", patente: "AB213JX", equipo: "CAMIONETA" },
  { interno: "5012", modelo: "VOLKSWAGEN AMAROK", patente: "AC831AM", equipo: "CAMIONETA" },
  { interno: "5013", modelo: "CHEVROLET MONTANA", patente: "AD803AU", equipo: "CAMIONETA" },
  { interno: "5014", modelo: "VOLKSWAGEN AMAROK", patente: "AF844YI", equipo: "CAMIONETA" }
];

// Build catalog format
const formattedRodados = rawFleet.map(unit => {
  const label = `${unit.modelo} ${unit.patente ? '(' + unit.patente + ') ' : ''}Interno ${unit.interno}`;
  return {
    value: unit.interno,
    label: label,
    interno: unit.interno,
    modelo: unit.modelo,
    patente: unit.patente,
    equipo: unit.equipo
  };
});

// Update db.json & db_live.json
['db.json', 'db_live.json', 'db_live_recovered.json'].forEach(file => {
  const filePath = path.join(__dirname, file);
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!data.catalogs) data.catalogs = {};
      data.catalogs.rodados = formattedRodados;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      console.log(`Successfully updated ${file} with ${formattedRodados.length} authoritative units.`);
    } catch(e) {
      console.error(`Error updating ${file}:`, e.message);
    }
  }
});
