// Maintains "Hoja_de_Controles.xlsx" - one accumulating workbook, one sheet per control type
// (Grasa Caja, Grasa Diferencial, Ctrol Refrigerante, Ctrol Aceite Motor, Hco Direccion,
// Hco Equipo, Vigia, Luces, Bateria, Alternador), mirroring the paper/Google-Sheets log the
// Taller kept by hand before this. Every Carga Masiva adds one new column (responsable +
// fecha) per sheet it touched, instead of replacing the file - this is the single persistent
// history, not a per-masiva snapshot.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const db = require('./database');

// Lives next to db.json on the durable volume (not __dirname, which is the bundled code
// directory and gets replaced wholesale on every deploy - a file written there would vanish
// the next time this app redeploys).
const EXCEL_PATH = path.join(path.dirname(db.DB_PATH), 'Hoja_de_Controles.xlsx');

// Keep in sync with BULK_INSUMO_TYPES in public/app.js.
const CONTROL_TIPOS = [
  { key: 'refrigerante', hoja: 'Ctrol Refrigerante' },
  { key: 'aceite_motor', hoja: 'Ctrol Aceite Motor' },
  { key: 'grasa_caja', hoja: 'Grasa Caja' },
  { key: 'grasa_diferencial', hoja: 'Grasa Diferencial' },
  { key: 'hco_direccion', hoja: 'Hco Direccion' },
  { key: 'hco_equipo', hoja: 'Hco Equipo' },
  { key: 'vigia', hoja: 'Vigia' },
  { key: 'luces', hoja: 'Luces' },
  { key: 'bateria', hoja: 'Bateria' },
  { key: 'alternador', hoja: 'Alternador' }
];
const HOJA_POR_TIPO = Object.fromEntries(CONTROL_TIPOS.map(t => [t.key, t.hoja]));

const HEADER_ROW = 1;
const DATE_ROW = 2;
const FIRST_DATA_ROW = 3;
const INTERNO_COL = 1;

const FILL_OK = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF57BB8A' } };
const FILL_SUCIO = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF9C2B2B' } };
const FILL_HCO = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5BC8D6' } };
const FILL_PERDIDA = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8A33D' } };
const FILL_LITROS = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
const FONT_WHITE = { color: { argb: 'FFFFFFFF' }, bold: true };
const FONT_DARK = { color: { argb: 'FF1F2933' }, bold: true };

// bateria/alternador miden voltaje, no litros; vigia/luces son un control de
// funcionamiento (OK/Sucio/etc.), un numero ahi no tiene unidad propia.
const TIPOS_VOLTAJE = new Set(['bateria', 'alternador']);
const TIPOS_SIN_UNIDAD = new Set(['vigia', 'luces']);

function estiloParaValor(valorCrudo, tipo) {
  const norm = String(valorCrudo || '').trim().toUpperCase();
  if (norm === 'OK') return { texto: 'OK', fill: FILL_OK, font: FONT_WHITE };
  if (norm === 'SUCIO') return { texto: 'Sucio', fill: FILL_SUCIO, font: FONT_WHITE };
  if (norm === 'HCO') return { texto: 'Hco', fill: FILL_HCO, font: FONT_DARK };
  if (norm === 'PERDIDA' || norm === 'PÉRDIDA') return { texto: 'Perdida', fill: FILL_PERDIDA, font: FONT_DARK };
  const numero = Number(String(valorCrudo).replace(',', '.'));
  if (!Number.isNaN(numero) && String(valorCrudo).trim() !== '') {
    if (TIPOS_SIN_UNIDAD.has(tipo)) return { texto: `${numero}`, fill: FILL_LITROS, font: FONT_DARK };
    const unidad = TIPOS_VOLTAJE.has(tipo) ? 'Volt' : 'Lts';
    return { texto: `${numero} ${unidad}`, fill: FILL_LITROS, font: FONT_DARK };
  }
  return { texto: String(valorCrudo || ''), fill: null, font: null };
}

async function cargarOCrearWorkbook() {
  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(EXCEL_PATH)) {
    await workbook.xlsx.readFile(EXCEL_PATH);
  }
  return workbook;
}

