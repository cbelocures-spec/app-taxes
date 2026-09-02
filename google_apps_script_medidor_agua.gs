// Pegar este código en Extensiones > Apps Script de la Hoja de Google del Medidor de Agua.
// Esta misma Hoja/script ahora también recibe una copia en vivo del Parte Taller (pestaña
// aparte "Parte Taller"), así que si ya lo tenías pegado de antes, solo hace falta REEMPLAZAR
// todo el contenido por este archivo actualizado y volver a "Implementar > Nueva implementación"
// (una implementación nueva para que la URL /exec recoja el código actualizado).
// Implementar > Nueva implementación > tipo "Aplicación web", "Ejecutar como: Yo",
// "Quién tiene acceso: Cualquier usuario" > Implementar. Copiar la URL que termina en /exec
// y pasarla a la app en Ajustes > URL de Script del Medidor de Agua.

var NOMBRE_HOJA_AGUA = 'Medidor de Agua';
var HEADERS_AGUA = ['Fecha', 'Hora', 'Turno', 'Lectura (L)', 'Consumo (L)', 'Registrado por'];

var NOMBRE_HOJA_PARTE_TALLER = 'Parte Taller';
var HEADERS_PARTE_TALLER = ['Categoría', 'Interno', 'Tipo', 'Novedad', 'Sector', 'Día Parado', 'Días en Reparación', 'Destino'];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var accion = body.accion;
    if (accion === 'agregarLectura') {
      var consumo = agregarLectura(body.fecha, body.hora, body.turno, body.lectura, body.registradoPor);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, consumo: consumo }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (accion === 'actualizarParteTaller') {
      actualizarParteTaller(body.resumen || {}, body.filas || []);
      return ContentService.createTextOutput(JSON.stringify({ ok: true }))
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
  return ContentService.createTextOutput(JSON.stringify({ ok: true, msg: 'Medidor de Agua / Parte Taller - script activo' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function obtenerHoja(nombre, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(nombre);
  if (!sheet) {
    sheet = ss.insertSheet(nombre);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
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
  var sheet = obtenerHoja(NOMBRE_HOJA_AGUA, HEADERS_AGUA);
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

// Copia en vivo del Parte Taller: esta pestaña se REESCRIBE por completo en cada cambio (no
// acumula filas como Medidor de Agua) porque siempre representa el estado ACTUAL del taller,
// no un historial. La app nunca lee esta hoja de vuelta - es solo una vidriera de consulta -
// así que un problema puntual con la Hoja jamás puede afectar los datos reales de la app.
function actualizarParteTaller(resumen, filas) {
  var sheet = obtenerHoja(NOMBRE_HOJA_PARTE_TALLER, HEADERS_PARTE_TALLER);
  var ahora = Utilities.formatDate(new Date(), 'America/Argentina/Buenos_Aires', 'dd/MM/yyyy HH:mm:ss');

  sheet.clear();
  sheet.getRange(1, 1).setValue('Parte Taller - actualizado: ' + ahora).setFontWeight('bold');
  sheet.getRange(2, 1).setValue(
    'Responsable: ' + (resumen.responsable || '-') +
    '   |   Fecha: ' + (resumen.fecha || '-') +
    '   |   Hora: ' + (resumen.hora || '-')
  );
  sheet.getRange(4, 1, 1, HEADERS_PARTE_TALLER.length).setValues([HEADERS_PARTE_TALLER]).setFontWeight('bold');
  sheet.setFrozenRows(4);

  if (filas && filas.length > 0) {
    var rows = filas.map(function (f) {
      return [
        f.categoria || '', f.interno || '', f.tipo || '', f.novedad || '',
        f.sector || '', f.dia_parado || '', f.dias_en_reparacion || '', f.destino || ''
      ];
    });
    sheet.getRange(5, 1, rows.length, HEADERS_PARTE_TALLER.length).setValues(rows);
  }
}
