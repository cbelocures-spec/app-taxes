const { Client } = require('ssh2');

const CONF = `server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name _;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
`;

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return conn.end();
    sftp.writeFile('/tmp/app-taxes.nginx', CONF, (err2) => {
      if (err2) return conn.end();
      conn.exec("echo CesarHernan3550 | sudo -S cp /tmp/app-taxes.nginx /etc/nginx/sites-available/app-taxes && sudo ln -sf /etc/nginx/sites-available/app-taxes /etc/nginx/sites-enabled/default && sudo nginx -t && sudo systemctl restart nginx", (err3, stream) => {
        let out = '';
        stream.on('data', d => out += d);
        stream.on('close', () => {
          console.log("=== NGINX RESTART RESULT ===");
          console.log(out);
          conn.end();
        });
      });
    });
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
});
