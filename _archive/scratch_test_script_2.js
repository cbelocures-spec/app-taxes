const scriptUrl = 'https://script.google.com/macros/s/AKfycbwuPIslBnq77dG5bhk19h2H2s9TlOeB6XrCpqCMDX-8dvO8uisNRdx7P43lyJtT1sZIgQ/exec';

async function testAll() {
  const actions = ['getFleetData', 'getLivianas', 'getUnidadesLivianas', 'getLivianasData', 'getTabLivianas', 'getSheetsData'];
  for (const act of actions) {
    try {
      const r = await fetch(`${scriptUrl}?accion=${act}`);
      const text = await r.text();
      console.log(`=== ${act} ===`);
      console.log('Status:', r.status);
      console.log('Text (first 300 chars):', text.slice(0, 300));
    } catch (e) {
      console.log(`Err ${act}:`, e.message);
    }
  }
}

testAll();
