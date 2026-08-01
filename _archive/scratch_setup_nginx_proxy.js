const { Client } = require('ssh2');

const NGINX_CONF = `server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name _;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
`;

const conn = new Client();
conn.on('ready', () => {
  console.log("Connected to 192.168.50.4 via SSH");
  conn.exec(`echo CesarHernan3550 | sudo -S bash -c "apt-get update && apt-get install -y nginx && cat << 'EOF' > /etc/nginx/sites-available/app-taxes
${NGINX_CONF}
EOF
ln -sf /etc/nginx/sites-available/app-taxes /etc/nginx/sites-enabled/default
systemctl restart nginx"`, (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      console.log("=== NGINX SETUP OUTPUT ===");
      console.log(out);
      conn.end();
    });
  });
}).connect({
  host: '192.168.50.4',
  port: 22,
  username: 'cbelocures',
  password: 'CesarHernan3550'
});
