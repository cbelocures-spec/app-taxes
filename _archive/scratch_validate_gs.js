function doGet(e) {
  var accion = (e.parameter && e.parameter.accion);
  
  if (accion === "getFleetData") {
    return ContentService.createTextOutput(getFleetData())
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (accion === "getFuelData") {
    return ContentService.createTextOutput(getFuelData())
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (accion === "getHistoryData") {
    return ContentService.createTextOutput(getHistoryData())
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (accion === "getAlertsData") {
    return ContentService.createTextOutput(getAlertsData())
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (accion === "getLivianasData" || accion === "getUnidadesLivianas") {
    return ContentService.createTextOutput(getLivianasData())
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (accion === "processSpreadsheetFuelLoads") {
    return ContentService.createTextOutput(JSON.stringify({ result: processSpreadsheetFuelLoads() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (accion === "updateService") {
    var res = updateService(
      e.parameter.rowIndex,
      e.parameter.km,
      e.parameter.hs,
      e.parameter.interno,
      e.parameter.vehicleType
    );
    return ContentService.createTextOutput(JSON.stringify({ status: res }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (accion === "updateLivianasService") {
    var res = updateLivianasService(
      e.parameter.rowIndex,
      e.parameter.km,
      e.parameter.hs,
      e.parameter.interno,
      e.parameter.vehicleType
    );
    return ContentService.createTextOutput(JSON.stringify({ status: res }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (accion === "updateFuelService") {
    var res = updateFuelService(
      e.parameter.rowIndex,
      e.parameter.litros5k,
      e.parameter.litros10k,
      e.parameter.interno
    );
    return ContentService.createTextOutput(JSON.stringify({ status: res }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (accion === "updateOdometer") {
    var res = updateOdometer(
      e.parameter.rowIndex,
      e.parameter.km,
      e.parameter.hs,
      e.parameter.interno,
      e.parameter.vehicleType
    );
    return ContentService.createTextOutput(JSON.stringify({ status: res }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (accion === "updateLivianasOdometer") {
    var res = updateLivianasOdometer(
      e.parameter.rowIndex,
      e.parameter.km,
      e.parameter.hs,
      e.parameter.interno,
      e.parameter.vehicleType
    );
    return ContentService.createTextOutput(JSON.stringify({ status: res }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Por defecto, sirve la planilla web interactiva original
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Preventivos Hugo')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

var SOLD_TRUCKS = ["14", "17", "23", "25", "33", "35", "36", "38", "39", "40", "41", "43", "44", "45", "46", "47", "49", "55", "62", "70", "80", "81", "82", "83", "84", "85", "86", "107", "108", "113", "130"];

function isSold(interno, alerta) {
  if (!interno) return true;
  if (SOLD_TRUCKS.indexOf(String(interno).trim()) !== -1) return true;
  if (String(alerta).toLowerCase().indexOf("vendido") !== -1) return true;
  return false;
}

function getFleetData() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Copia de Hoja 2");
  if (!sheet) return "[]";
  var data = sheet.getDataRange().getValues();
  var fleetData = [];
  for(var i = 4; i < data.length; i++) {
    if(!data[i][0]) continue;
    if(isSold(data[i][0], data[i][9])) continue;
    
    fleetData.push({ originalRowIndex: i + 1, interno: data[i][0], modelo: data[i][1] || "-", kmReales: data[i][3] || 0, hsReales: data[i][4] || 0, restante: data[i][8] || 0, alerta: data[i][9] || "" });
  }
  return JSON.stringify(fleetData);
}

function getLivianasData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Unidadaes Livianas") || ss.getSheetByName("Unidades Livianas");
  if (!sheet) return "[]";
  var data = sheet.getDataRange().getValues();
  var livianasData = [];
  
  for (var i = 3; i < data.length; i++) {
    var row = data[i];
    var interno = String(row[0] || '').trim();
    if (!interno) continue;
    
    var modelo = String(row[1] || '').trim() || "-";
    var sector = String(row[2] || '').trim() || "TALLER";
    var serviFreq = String(row[3] || '').trim() || "-";
    var kmHsRealesRaw = row[4];
    var faltanteRaw = row[5];
    
    var esHoras = serviFreq.toLowerCase().indexOf('hs') !== -1;
    var kmHsReales = 0;
    if (typeof kmHsRealesRaw === 'number') {
      kmHsReales = kmHsRealesRaw;
    } else if (kmHsRealesRaw) {
      kmHsReales = parseFloat(String(kmHsRealesRaw).replace(/\./g, '').replace(',', '.')) || 0;
    }
    
    var faltanteStr = String(faltanteRaw || '').trim();
    var faltanteNum = 0;
    if (typeof faltanteRaw === 'number') {
      faltanteNum = faltanteRaw;
    } else if (faltanteRaw) {
      faltanteNum = parseFloat(faltanteStr.replace(/\./g, '').replace(',', '.')) || 0;
    }
    
    var alerta = "OK";
    if (esHoras) {
      if (faltanteNum <= 50 || faltanteStr.toLowerCase().indexOf('realizar') !== -1 || faltanteStr.toLowerCase().indexOf('urgente') !== -1) {
        alerta = "Realizar Service";
      }
    } else {
      if (faltanteNum <= 500 || faltanteStr.toLowerCase().indexOf('realizar') !== -1 || faltanteStr.toLowerCase().indexOf('urgente') !== -1) {
        alerta = "Realizar Service";
      }
    }
    
    livianasData.push({
      originalRowIndex: i + 1,
      interno: interno,
      modelo: modelo,
      sector: sector,
      serviFreq: serviFreq,
      kmReales: esHoras ? 0 : kmHsReales,
      hsReales: esHoras ? kmHsReales : 0,
      faltante: faltanteStr || (faltanteNum ? (faltanteNum + (esHoras ? ' Hs' : ' km')) : '-'),
      unidadMedida: esHoras ? 'hs' : 'km',
      alerta: alerta
    });
  }
  return JSON.stringify(livianasData);
}

function updateLivianasService(rowIndex, km, hs, interno, vehicleType) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Unidadaes Livianas") || ss.getSheetByName("Unidades Livianas");
  var esHoras = vehicleType === 'hs' || vehicleType === 'iveco';
  
  if (sheet) {
    var val = esHoras ? Number(hs) : Number(km);
    if (!isNaN(val) && val > 0) {
      sheet.getRange(rowIndex, 5).setValue(val);
    }
  }
  
  var historySheet = ss.getSheetByName("Historial Services") || ss.insertSheet("Historial Services");
  if (historySheet.getLastRow() === 0) historySheet.appendRow(["Fecha y Hora", "Interno", "Tipo", "Datos"]);
  
  var date = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "dd/MM/yyyy HH:mm");
  var tipo = esHoras ? "SERVICE LIVIANA HS" : "SERVICE LIVIANA KM";
  var datos = esHoras ? hs + " hs" : km + " km";
  historySheet.appendRow([date, interno, tipo, datos]);
  
  return "success";
}

function updateLivianasOdometer(rowIndex, km, hs, interno, vehicleType) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Unidadaes Livianas") || ss.getSheetByName("Unidades Livianas");
  var esHoras = vehicleType === 'hs' || vehicleType === 'iveco';
  
  if (sheet) {
    var val = esHoras ? Number(hs) : Number(km);
    if (!isNaN(val) && val > 0) {
      sheet.getRange(rowIndex, 5).setValue(val);
    }
  }
  
  var historySheet = ss.getSheetByName("Historial Services") || ss.insertSheet("Historial Services");
  if (historySheet.getLastRow() === 0) historySheet.appendRow(["Fecha y Hora", "Interno", "Tipo", "Datos"]);
  
  var date = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "dd/MM/yyyy HH:mm");
  var tipo = esHoras ? "ACTUALIZAR HS LIVIANA" : "ACTUALIZAR KM LIVIANA";
  var datos = esHoras ? hs + " hs" : km + " km";
  historySheet.appendRow([date, interno, tipo, datos]);
  
  return "success";
}

function getFuelData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Copia de Inspecciones PR-01-F01") || ss.getActiveSheet();
  if (!sheet) return "[]";
  var data = sheet.getDataRange().getValues();
  
  var lastServiceMap = {};
  var histSheet = ss.getSheetByName("Historial Services");
  if (histSheet && histSheet.getLastRow() > 1) {
    var histData = histSheet.getDataRange().getValues();
    for (var h = 1; h < histData.length; h++) {
      var hInterno = String(histData[h][1] || "").trim();
      var hTipo = String(histData[h][2] || "").trim().toUpperCase();
      var hFecha = histData[h][0];
      if (hInterno && (hTipo.indexOf("COMBUSTIBLE") !== -1 && hTipo.indexOf("NO ASIGNADO") === -1)) {
        var fechaStr = "";
        if (hFecha instanceof Date) {
          fechaStr = Utilities.formatDate(hFecha, ss.getSpreadsheetTimeZone(), "dd/MM/yyyy");
        } else {
          fechaStr = String(hFecha).split(" ")[0];
        }
        lastServiceMap[hInterno] = fechaStr;
      }
    }
  }
  
  var fuelData = [];
  for(var i = 4; i < data.length; i++) {
    if(!data[i][0]) continue;
    if(isSold(data[i][0], data[i][7])) continue;
    
    var internoStr = String(data[i][0]).trim();
    fuelData.push({ 
        originalRowIndex: i + 1, 
        interno: data[i][0], 
        modelo: data[i][1] || "-", 
        litrosTotales: data[i][2] || 0, 
        restante5k: data[i][6] || 0, 
        alerta5k: data[i][7] || "",
        restante10k: data[i][13] || 0,
        alerta10k: data[i][14] || "",
        lastService: lastServiceMap[internoStr] || ""
    });
  }
  return JSON.stringify(fuelData);
}

function updateService(rowIndex, km, hs, interno, vehicleType) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Copia de Hoja 2");
  var isIveco = vehicleType === 'iveco';
  
  var rowData = sheet.getRange(rowIndex, 1, 1, 10).getValues()[0];
  var alertaAntes = String(rowData[9] || "").trim();
  var teniaAlerta = alertaAntes.toLowerCase().indexOf("urgente") !== -1 || alertaAntes.toLowerCase().indexOf("service") !== -1;
  
  if (isIveco) {
    sheet.getRange(rowIndex, 5).setValue(Number(hs));
    sheet.getRange(rowIndex, 8).setValue(-Number(hs));
  } else {
    sheet.getRange(rowIndex, 4).setValue(Number(km));
    sheet.getRange(rowIndex, 6).setValue(Number(km));
  }
  
  var historySheet = ss.getSheetByName("Historial Services") || ss.insertSheet("Historial Services");
  if(historySheet.getLastRow() === 0) historySheet.appendRow(["Fecha y Hora", "Interno", "Tipo", "Datos"]);
  
  var date = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "dd/MM/yyyy HH:mm");
  var tipo = isIveco ? "SERVICE HORAS" : "SERVICE KM";
  var datos = isIveco ? hs + " hs" : km + " km";
  historySheet.appendRow([date, interno, tipo, datos]);
  
  var alertSheet = ss.getSheetByName("Registro Alertas") || ss.insertSheet("Registro Alertas");
  if (alertSheet.getLastRow() === 0) {
    alertSheet.appendRow(["Interno", "Tipo Preventivo", "Estado", "Fecha Alerta", "Fecha Realizado", "Demora (Dias)"]);
  }
  
  var tipoPreventivo = "Mantenimiento KM/HS";
  var alertData = alertSheet.getDataRange().getValues();
  var pendingRow = -1;
  for(var i = 1; i < alertData.length; i++) {
    if(String(alertData[i][0]).trim() === String(interno).trim() && alertData[i][1] === tipoPreventivo && alertData[i][2] === "Pendiente") {
      pendingRow = i + 1;
      break;
    }
  }
  
  if (teniaAlerta) {
    if (pendingRow !== -1) {
      var fechaAlertaVal = alertData[pendingRow - 1][3];
      var fechaAlertaDate = fechaAlertaVal instanceof Date ? fechaAlertaVal : new Date(String(fechaAlertaVal).split('/').reverse().join('-'));
      var diffDays = Math.floor(Math.abs(new Date() - fechaAlertaDate) / (1000 * 60 * 60 * 24));
      alertSheet.getRange(pendingRow, 3).setValue("Realizado");
      alertSheet.getRange(pendingRow, 5).setValue(date);
      alertSheet.getRange(pendingRow, 6).setValue(diffDays);
    } else {
      alertSheet.appendRow([interno, tipoPreventivo, "Realizado", date, date, 0]);
    }
  } else {
    if (pendingRow === -1) {
      alertSheet.appendRow([interno, tipoPreventivo, "Realizado", date, date, 0]);
    }
  }
  
  checkAndLogAlerts();
  return "success";
}

function updateFuelService(rowIndex, litros5k, litros10k, interno) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Copia de Inspecciones PR-01-F01") || ss.getActiveSheet();
  var historySheet = ss.getSheetByName("Historial Services") || ss.insertSheet("Historial Services");
  var date = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "dd/MM/yyyy HH:mm");
  if(historySheet.getLastRow() === 0) historySheet.appendRow(["Fecha y Hora", "Interno", "Tipo", "Datos"]);
  
  var rowData = sheet.getRange(rowIndex, 1, 1, 15).getValues()[0];
  var alerta5kAntes = String(rowData[7] || "").trim().toLowerCase();
  var alerta10kAntes = String(rowData[14] || "").trim().toLowerCase();
  var tenia5k = alerta5kAntes.indexOf("urgente") !== -1 || alerta5kAntes.indexOf("service") !== -1;
  var tenia10k = alerta10kAntes.indexOf("urgente") !== -1 || alerta10kAntes.indexOf("service") !== -1;
  
  if (litros5k !== null && litros5k !== "") {
      sheet.getRange(rowIndex, 6).setValue(Number(litros5k));
      historySheet.appendRow([date, interno, "COMBUSTIBLE (5K)", litros5k + " Lts"]);
  }
  
  if (litros10k !== null && litros10k !== "") {
      sheet.getRange(rowIndex, 13).setValue(Number(litros10k));
      historySheet.appendRow([date, interno, "COMBUSTIBLE (10K)", litros10k + " Lts"]);
      sheet.getRange(rowIndex, 6).setValue(Number(litros10k));
      historySheet.appendRow([date, interno, "COMBUSTIBLE (5K) - auto por 10K", litros10k + " Lts"]);
  }
  
  var alertSheet = ss.getSheetByName("Registro Alertas") || ss.insertSheet("Registro Alertas");
  if (alertSheet.getLastRow() === 0) {
    alertSheet.appendRow(["Interno", "Tipo Preventivo", "Estado", "Fecha Alerta", "Fecha Realizado", "Demora (Dias)"]);
  }
  var alertData = alertSheet.getDataRange().getValues();
  
  function resolveAlert(tipoPreventivo, teniaAlerta) {
    var pendingRow = -1;
    for(var i = 1; i < alertData.length; i++) {
      if(String(alertData[i][0]).trim() === String(interno).trim() && alertData[i][1] === tipoPreventivo && alertData[i][2] === "Pendiente") {
        pendingRow = i + 1;
        break;
      }
    }
    if (teniaAlerta) {
      if (pendingRow !== -1) {
        var fechaAlertaVal = alertData[pendingRow - 1][3];
        var fechaAlertaDate = fechaAlertaVal instanceof Date ? fechaAlertaVal : new Date(String(fechaAlertaVal).split('/').reverse().join('-'));
        var diffDays = Math.floor(Math.abs(new Date() - fechaAlertaDate) / (1000 * 60 * 60 * 24));
        alertSheet.getRange(pendingRow, 3).setValue("Realizado");
        alertSheet.getRange(pendingRow, 5).setValue(date);
        alertSheet.getRange(pendingRow, 6).setValue(diffDays);
      } else {
        alertSheet.appendRow([interno, tipoPreventivo, "Realizado", date, date, 0]);
      }
    } else {
      if (pendingRow === -1) {
        alertSheet.appendRow([interno, tipoPreventivo, "Realizado", date, date, 0]);
      }
    }
  }
  
  if (litros5k !== null && litros5k !== "") resolveAlert("Combustible 5K", tenia5k);
  if (litros10k !== null && litros10k !== "") resolveAlert("Combustible 10K", tenia10k);
  
  checkAndLogAlerts();
  return "success";
}

function getHistoryData() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Historial Services");
  if (!sheet) return "[]";
  var data = sheet.getDataRange().getValues();
  var history = [];
  for(var i = 1; i < data.length; i++) {
    var row = data[i];
    history.push({ 
      rowIndex: i + 1, 
      fecha: formatDateValue(row[0]), 
      interno: row[1], 
      tipo: row[2] || "KM/HS", 
      datos: row[3] || "-",
      conductor: row[4] || "",
      patente: row[5] || "",
      litros: row[6] || "",
      day: row[7] || "",
      month: row[8] || "",
      derivado: row[9] || ""
    });
  }
  return JSON.stringify(history.reverse());
}

function processSpreadsheetFuelLoads() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  var ypfSheet = ss.getSheetByName("combustible YPF");
  var shellSheet = ss.getSheetByName("BASE DE COMBUSTIBLE SHELL");
  
  if (!ypfSheet || !shellSheet) {
    var sheets = ss.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      var name = sheets[i].getName().toLowerCase().trim();
      if (!ypfSheet && name.indexOf("ypf") !== -1 && name.indexOf("copia") === -1 && name.indexOf("viejo") === -1) {
        ypfSheet = sheets[i];
      }
      if (!shellSheet && name.indexOf("shell") !== -1 && name.indexOf("copia") === -1 && name.indexOf("viejo") === -1) {
        shellSheet = sheets[i];
      }
    }
  }
  
  var loads = [];
  var ypfProcessedCount = 0;
  var shellProcessedCount = 0;
  
  var debugRowsYPF = [];
  var debugRowsSHELL = [];
  
  function processSheet(sheet, isYpf) {
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    
    var dataRange = sheet.getDataRange();
    var values = dataRange.getValues();
    var headers = values[0];
    
    var colPatente = isYpf ? 13 : 4;
    var colLitros = isYpf ? 19 : 10;
    var colConductor = isYpf ? 9 : -1;
    var colProcesado = isYpf ? 31 : 14;
    
    var colFecha = -1;
    for (var col = 0; col < Math.min(headers.length, colProcesado); col++) {
      var headerVal = String(headers[col]).trim().toLowerCase();
      if (headerVal.indexOf("fecha") !== -1 || headerVal.indexOf("dia") !== -1 || headerVal.indexOf("día") !== -1 || headerVal.indexOf("date") !== -1) {
        colFecha = col;
        break;
      }
    }
    if (colFecha === -1) colFecha = 0;
    
    var maxCols = sheet.getMaxColumns();
    if (maxCols < colProcesado + 1) {
      sheet.insertColumnsAfter(maxCols, (colProcesado + 1) - maxCols);
    }
    
    sheet.getRange(1, colProcesado + 1).setValue("Procesado");
    
    for (var r = 1; r < Math.min(values.length, 6); r++) {
      var row = values[r];
      var patVal = row[colPatente];
      var litVal = row[colLitros];
      var dateVal = row[colFecha];
      var condVal = colConductor !== -1 ? row[colConductor] : "-";
      var estVal = row.length > colProcesado ? row[colProcesado] : sheet.getRange(r + 1, colProcesado + 1).getValue();
      
      var rowDebug = "Fila " + (r + 1) + ": Patente=" + patVal + ", Litros=" + litVal + ", Fecha=" + dateVal + ", Cond=" + condVal + ", Est=" + estVal;
      if (isYpf) debugRowsYPF.push(rowDebug);
      else debugRowsSHELL.push(rowDebug);
    }
    
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var dateVal = row[colFecha];
      var patente = String(row[colPatente] || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      var litros = parseFloat(String(row[colLitros] || "").replace(",", "."));
      var conductor = colConductor !== -1 ? String(row[colConductor] || "").trim() : "";
      
      if (!patente || isNaN(litros) || litros <= 0 || !dateVal) {
        continue;
      }
      
      var parsedDate = null;
      if (dateVal instanceof Date) {
        parsedDate = dateVal;
      } else {
        var sDate = String(dateVal).trim();
        var dparts = sDate.split(" ")[0].split("/");
        if (dparts.length === 3) {
          parsedDate = new Date(dparts[2], dparts[1] - 1, dparts[0]);
        } else {
          dparts = sDate.split(" ")[0].split("-");
          if (dparts.length === 3) {
            if (dparts[0].length === 4) {
              parsedDate = new Date(dparts[0], dparts[1] - 1, dparts[2]);
            } else {
              parsedDate = new Date(dparts[2], dparts[1] - 1, dparts[0]);
            }
          }
        }
      }
      
      if (parsedDate && !isNaN(parsedDate.getTime())) {
        loads.push({
          patente: patente,
          litros: litros,
          day: parsedDate.getDate(),
          month: parsedDate.getMonth() + 1,
          conductor: conductor,
          sheetName: sheet.getName(),
          rowNum: r + 1,
          colNum: colProcesado + 1
        });
        
        if (isYpf) ypfProcessedCount++;
        else shellProcessedCount++;
      }
    }
  }
  
  processSheet(ypfSheet, true);
  processSheet(shellSheet, false);
  
  if (loads.length === 0) {
    var debugMsg = "No se encontraron nuevas cargas. Diagnostico:\n\n";
    debugMsg += "- Hoja YPF: " + (ypfSheet ? "Encontrada ('" + ypfSheet.getName() + "') con " + ypfSheet.getLastRow() + " filas\n" : "NO Encontrada\n");
    if (ypfSheet) {
      debugMsg += "  Primeras filas detectadas en YPF:\n  " + debugRowsYPF.join("\n  ") + "\n\n";
    }
    debugMsg += "- Hoja SHELL: " + (shellSheet ? "Encontrada ('" + shellSheet.getName() + "') con " + shellSheet.getLastRow() + " filas\n" : "NO Encontrada\n");
    if (shellSheet) {
      debugMsg += "  Primeras filas detectadas en SHELL:\n  " + debugRowsSHELL.join("\n  ") + "\n";
    }
    return debugMsg;
  }
  
  var uploadResult = processFuelUpload(loads);
  
  for (var i = 0; i < loads.length; i++) {
    var l = loads[i];
    var sh = ss.getSheetByName(l.sheetName);
    if (sh) {
      sh.getRange(l.rowNum, l.colNum).setValue("SI");
    }
  }
  
  return "Exito! Se procesaron " + (ypfProcessedCount + shellProcessedCount) + " cargas nuevas de combustible (" + ypfProcessedCount + " YPF, " + shellProcessedCount + " SHELL).\n\n" + uploadResult;
}

function processFuelUpload(loads) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  var baseSheet = ss.getSheetByName("Base Patentes");
  if (!baseSheet) throw new Error("No se encontró la pestaña 'Base Patentes'.");
  
  var baseData = baseSheet.getDataRange().getValues();
  var patToInterno = {}; 
  for(var i=1; i<baseData.length; i++) {
    var intCode = String(baseData[i][0]).trim();
    var pat = String(baseData[i][1]).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (intCode && pat && !isSold(intCode)) {
      patToInterno[pat] = intCode;
    }
  }
  
  var months = ["", "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  var sheetCaches = {};
  
  var updatedCount = 0;
  var skippedCount = 0;
  var missingPatentes = {};
  var batchWritten = {};
  
  for(var i=0; i<loads.length; i++) {
    var load = loads[i];
    var interno = patToInterno[load.patente];
    if (!interno) {
      missingPatentes[load.patente] = true;
      
      var historySheet = ss.getSheetByName("Historial Services") || ss.insertSheet("Historial Services");
      if(historySheet.getLastRow() === 0) {
        historySheet.appendRow(["Fecha y Hora", "Interno", "Tipo", "Datos", "Conductor", "Patente", "Litros", "Dia", "Mes", "Derivado"]);
      }
      
      var dateStr = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "dd/MM/yyyy HH:mm");
      var loadDateStr = load.day + "/" + load.month;
      historySheet.appendRow([
        dateStr, 
        load.patente, 
        "COMBUSTIBLE NO ASIGNADO", 
        "Carga de " + load.litros + " Lts el día " + loadDateStr + " (Patente: " + load.patente + " - Sin interno activo)", 
        load.conductor || "",
        load.patente, 
        load.litros, 
        load.day, 
        load.month, 
        ""
      ]);
      continue;
    }
    
    var sheetName = "Copia de " + months[load.month];
    if (!sheetCaches[sheetName]) {
      var sheet = ss.getSheetByName(sheetName);
      if (sheet) {
        sheetCaches[sheetName] = { sheet: sheet, data: sheet.getDataRange().getValues() };
      } else {
        missingPatentes[load.patente] = true;
        
        var historySheet = ss.getSheetByName("Historial Services") || ss.insertSheet("Historial Services");
        if(historySheet.getLastRow() === 0) {
          historySheet.appendRow(["Fecha y Hora", "Interno", "Tipo", "Datos", "Conductor", "Patente", "Litros", "Dia", "Mes", "Derivado"]);
        }
        
        var dateStr = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "dd/MM/yyyy HH:mm");
        var loadDateStr = load.day + "/" + load.month;
        historySheet.appendRow([
          dateStr, 
          load.patente, 
          "COMBUSTIBLE NO ASIGNADO", 
          "Carga de " + load.litros + " Lts el día " + loadDateStr + " (Patente: " + load.patente + " - Mes " + months[load.month] + " no existe)", 
          load.conductor || "",
          load.patente, 
          load.litros, 
          load.day, 
          load.month, 
          ""
        ]);
        continue;
      }
    }
    
    var cache = sheetCaches[sheetName];
    var rowIndex = -1;
    for(var r=0; r<cache.data.length; r++) {
      if(String(cache.data[r][0]).trim() === String(interno)) {
        rowIndex = r;
        break;
      }
    }
    
    if (rowIndex === -1) {
      missingPatentes[load.patente] = true;
      
      var historySheet = ss.getSheetByName("Historial Services") || ss.insertSheet("Historial Services");
      if(historySheet.getLastRow() === 0) {
        historySheet.appendRow(["Fecha y Hora", "Interno", "Tipo", "Datos", "Conductor", "Patente", "Litros", "Dia", "Mes", "Derivado"]);
      }
      
      var dateStr = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "dd/MM/yyyy HH:mm");
      var loadDateStr = load.day + "/" + load.month;
      historySheet.appendRow([
        dateStr, 
        load.patente, 
        "COMBUSTIBLE NO ASIGNADO", 
        "Carga de " + load.litros + " Lts el día " + loadDateStr + " (Patente: " + load.patente + " - Interno " + interno + " no encontrado en el mes)", 
        load.conductor || "",
        load.patente, 
        load.litros, 
        load.day, 
        load.month, 
        ""
      ]);
      continue;
    }
    
    var colIndex = load.day; 
    var currentVal = parseFloat(cache.data[rowIndex][colIndex]) || 0;
    var cellKey = sheetName + "_" + rowIndex + "_" + colIndex;
    
    if (currentVal > 0 && !batchWritten[cellKey]) {
      skippedCount++;
      continue;
    }
    
    var newVal = currentVal + load.litros;
    cache.data[rowIndex][colIndex] = newVal;
    cache.sheet.getRange(rowIndex + 1, colIndex + 1).setValue(newVal);
    batchWritten[cellKey] = true;
    updatedCount++;
  }
  
  var msg = "Exito! Se registraron " + updatedCount + " cargas de combustible en los calendarios mensuales.";
  if (skippedCount > 0) {
    msg += "\n(Se omitieron " + skippedCount + " cargas de dias ya cargados previamente).";
  }
  var mPat = Object.keys(missingPatentes);
  if (mPat.length > 0) msg += "\n\nAtencion: Las siguientes patentes del Excel no se encontraron en Base Patentes o no tienen un interno activo en este mes, y se registraron en el Historial para derivacion manual: " + mPat.join(", ");
  
  checkAndLogAlerts();
  return msg;
}

function deriveFuelLoad(historyRowIndex, targetInterno) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var historySheet = ss.getSheetByName("Historial Services");
  if (!historySheet) throw new Error("No se encontró la pestaña 'Historial Services'.");
  
  var rowRange = historySheet.getRange(historyRowIndex, 1, 1, 10);
  var rowValues = rowRange.getValues()[0];
  
  var tipo = rowValues[2];
  if (tipo !== "COMBUSTIBLE NO ASIGNADO") {
    throw new Error("Este registro no corresponde a una carga de combustible no asignada.");
  }
  
  var derivado = rowValues[9];
  if (derivado) {
    throw new Error("Esta carga ya fue derivada al interno " + derivado);
  }
  
  var patente = rowValues[5];
  var litros = Number(rowValues[6]);
  var day = Number(rowValues[7]);
  var month = Number(rowValues[8]);
  
  if (isNaN(litros) || litros <= 0 || isNaN(day) || isNaN(month)) {
    throw new Error("Datos de combustible inválidos en el historial.");
  }
  
  var months = ["", "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  var sheetName = "Copia de " + months[month];
  var monthSheet = ss.getSheetByName(sheetName);
  if (!monthSheet) throw new Error("No se encontró la pestaña del mes '" + sheetName + "'.");
  
  var monthData = monthSheet.getDataRange().getValues();
  var vehicleRowIndex = -1;
  for (var r = 0; r < monthData.length; r++) {
    if (String(monthData[r][0]).trim() === String(targetInterno).trim()) {
      vehicleRowIndex = r + 1;
      break;
    }
  }
  
  if (vehicleRowIndex === -1) {
    throw new Error("No se encontró el interno " + targetInterno + " en la planilla del mes " + months[month]);
  }
  
  var colIndex = day + 1;
  var currentVal = parseFloat(monthSheet.getRange(vehicleRowIndex, colIndex).getValue()) || 0;
  var newVal = currentVal + litros;
  monthSheet.getRange(vehicleRowIndex, colIndex).setValue(newVal);
  
  historySheet.getRange(historyRowIndex, 2).setValue(String(targetInterno));
  historySheet.getRange(historyRowIndex, 3).setValue("COMBUSTIBLE DERIVADO");
  
  var dateStr = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "dd/MM/yyyy HH:mm");
  var loadDateStr = day + "/" + month;
  var newDatos = "Carga de " + litros + " Lts derivada a Interno " + targetInterno + " (Patente: " + patente + ", Fecha carga: " + loadDateStr + ", Derivado el: " + dateStr + ")";
  historySheet.getRange(historyRowIndex, 4).setValue(newDatos);
  historySheet.getRange(historyRowIndex, 10).setValue(String(targetInterno));
  
  return "success";
}

function formatDateValue(val) {
  if (!val) return "";
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (val instanceof Date) {
    return Utilities.formatDate(val, ss.getSpreadsheetTimeZone(), "dd/MM/yyyy");
  }
  var s = String(val).trim();
  if (s.indexOf("T") !== -1 && s.indexOf("-") !== -1) {
    var parts = s.split("T")[0].split("-");
    if (parts.length === 3) {
      return parts[2] + "/" + parts[1] + "/" + parts[0];
    }
  }
  if (s.indexOf(" ") !== -1) {
    s = s.split(" ")[0];
  }
  return s;
}

function parseDateString(ds) {
  if (ds instanceof Date) return ds;
  var parts = String(ds).split(" ");
  var dparts = parts[0].split("/");
  if (dparts.length === 3) {
    return new Date(dparts[2], dparts[1]-1, dparts[0]);
  }
  return new Date();
}

function checkAndLogAlerts() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var alertSheet = ss.getSheetByName("Registro Alertas") || ss.insertSheet("Registro Alertas");
  
  if (alertSheet.getLastRow() === 0) {
    alertSheet.appendRow(["Interno", "Tipo Preventivo", "Estado", "Fecha Alerta", "Fecha Realizado", "Demora (Días)"]);
  }
  
  var alertData = alertSheet.getDataRange().getValues();
  var activeAlerts = {};
  for(var i=1; i<alertData.length; i++) {
    var estado = alertData[i][2];
    if (estado === "Pendiente") {
      var key = alertData[i][0] + "-" + alertData[i][1];
      activeAlerts[key] = i + 1;
    }
  }
  
  var today = new Date();
  var todayStr = Utilities.formatDate(today, ss.getSpreadsheetTimeZone(), "dd/MM/yyyy HH:mm");
  
  var fleetSheet = ss.getSheetByName("Copia de Hoja 2");
  if (fleetSheet) {
    var fleetData = fleetSheet.getDataRange().getValues();
    for(var i=4; i<fleetData.length; i++) {
      var interno = String(fleetData[i][0]).trim();
      var alerta = String(fleetData[i][9] || "").trim();
      if (!interno || isSold(interno, alerta)) continue;
      
      var tipo = "Mantenimiento KM/HS";
      var key = interno + "-" + tipo;
      
      if (alerta.toLowerCase().indexOf("urgente") !== -1 || alerta.toLowerCase().indexOf("service") !== -1) {
        if (!activeAlerts[key]) alertSheet.appendRow([interno, tipo, "Pendiente", todayStr, "", ""]);
      } else {
        if (activeAlerts[key]) {
          var rIndex = activeAlerts[key];
          var fAlertaDate = parseDateString(alertData[rIndex-1][3]);
          var diffTime = Math.abs(today - fAlertaDate);
          var diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
          alertSheet.getRange(rIndex, 3).setValue("Realizado");
          alertSheet.getRange(rIndex, 5).setValue(todayStr);
          alertSheet.getRange(rIndex, 6).setValue(diffDays);
        }
      }
    }
  }
  
  var fuelSheet = ss.getSheetByName("Copia de Inspecciones PR-01-F01") || ss.getActiveSheet();
  if (fuelSheet) {
    var fuelData = fuelSheet.getDataRange().getValues();
    for(var i=4; i<fuelData.length; i++) {
      var interno = String(fuelData[i][0]).trim();
      var alerta5k = String(fuelData[i][7] || "").trim();
      var alerta10k = String(fuelData[i][14] || "").trim();
      if (!interno || isSold(interno, alerta5k)) continue;
      
      var tipo5k = "Combustible 5K";
      var key5k = interno + "-" + tipo5k;
      if (alerta5k.toLowerCase().indexOf("urgente") !== -1 || alerta5k.toLowerCase().indexOf("service") !== -1) {
        if (!activeAlerts[key5k]) alertSheet.appendRow([interno, tipo5k, "Pendiente", todayStr, "", ""]);
      } else {
        if (activeAlerts[key5k]) {
          var rIndex = activeAlerts[key5k];
          var fAlertaDate = parseDateString(alertData[rIndex-1][3]);
          var diffDays = Math.floor(Math.abs(today - fAlertaDate) / (1000 * 60 * 60 * 24)); 
          alertSheet.getRange(rIndex, 3).setValue("Realizado");
          alertSheet.getRange(rIndex, 5).setValue(todayStr);
          alertSheet.getRange(rIndex, 6).setValue(diffDays);
        }
      }
      
      var tipo10k = "Combustible 10K";
      var key10k = interno + "-" + tipo10k;
      if (alerta10k.toLowerCase().indexOf("urgente") !== -1 || alerta10k.toLowerCase().indexOf("service") !== -1) {
        if (!activeAlerts[key10k]) alertSheet.appendRow([interno, tipo10k, "Pendiente", todayStr, "", ""]);
      } else {
        if (activeAlerts[key10k]) {
          var rIndex = activeAlerts[key10k];
          var fAlertaDate = parseDateString(alertData[rIndex-1][3]);
          var diffDays = Math.floor(Math.abs(today - fAlertaDate) / (1000 * 60 * 60 * 24)); 
          alertSheet.getRange(rIndex, 3).setValue("Realizado");
          alertSheet.getRange(rIndex, 5).setValue(todayStr);
          alertSheet.getRange(rIndex, 6).setValue(diffDays);
        }
      }
    }
  }
}

function getAlertsData() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Registro Alertas");
  if (!sheet) return "[]";
  var data = sheet.getDataRange().getValues();
  var alerts = [];
  for(var i = 1; i < data.length; i++) {
    alerts.push({
      interno: data[i][0],
      tipo: data[i][1],
      estado: data[i][2],
      fechaAlerta: formatDateValue(data[i][3]),
      fechaRealizado: formatDateValue(data[i][4]) || "-",
      demora: data[i][5] !== "" ? data[i][5] : "-"
    });
  }
  return JSON.stringify(alerts.reverse());
}

function updateOdometer(rowIndex, km, hs, interno, vehicleType) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Copia de Hoja 2");
  var isIveco = vehicleType === 'iveco';
  
  if (isIveco) {
    sheet.getRange(rowIndex, 5).setValue(Number(hs));
  } else {
    sheet.getRange(rowIndex, 4).setValue(Number(km));
  }
  
  var historySheet = ss.getSheetByName("Historial Services") || ss.insertSheet("Historial Services");
  if(historySheet.getLastRow() === 0) historySheet.appendRow(["Fecha y Hora", "Interno", "Tipo", "Datos"]);
  
  var date = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "dd/MM/yyyy HH:mm");
  var tipo = isIveco ? "ACTUALIZAR HS" : "ACTUALIZAR KM";
  var datos = isIveco ? hs + " hs" : km + " km";
  historySheet.appendRow([date, interno, tipo, datos]);
  
  checkAndLogAlerts();
  return "success";
}
