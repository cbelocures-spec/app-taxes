const https = require('https');

const url = 'https://script.google.com/macros/s/AKfycbyoHEhogBxWcSIdDtzzUIV9mhzO25TNAChgBlCCJbuHPIylXNpIpX8LKM6qc4DQjij8/exec';

function fetchUrl(targetUrl) {
  return new Promise((resolve) => {
    https.get(targetUrl, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(res.headers.location));
      }
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', err => resolve(err.message));
  });
}

async function run() {
  const html = await fetchUrl(url);
  const idx = html.indexOf('Estado en Taller');
  if (idx !== -1) {
    console.log("=== FOUND 'Estado en Taller' IN GOOGLE APPS SCRIPT HTML ===");
    console.log(html.substring(idx - 100, idx + 800));
  } else {
    console.log("Not found directly, searching for 'transito'...");
    const idx2 = html.indexOf('transito');
    if (idx2 !== -1) {
      console.log(html.substring(idx2 - 100, idx2 + 800));
    }
  }
}

run();
