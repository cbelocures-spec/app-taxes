const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function generatePDF() {
  const htmlContent = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Diagramas Flujograma y Mapa de Proceso - ISO 9001</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    @page {
      size: A4 portrait;
      margin: 10mm;
    }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      color: #0f172a;
      background: #ffffff;
      margin: 0;
      padding: 10px;
    }
    .header {
      text-align: center;
      border-bottom: 2px solid #1e3a8a;
      padding-bottom: 8px;
      margin-bottom: 15px;
    }
    .header h1 {
      font-size: 18px;
      color: #0f172a;
      margin: 0 0 4px 0;
      text-transform: uppercase;
    }
    .header h2 {
      font-size: 13px;
      color: #2563eb;
      margin: 0;
      font-weight: 600;
    }
    .meta-bar {
      display: flex;
      justify-content: space-between;
      background: #f1f5f9;
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      color: #334155;
      margin-top: 6px;
    }
    .section-title {
      font-size: 14px;
      color: #1e3a8a;
      border-left: 4px solid #2563eb;
      padding-left: 8px;
      margin: 16px 0 10px 0;
      font-weight: 700;
    }
    .diagram-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 20px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.04);
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .mermaid {
      width: 100%;
      display: flex;
      justify-content: center;
    }
    .page-break {
      page-break-before: always;
    }
  </style>
</head>
<body>

  <div class="header">
    <h1>Contenedores Hugo S.A.</h1>
    <h2>DOCUMENTO OFICIAL: MAPA DE PROCESO Y FLUJOGRAMA OPERATIVO (ISO 9001:2015)</h2>
    <div class="meta-bar">
      <span>Código: POE-MANT-01 v3.2</span>
      <span>Vigencia: Julio 2026</span>
      <span>Aprobado: Jefatura de Taller & Supervisión</span>
    </div>
  </div>

  <!-- DIAGRAMA 1: MAPA DE PROCESO -->
  <div class="section-title">2. Mapa de Proceso (Macroproceso)</div>
  <div class="diagram-card">
    <pre class="mermaid">
graph LR
    subgraph ENTRADAS
        A["Chofer / Novedad WhatsApp"]
        B["Control Diario Fluidos (Chequeador)"]
        C["Plan de Preventivos Programados"]
        D["Solicitud de Herrería"]
    end

    subgraph PROCESO PRINCIPAL
        E["1. Registro & Clasificación (App Nativa)"]
        F["2. Despacho Auxilio / Taller"]
        G["3. Ejecución & Tiempos (Mecánicos)"]
        H["4. Control & Validación (Supervisor)"]
        I["5. Sincronización Oficial (Asistente IA)"]
    end

    subgraph SALIDAS & ANÁLISIS
        J["Unidad Operativa en Ruta ✅"]
        K["Google Sheets 2026 (KPI & Auxilios)"]
        L["Asistente Hugo AI (Consultas)"]
    end

    A --> E
    B --> E
    C --> E
    D --> E
    E --> F
    F --> G
    G --> H
    H --> I
    I --> J
    I --> K
    K --> L
    </pre>
  </div>

  <div class="page-break"></div>

  <!-- DIAGRAMA 2: FLUJOGRAMA DETALLADO CON ROMBOS DE DECISIÓN -->
  <div class="section-title">4. Flujograma Operativo Detallado del Procedimiento</div>
  <div class="diagram-card">
    <pre class="mermaid">
flowchart TD
    Start([Inicio: Detección de Novedad, Fluidos, Preventivo o Auxilio]) --> ChoiceSource{¿Tipo de Evento?}
    
    ChoiceSource -- Control Diario de Fluidos --> ChequeadorCheck["Chequeador/Inspector realiza control de fluidos y revisión general en playa"]
    ChoiceSource -- Auxilio Mecánico en Ruta --> AuxilioRoute["Chofer reporta Auxilio Urgente vía Chatbot WhatsApp"]
    ChoiceSource -- Preventivo / Herrería --> AppCreate["Crear OT en App Nativa"]

    ChequeadorCheck -- Novedad / Fluido Bajo --> AutoPT["Actualización Automática Parte de Taller<br>(Estado: Fuera de Servicio / Reparación)"]
    AuxilioRoute --> DispatchAux["Despacho Urgente de Auxilio Mecánico Móvil"]
    DispatchAux --> AutoPT

    AutoPT --> AppCreate

    AppCreate --> AssignTask["Asignar Tareas (Preventivo / Correctivo / Herrería / Auxilio), Supervisor, Mecánico e Insumos"]
    AssignTask --> Timers["Mecánico / Auxilio inicia Cronómetro en App Nativa"]
    Timers --> MechWork["Ejecución del Trabajo Mecánico / Rescate en Ruta"]
    MechWork --> FinishTask["Finalización de Tareas e Insumos Registrados"]

    FinishTask --> ControlCheck["Validación Supervisor / Jefe de Taller"]
    ControlCheck --> SyncWorker["Asistente IA (Puppeteer) sincroniza con Taxes.com.ar"]

    SyncWorker --> TaxesCheck{¿Subida a Taxes exitosa?}
    TaxesCheck -- Reintento --> SyncWorker
    TaxesCheck -- Sí --> TaxesOT["Generación N° OT Oficial Taxes"]

    TaxesOT --> History["Auto-archivado a Historial App"]
    History --> GSheets["Exportación a Google Sheets (Gestión 2026 - Pestaña Auxilios/Mantenimiento)"]
    GSheets --> HugoAI["Disponible para Consultas en Hugo AI Assistant"]
    HugoAI --> UnitOK["Unidad ✅ OPERATIVA"]
    UnitOK --> End([Fin del Proceso])
    </pre>
  </div>

  <script>
    mermaid.initialize({
      startOnLoad: true,
      theme: 'default',
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis'
      }
    });
  </script>

</body>
</html>
  `;

  const htmlPath = path.join(__dirname, 'temp_mermaid.html');
  fs.writeFileSync(htmlPath, htmlContent, 'utf8');

  const stdPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const x86Path = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
  const executablePath = fs.existsSync(stdPath) ? stdPath : (fs.existsSync(x86Path) ? x86Path : undefined);

  console.log('Launching browser to render exact Mermaid diagrams into PDF...');
  const browser = await puppeteer.launch({
    executablePath: executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

  // Wait for Mermaid to render SVGs
  await page.waitForSelector('.mermaid svg', { timeout: 10000 });

  const pdfPath = path.join(__dirname, 'public', 'Mapa_y_Flujograma_Mantenimiento_ISO9001.pdf');
  const pdfWorkspacePath = path.join(__dirname, 'Mapa_y_Flujograma_Mantenimiento_ISO9001.pdf');
  const pdfFullProcedurePath = path.join(__dirname, 'public', 'Procedimiento_Mantenimiento_ISO9001.pdf');

  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' }
  });

  fs.copyFileSync(pdfPath, pdfWorkspacePath);
  fs.copyFileSync(pdfPath, pdfFullProcedurePath);

  await browser.close();
  fs.unlinkSync(htmlPath);

  console.log('PDF with EXACT Mermaid diagrams generated successfully at:', pdfPath);
}

generatePDF().catch(err => {
  console.error('Error generating PDF:', err);
});
