const https = require('https');
const fs = require('fs');
const path = require('path');

const url = 'https://app-taxes-production.up.railway.app/last_sync_error.png';
const dest = path.join(__dirname, 'last_sync_error.png');

console.log(`Downloading last_sync_error image from: ${url}`);
const file = fs.createWriteStream(dest);

https.get(url, (response) => {
  if (response.statusCode === 200) {
    response.pipe(file);
    file.on('finish', () => {
      file.close(() => {
        console.log(`Successfully downloaded error image to: ${dest}`);
        console.log(`File size: ${fs.statSync(dest).size} bytes`);
      });
    });
  } else {
    console.error(`Failed to download image. Status code: ${response.statusCode}`);
  }
}).on('error', (err) => {
  fs.unlink(dest, () => {});
  console.error(`Error: ${err.message}`);
});