function obtenerOCrearHoja(workbook, nombreHoja) {
  let sheet = workbook.getWorksheet(nombreHoja);
  if (!sheet) {
    sheet = workbook.addWorksheet(nombreHoja);
    sheet.getCell(FIRST_DATA_ROW - 1, INTERNO_COL).value = 'Internos / Dias';
    sheet.getColumn(INTERNO_COL).width = 12;
    sheet.getCell(FIRST_DATA_ROW - 1, INTERNO_COL).font = { bold: true };
    sheet.getCell(FIRST_DATA_ROW - 2, INTERNO_COL).value = 'Empleado';
    sheet.getCell(FIRST_DATA_ROW - 2, INTERNO_COL).font = { bold: true };
  }
  return sheet;
}

function proximaColumnaLibre(sheet) {
  let maxCol = INTERNO_COL;
  sheet.getRow(HEADER_ROW).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (colNumber > maxCol) maxCol = colNumber;
  });
  sheet.getRow(DATE_ROW).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (colNumber > maxCol) maxCol = colNumber;
  });
  return maxCol + 1;
}

function encontrarOInsertarFilaInterno(sheet, interno) {
  const internoNum = parseInt(interno, 10);
  const internoKey = String(interno).trim();
  let row = FIRST_DATA_ROW;
  let lastRowWithData = FIRST_DATA_ROW - 1;
  while (true) {
    const cellVal = sheet.getCell(row, INTERNO_COL).value;
    if (cellVal === null || cellVal === undefined || cellVal === '') break;
    const existingKey = String(cellVal).trim();
    if (existingKey === internoKey) return row;
    const existingNum = parseInt(existingKey, 10);
    if (!Number.isNaN(internoNum) && !Number.isNaN(existingNum) && existingNum > internoNum) {
      sheet.spliceRows(row, 0, [internoKey]);
      return row;
    }
    lastRowWithData = row;
    row++;
  }
  const targetRow = lastRowWithData + 1;
  sheet.getCell(targetRow, INTERNO_COL).value = internoKey;
  sheet.getCell(targetRow, INTERNO_COL).font = { bold: true };
  return targetRow;
}

// Precarga todos los internos reales de la flota como filas (ordenadas), aunque no tengan
// dato en esta masiva puntual - misma logica que el Google Apps Script equivalente.
function asegurarTodasLasFilas(sheet, todosInternos) {
  if (!Array.isArray(todosInternos) || todosInternos.length === 0) return;
  const ordenados = [...todosInternos].sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  ordenados.forEach(interno => encontrarOInsertarFilaInterno(sheet, interno));
}

// registros: [{ interno, modelo, patente, controles: [{ tipo, valor }] }]
async function actualizarExcelControles({ fecha, responsable, registros, todosInternos }) {
  if (!Array.isArray(registros) || registros.length === 0) {
    return { path: EXCEL_PATH, hojasActualizadas: [] };
  }

  const workbook = await cargarOCrearWorkbook();
  const tiposPresentes = new Set();
  registros.forEach(r => (r.controles || []).forEach(c => tiposPresentes.add(c.tipo)));

  const hojasActualizadas = [];

  for (const tipo of tiposPresentes) {
    const nombreHoja = HOJA_POR_TIPO[tipo];
    if (!nombreHoja) continue;
    const sheet = obtenerOCrearHoja(workbook, nombreHoja);
    asegurarTodasLasFilas(sheet, todosInternos);
    const col = proximaColumnaLibre(sheet);

    sheet.getCell(HEADER_ROW, col).value = responsable || '';
    sheet.getCell(HEADER_ROW, col).font = { bold: true };
    sheet.getCell(DATE_ROW, col).value = fecha || '';
    sheet.getCell(DATE_ROW, col).font = { bold: true };
    sheet.getColumn(col).width = 12;

    registros.forEach(reg => {
      const controlEntry = (reg.controles || []).find(c => c.tipo === tipo);
      if (!controlEntry) return;
      const targetRow = encontrarOInsertarFilaInterno(sheet, reg.interno);
      const { texto, fill, font } = estiloParaValor(controlEntry.valor, tipo);
      const cell = sheet.getCell(targetRow, col);
      cell.value = texto;
      cell.alignment = { horizontal: 'center' };
      if (fill) cell.fill = fill;
      if (font) cell.font = font;
    });

    hojasActualizadas.push(nombreHoja);
  }

  await workbook.xlsx.writeFile(EXCEL_PATH);
  return { path: EXCEL_PATH, hojasActualizadas };
}

function existeExcelControles() {
  return fs.existsSync(EXCEL_PATH);
}

module.exports = { actualizarExcelControles, existeExcelControles, EXCEL_PATH, CONTROL_TIPOS };
