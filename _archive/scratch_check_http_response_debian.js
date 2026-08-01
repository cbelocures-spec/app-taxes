const http = require('http');

http.get('http://192.168.50.4/app.js', res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    console.log("=== HTTP GET 192.168.50.4/app.js STATUS:", res.statusCode, "===");
    console.log("Content Length:", body.length);
    console.log("Has x-user-username in app.js?", body.includes('x-user-username'));
    console.log("Has auto-create rodado in app.js?", body.includes('Auto-create & select option for Rodado'));
  });
}).on('error', e => console.error("Error:", e.message));
