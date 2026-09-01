// Pegar este código en Extensiones > Apps Script de la Hoja de Google nueva para Controles
// de Carga Masiva. Después: Implementar > Nueva implementación > tipo "Aplicación web",
// "Ejecutar como: Yo", "Quién tiene acceso: Cualquier usuario" > Implementar.
// Copiar la URL que termina en /exec y pasársela a Claude para configurarla en la app.

var HOJA_POR_TIPO = {
  refrigerante: 'Ctrol Refrigerante',
  aceite_motor: 'Ctrol Aceite Motor',
  grasa_caja: 'Grasa Caja',
  grasa_diferencial: 'Grasa Diferencial',
  hco_direccion: 'Hco Direccion',
  hco_equipo: 'Hco Equipo',
  vigia: 'Vigia',
  luces: 'Luces',
  bateria: 'Bateria',
  alternador: 'Alternador'
};

var HEADER_ROW = 1;
var DATE_ROW = 2;
var FIRST_DATA_ROW = 3;
var INTERNO_COL = 1;

var COLOR_OK = '#57bb8a';
var COLOR_SUCIO = '#9c2b2b';
var COLOR_HCO = '#5bc8d6';
var COLOR_PERDIDA = '#e8a33d';
var COLOR_LITROS = '#d9d9d9';

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var accion = body.accion;
    if (accion === 'actualizarControlesInsumos') {
      var resultado = actualizarControlesInsumos(body.fecha, body.responsable, body.registros, body.todosInternos);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, hojas: resultado }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (accion === 'precargarTodasLasHojas') {
      var hojasPrecargadas = precargarTodasLasHojas(body.todosInternos);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, hojas: hojasPrecargadas }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Acción desconocida: ' + accion }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, msg: 'Controles Masiva - script activo' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function obtenerOCrearHoja(ss, nombreHoja) {
  var sheet = ss.getSheetByName(nombreHoja);
  if (!sheet) {
    sheet = ss.insertSheet(nombreHoja);
    sheet.getRange(HEADER_ROW, INTERNO_COL).setValue('Empleado').setFontWeight('bold');
    sheet.getRange(DATE_ROW, INTERNO_COL).setValue('Internos / Dias').setFontWeight('bold');
    sheet.setColumnWidth(INTERNO_COL, 90);
  }
  return sheet;
}

function proximaColumnaLibre(sheet) {
  var lastColHeader = sheet.getRange(HEADER_ROW, 1, 1, sheet.getMaxColumns()).getValues()[0];
  var lastColDate = sheet.getRange(DATE_ROW, 1, 1, sheet.getMaxColumns()).getValues()[0];
  var maxCol = INTERNO_COL;
  for (var c = 0; c < lastColHeader.length; c++) {
    if (lastColHeader[c] !== '' || lastColDate[c] !== '') maxCol = Math.max(maxCol, c + 1);
  }
  return maxCol + 1;
}

function encontrarOInsertarFilaInterno(sheet, interno) {
  var internoNum = parseInt(interno, 10);
  var internoKey = String(interno).trim();
  var lastRow = Math.max(sheet.getLastRow(), FIRST_DATA_ROW - 1);
  var row = FIRST_DATA_ROW;
  while (row <= lastRow) {
    var cellVal = sheet.getRange(row, INTERNO_COL).getValue();
    if (cellVal === '' || cellVal === null) break;
    var existingKey = String(cellVal).trim();
    if (existingKey === internoKey) return row;
    var existingNum = parseInt(existingKey, 10);
    if (!isNaN(internoNum) && !isNaN(existingNum) && existingNum > internoNum) {
      sheet.insertRowBefore(row);
      sheet.getRange(row, INTERNO_COL).setValue(internoKey).setFontWeight('bold');
      return row;
    }
    row++;
  }
  sheet.getRange(row, INTERNO_COL).setValue(internoKey).setFontWeight('bold');
  return row;
}

// bateria/alternador miden voltaje, no litros; vigia/luces son un control de
// funcionamiento (OK/Sucio/etc.), un numero ahi no tiene unidad propia.
var TIPOS_VOLTAJE = { bateria: true, alternador: true };
var TIPOS_SIN_UNIDAD = { vigia: true, luces: true };

function estiloParaValor(valorCrudo, tipo) {
  var norm = String(valorCrudo || '').trim().toUpperCase();
  if (norm === 'OK') return { texto: 'OK', color: COLOR_OK, fontColor: '#ffffff' };
  if (norm === 'SUCIO') return { texto: 'Sucio', color: COLOR_SUCIO, fontColor: '#ffffff' };
  if (norm === 'HCO') return { texto: 'Hco', color: COLOR_HCO, fontColor: '#1f2933' };
  if (norm === 'PERDIDA' || norm === 'PÉRDIDA') return { texto: 'Perdida', color: COLOR_PERDIDA, fontColor: '#1f2933' };
  var numero = Number(String(valorCrudo).replace(',', '.'));
  if (!isNaN(numero) && String(valorCrudo).trim() !== '') {
    if (TIPOS_SIN_UNIDAD[tipo]) return { texto: String(numero), color: COLOR_LITROS, fontColor: '#1f2933' };
    var unidad = TIPOS_VOLTAJE[tipo] ? 'Volt' : 'Lts';
    return { texto: numero + ' ' + unidad, color: COLOR_LITROS, fontColor: '#1f2933' };
  }
  return { texto: String(valorCrudo || ''), color: null, fontColor: null };
}

