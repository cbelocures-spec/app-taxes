const scriptUrl = 'https://script.google.com/macros/s/AKfycbwuPIslBnq77dG5bhk19h2H2s9TlOeB6XrCpqCMDX-8dvO8uisNRdx7P43lyJtT1sZIgQ/exec';

async function checkActions() {
  const actions = ['getFleetData', 'getFuelData', 'getHistoryData'];
  for (const act of actions) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 20000);
      const r = await fetch(`${scriptUrl}?accion=${act}`, { signal: controller.signal });
      clearTimeout(id);
      const text = await r.text();
      console.log(`Action [${act}]: status=${r.status}, length=${text.length}`);
      if (text.startsWith('{') || text.startsWith('[')) {
        console.log(`  -> JSON response snippet: ${text.slice(0, 300)}`);
      } else {
        console.log(`  -> HTML response snippet: ${text.slice(0, 100)}`);
      }
    } catch (e) {
      console.log(`Action [${act}]: error = ${e.message}`);
    }
  }
}

checkActions();
