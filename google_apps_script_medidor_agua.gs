// Pegar este código en Extensiones > Apps Script de una Hoja de Google NUEVA (o una hoja
// específica dentro de una existente) para el Medidor de Agua de Lavadero. Después:
// Implementar > Nueva implementación > tipo "Aplicación web", "Ejecutar como: Yo",
// "Quién tiene acceso: Cualquier usuario" > Implementar. Copiar la URL que termina en /exec
// y pasarla a la app en Ajustes > URL de Script del Medidor de Agua.

var NOMBRE_HOJA = 'Medidor de Agua';
var HEADERS = ['Fecha', 'Hora', 'Turno', 'Lectura (L)', 'Consumo (L)', 'Registrado por'];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var accion = body.accion;
    if (accion === 'agregarLectura') {
      var consumo = agregarLectura(body.fecha, body.hora, body.turno, body.lectura, body.registradoPor);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, consumo: consumo }))
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
  return ContentService.createTextOutput(JSON.stringify({ ok: true, msg: 'Medidor de Agua - script activo' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function obtenerHoja() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(NOMBRE_HOJA);
  if (!sheet) {
    sheet = ss.insertSheet(NOMBRE_HOJA);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// El consumo de cada lectura es la diferencia con la ÚLTIMA lectura cargada (la fila anterior,
// no importa el turno/fecha) - así cada carga solo necesita el número que marca el medidor en
// ese momento, sin tener que calcular nada a mano. Si es la primera lectura de la hoja, o si el
// medidor se reinició (marca un número menor al anterior), el consumo queda en blanco en vez de
// mostrar un número negativo sin sentido.
function agregarLectura(fecha, hora, turno, lectura, registradoPor) {
  var sheet = obtenerHoja();
  var lastRow = sheet.getLastRow();
  var lecturaNum = Number(lectura);

  var consumo = '';
  if (lastRow >= 2) {
    var lecturaAnterior = Number(sheet.getRange(lastRow, 4).getValue());
    if (!isNaN(lecturaAnterior) && lecturaNum >= lecturaAnterior) {
      consumo = lecturaNum - lecturaAnterior;
    }
  }

  sheet.appendRow([fecha || '', hora || '', turno || '', lecturaNum, consumo, registradoPor || '']);
  return consumo;
}
