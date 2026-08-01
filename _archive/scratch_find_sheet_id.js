const scriptUrl = 'https://script.google.com/macros/s/AKfycbwuPIslBnq77dG5bhk19h2H2s9TlOeB6XrCpqCMDX-8dvO8uisNRdx7P43lyJtT1sZIgQ/exec';

async function findSpreadsheetId() {
  const r = await fetch(scriptUrl);
  const text = await r.text();
  console.log('HTML size:', text.length);
  const matches = text.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/g);
  console.log('Spreadsheet URL matches:', matches);
  
  // Also search for any 30+ char Google IDs
  const idMatches = text.match(/1[a-zA-Z0-9_-]{30,45}/g);
  console.log('ID matches sample:', idMatches ? [...new Set(idMatches)].slice(0, 10) : 'none');
}

findSpreadsheetId();
