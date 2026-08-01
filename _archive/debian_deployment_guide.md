# Guía de Instalación en Debian (vía VPN) y Configuración de Apache

Esta guía detalla los pasos para instalar la aplicación en un servidor Debian privado y configurar Apache como proxy inverso para acceder de manera segura a través de una VPN.

El archivo comprimido con la base del código depurado está ubicado en:
[app_taxes.zip](file:///C:/Users/admin/.gemini/antigravity/brain/fb0b4124-405f-4d4d-a43f-448a7f7ea391/app_taxes.zip)

---

## 1. Requisitos Previos e Instalación de Dependencias

Ejecuta los siguientes comandos en tu servidor Debian para instalar Node.js, npm, Chromium y las librerías necesarias para Puppeteer:

```bash
# Actualizar el sistema
sudo apt update && sudo apt upgrade -y

# Instalar Node.js (versión 18 o 20) y npm
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Instalar Chromium y dependencias de renderizado requeridas por Puppeteer
sudo apt install -y chromium libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2
```

---

## 2. Despliegue de la Aplicación

1. Crea el directorio de la aplicación en el servidor (por ejemplo, `/var/www/app-taxes`):
   ```bash
   sudo mkdir -p /var/www/app-taxes
   sudo chown -R $USER:$USER /var/www/app-taxes
   ```
2. Descomprime el archivo `app_taxes.zip` en ese directorio.
3. Desde el directorio de la aplicación, instala las dependencias de Node.js:
   ```bash
   cd /var/www/app-taxes
   npm install --omit=dev
   ```

---

## 3. Configuración del Servicio de Systemd

Para asegurar que la aplicación corra de fondo y se reinicie sola si el servidor se apaga, crearemos un servicio de systemd:

1. Crea el archivo del servicio:
   ```bash
   sudo nano /etc/systemd/system/app-taxes.service
   ```
2. Pega la siguiente configuración (ajusta el usuario si es diferente de `admin`):
   ```ini
   [Unit]
   Description=Servidor Express de Gestión de Mantenimiento (Taxes)
   After=network.target

   [Service]
   Type=simple
   User=admin
   WorkingDirectory=/var/www/app-taxes
   # Definimos el puerto y la ruta de Chromium para Puppeteer en Debian
   Environment=PORT=3000
   Environment=PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
   ExecStart=/usr/bin/node server.js
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```
3. Guarda el archivo, recarga systemd e inicia el servicio:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable app-taxes.service
   sudo systemctl start app-taxes.service
   ```
4. Para ver que esté corriendo correctamente:
   ```bash
   sudo systemctl status app-taxes.service
   ```

---

## 4. Configuración de Apache como Proxy Inverso (VPN)

Para acceder a la aplicación mediante el puerto estándar HTTP (80) a través de tu red VPN, utilizaremos Apache como proxy inverso redirigiendo el tráfico al puerto `3000` de la aplicación Node.

1. Instala Apache y activa los módulos necesarios:
   ```bash
   sudo apt install -y apache2
   sudo a2enmod proxy proxy_http rewrite headers
   ```
2. Crea el archivo de configuración del sitio:
   ```bash
   sudo nano /etc/apache2/sites-available/app-taxes.conf
   ```
3. Pega la siguiente configuración de VirtualHost. 
   > [!NOTE]
   > En `ServerName` puedes colocar la IP privada del servidor dentro de tu red VPN (por ejemplo, `10.8.0.5` o un nombre de dominio local).
   
   ```apache
   <VirtualHost *:80>
       ServerName 10.8.0.5
       ServerAdmin webmaster@localhost

       # Redirección de logs
       ErrorLog ${APACHE_LOG_DIR}/app-taxes_error.log
       CustomLog ${APACHE_LOG_DIR}/app-taxes_access.log combined

       # Configuración del proxy inverso
       ProxyPreserveHost On
       ProxyRequests Off

       # Pasar todas las peticiones a la aplicación Node en el puerto 3000
       ProxyPass / http://127.0.0.1:3000/
       ProxyPassReverse / http://127.0.0.1:3000/

       # Seguridad básica adicional para accesos dentro de la VPN
       <Proxy *>
           Require all granted
       </Proxy>

       # Evitar la caché agresiva del navegador para asegurar que las órdenes carguen siempre en vivo
       <FilesMatch "\.(html|htm|js|css|json)$">
           FileETag None
           <IfModule mod_headers.c>
               Header unset ETag
               Header set Cache-Control "max-age=0, no-cache, no-store, must-revalidate"
               Header set Pragma "no-cache"
               Header set Expires "Wed, 11 Jan 1984 05:00:00 GMT"
           </IfModule>
       </FilesMatch>
   </VirtualHost>
   ```
4. Habilita el nuevo sitio y deshabilita el por defecto si no lo usas:
   ```bash
   sudo a2ensite app-taxes.conf
   sudo a2dissite 000-default.conf
   ```
5. Prueba la sintaxis de Apache y reinicia el servicio:
   ```bash
   sudo apache2ctl configtest
   sudo systemctl restart apache2
   ```

¡Listo! A partir de ahora, cuando estés conectado a tu VPN, podrás entrar al sistema directamente escribiendo la IP privada del servidor Debian en el navegador. Las solicitudes se enviarán a Apache y este las redirigirá a Node.js de forma transparente.
