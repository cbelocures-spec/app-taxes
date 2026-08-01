const https = require('https');

https.get('https://app-taxes-production-ec67.up.railway.app/api/settings', (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    try {
      const settings = JSON.parse(data);
      console.log("Railway Settings Username:", settings.username);
      console.log("Railway Settings Password length:", (settings.password || "").length);
      console.log("Railway Settings Password is masked?:", (settings.password || "").includes("••"));
    } catch(e) {
      console.log("Raw Railway response:", data);
    }
  });
});
