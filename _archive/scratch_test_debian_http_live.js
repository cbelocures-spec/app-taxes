const http = require('http');

http.get('http://192.168.50.4/api/settings', (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    console.log("=== DEBIAN HTTP GET RESPONSE ===");
    console.log("Status:", res.statusCode);
    console.log("Body snippet:", data.substring(0, 200));
  });
}).on('error', (e) => {
  console.error("HTTP error:", e.message);
});
