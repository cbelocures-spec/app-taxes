const https = require('https');

const SHEET_URL = 'https://script.google.com/macros/s/AKfycbxbCEe6CPyN02seTWd0VO6mYljxX5N27oT2I5QJS-ZtRn7_PTm-oxI54p5rN6RCU8anVA/exec';

https.get(SHEET_URL, (res) => {
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    https.get(res.headers.location, (res2) => {
      let data = '';
      res2.on('data', c => data += c);
      res2.on('end', () => console.log("Sheet status:", data));
    });
  } else {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => console.log("Sheet status:", data));
  }
});
