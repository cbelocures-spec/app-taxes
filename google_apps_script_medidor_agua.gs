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
      actualizarParteTaller(body.resumen || {}, body.resumenTipos || [], body.filas || []);
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

var NUM_COLS_PARTE_TALLER = HEADERS_PARTE_TALLER.length; // 8

// Colores por tipo de camión, iguales a las tarjetas del "Parte Diario de Taller" adentro de
// la app, para que la Hoja se lea igual de un vistazo.
var COLOR_TIPO = {
  'COMPACTADOR': '#3b82f6',
  'VOLQUETE': '#8b5cf6',
  'ROLL - OFF': '#06b6d4',
  'PLANCHA': '#f97316'
};

// Copia en vivo del Parte Taller: esta pestaña se REESCRIBE por completo en cada cambio (no
// acumula filas como Medidor de Agua) porque siempre representa el estado ACTUAL del taller,
// no un historial. La app nunca lee esta hoja de vuelta - es solo una vidriera de consulta -
// así que un problema puntual con la Hoja jamás puede afectar los datos reales de la app.
function actualizarParteTaller(resumen, resumenTipos, filas) {
  var sheet = obtenerHoja(NOMBRE_HOJA_PARTE_TALLER, HEADERS_PARTE_TALLER);
  sheet.clear();

  // --- Encabezado tipo "Parte Diario de Taller" ---
  sheet.getRange(1, 1, 1, NUM_COLS_PARTE_TALLER).merge()
    .setValue('PARTE DIARIO DE TALLER')
    .setBackground('#1e293b').setFontColor('#ffffff').setFontWeight('bold')
    .setFontSize(13).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.setRowHeight(1, 30);

  var mitad = Math.floor(NUM_COLS_PARTE_TALLER / 2);
  sheet.getRange(2, 1, 1, mitad).merge()
    .setValue('Responsable: ' + (resumen.responsable || '-'))
    .setBackground('#eff6ff').setFontColor('#1d4ed8').setFontWeight('bold');
  sheet.getRange(2, mitad + 1, 1, NUM_COLS_PARTE_TALLER - mitad).merge()
    .setValue('Actualizado: ' + (resumen.fecha || '-') + ' ' + (resumen.hora || '-'))
    .setBackground('#ecfdf5').setFontColor('#047857').setFontWeight('bold');

  // --- Tarjetas de resumen por tipo de camión ---
  var filaEncabezadoStats = 4;
  var headersStats = ['Tipo', 'Operativos', 'En Reparación', 'Fuera Servicio', 'En Preparación', 'Flota Total', 'Disponibilidad'];
  sheet.getRange(filaEncabezadoStats, 1, 1, headersStats.length).setValues([headersStats])
    .setFontWeight('bold').setBackground('#f1f5f9');

  (resumenTipos || []).forEach(function (t, idx) {
    var fila = filaEncabezadoStats + 1 + idx;
    var color = COLOR_TIPO[t.tipo] || '#334155';
    sheet.getRange(fila, 1).setValue(t.tipo || '').setBackground(color).setFontColor('#ffffff').setFontWeight('bold');
    sheet.getRange(fila, 2).setValue(t.operativos || 0).setFontColor('#16a34a').setFontWeight('bold').setHorizontalAlignment('center');
    sheet.getRange(fila, 3).setValue(t.reparacion || 0).setFontColor('#f97316').setFontWeight('bold').setHorizontalAlignment('center');
    sheet.getRange(fila, 4).setValue(t.fueraServicio || 0).setFontColor('#dc2626').setFontWeight('bold').setHorizontalAlignment('center');
    sheet.getRange(fila, 5).setValue(t.preparacion || 0).setFontColor('#d97706').setFontWeight('bold').setHorizontalAlignment('center');
    sheet.getRange(fila, 6).setValue(t.total || 0).setHorizontalAlignment('center');
    sheet.getRange(fila, 7).setValue((t.disponibilidad || 0) + '%').setFontWeight('bold').setHorizontalAlignment('center');
  });

  // --- Detalle de unidades (Tránsito / Reparación / Fuera de Servicio / Preparación) ---
  var filaDetalle = filaEncabezadoStats + 1 + (resumenTipos || []).length + 2;
  sheet.getRange(filaDetalle, 1, 1, NUM_COLS_PARTE_TALLER).setValues([HEADERS_PARTE_TALLER])
    .setFontWeight('bold').setBackground('#f1f5f9');
  sheet.setFrozenRows(filaDetalle);

  if (filas && filas.length > 0) {
    var rows = filas.map(function (f) {
      return [
        f.categoria || '', f.interno || '', f.tipo || '', f.novedad || '',
        f.sector || '', f.dia_parado || '', f.dias_en_reparacion || '', f.destino || ''
      ];
    });
    sheet.getRange(filaDetalle + 1, 1, rows.length, NUM_COLS_PARTE_TALLER).setValues(rows);
  }
}
