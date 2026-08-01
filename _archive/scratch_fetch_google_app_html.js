const https = require('https');

const url = 'https://script.google.com/macros/s/AKfycbyoHEhogBxWcSIdDtzzUIV9mhzO25TNAChgBlCCJbuHPIylXNpIpX8LKM6qc4DQjij8/exec';

function fetchUrl(targetUrl) {
  return new Promise((resolve) => {
    https.get(targetUrl, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`Redirecting to: ${res.headers.location}`);
        return resolve(fetchUrl(res.headers.location));
      }
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', err => resolve(err.message));
  });
}

async function run() {
  console.log("Fetching Google Apps Script Web App HTML...");
  const html = await fetchUrl(url);
  console.log(`HTML Length: ${html.length} bytes`);
  console.log("Snippet:", html.substring(0, 500));
}

run();