// Precarga todos los internos reales de la flota como filas (ordenadas), aunque no tengan
// dato en esta masiva puntual - asi la hoja siempre tiene el listado completo desde el
// principio, igual que la planilla vieja, en vez de ir apareciendo de a uno.
function asegurarTodasLasFilas(sheet, todosInternos) {
  if (!todosInternos || todosInternos.length === 0) return;
  var ordenados = todosInternos.slice().sort(function(a, b) {
    return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0);
  });
  for (var i = 0; i < ordenados.length; i++) {
    encontrarOInsertarFilaInterno(sheet, ordenados[i]);
  }
}

// Version rapida de asegurarTodasLasFilas para la precarga inicial: en vez de una llamada a
// Sheets por interno (~1000 llamadas totales, demasiado lento para el limite de ejecucion de
// Apps Script), lee la columna A una sola vez y escribe todos los faltantes juntos con un
// solo setValues(). Los que ya existen (de un intento anterior que no llego a terminar)
// quedan como estaban - son un prefijo ya ordenado, asi que agregar el resto ordenado al
// final mantiene todo bien ordenado igual.
function precargarFilasRapido(sheet, ordenados) {
  if (!ordenados || ordenados.length === 0) return;
  var lastRow = sheet.getLastRow();
  var existentes = {};
  if (lastRow >= FIRST_DATA_ROW) {
    var vals = sheet.getRange(FIRST_DATA_ROW, INTERNO_COL, lastRow - FIRST_DATA_ROW + 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      var v = String(vals[i][0]).trim();
      if (v) existentes[v] = true;
    }
  }
  var faltantes = ordenados.filter(function(i) { return !existentes[String(i).trim()]; });
  if (faltantes.length === 0) return;
  var startRow = Math.max(lastRow + 1, FIRST_DATA_ROW);
  var values = faltantes.map(function(i) { return [String(i).trim()]; });
  var range = sheet.getRange(startRow, INTERNO_COL, values.length, 1);
  range.setValues(values);
  range.setFontWeight('bold');
}

// Setup manual: crea (si hace falta) las 10 hojas de control y les precarga todos los
// internos de una, sin esperar a que una Carga Masiva las vaya tocando de a una.
function precargarTodasLasHojas(todosInternos) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ordenados = (todosInternos || []).slice().sort(function(a, b) {
    return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0);
  });
  var hojas = [];
  for (var tipo in HOJA_POR_TIPO) {
    var nombreHoja = HOJA_POR_TIPO[tipo];
    var sheet = obtenerOCrearHoja(ss, nombreHoja);
    precargarFilasRapido(sheet, ordenados);
    hojas.push(nombreHoja);
  }
  return hojas;
}

// registros: [{ interno, modelo, patente, controles: [{ tipo, valor }] }]
function actualizarControlesInsumos(fecha, responsable, registros, todosInternos) {
  if (!registros || registros.length === 0) return [];
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var tiposPresentes = {};
  for (var i = 0; i < registros.length; i++) {
    var controles = registros[i].controles || [];
    for (var j = 0; j < controles.length; j++) {
      tiposPresentes[controles[j].tipo] = true;
    }
  }

  var hojasActualizadas = [];
  for (var tipo in tiposPresentes) {
    var nombreHoja = HOJA_POR_TIPO[tipo];
    if (!nombreHoja) continue;
    var sheet = obtenerOCrearHoja(ss, nombreHoja);
    asegurarTodasLasFilas(sheet, todosInternos);
    var col = proximaColumnaLibre(sheet);

    sheet.getRange(HEADER_ROW, col).setValue(responsable || '').setFontWeight('bold');
    sheet.getRange(DATE_ROW, col).setValue(fecha || '').setFontWeight('bold');
    sheet.setColumnWidth(col, 90);

    for (var r = 0; r < registros.length; r++) {
      var reg = registros[r];
      var controlEntry = null;
      for (var k = 0; k < (reg.controles || []).length; k++) {
        if (reg.controles[k].tipo === tipo) { controlEntry = reg.controles[k]; break; }
      }
      if (!controlEntry) continue;

      var targetRow = encontrarOInsertarFilaInterno(sheet, reg.interno);
      var estilo = estiloParaValor(controlEntry.valor, tipo);
      var cell = sheet.getRange(targetRow, col);
      cell.setValue(estilo.texto);
      cell.setHorizontalAlignment('center');
      if (estilo.color) {
        cell.setBackground(estilo.color);
        cell.setFontColor(estilo.fontColor);
        cell.setFontWeight('bold');
      }
    }
    hojasActualizadas.push(nombreHoja);
  }
  return hojasActualizadas;
}
