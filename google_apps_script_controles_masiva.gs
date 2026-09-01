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
      var resultado = actualizarControlesInsumos(body.fecha, body.responsable, body.registros);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, hojas: resultado }))
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

function estiloParaValor(valorCrudo) {
  var norm = String(valorCrudo || '').trim().toUpperCase();
  if (norm === 'OK') return { texto: 'OK', color: COLOR_OK, fontColor: '#ffffff' };
  if (norm === 'SUCIO') return { texto: 'Sucio', color: COLOR_SUCIO, fontColor: '#ffffff' };
  if (norm === 'HCO') return { texto: 'Hco', color: COLOR_HCO, fontColor: '#1f2933' };
  if (norm === 'PERDIDA' || norm === 'PÉRDIDA') return { texto: 'Perdida', color: COLOR_PERDIDA, fontColor: '#1f2933' };
  var numero = Number(String(valorCrudo).replace(',', '.'));
  if (!isNaN(numero) && String(valorCrudo).trim() !== '') {
    return { texto: numero + ' Lts', color: COLOR_LITROS, fontColor: '#1f2933' };
  }
  return { texto: String(valorCrudo || ''), color: null, fontColor: null };
}

// registros: [{ interno, modelo, patente, controles: [{ tipo, valor }] }]
function actualizarControlesInsumos(fecha, responsable, registros) {
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
      var estilo = estiloParaValor(controlEntry.valor);
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
