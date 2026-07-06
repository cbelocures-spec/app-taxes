FROM node:20-slim

# Install Chromium and required system deps for headless operation
RUN apt-get update && apt-get install -y \
    chromium \
    dbus \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-khmeros \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the installed Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Prevent Chrome from trying to connect to DBus (not available in containers)
ENV DBUS_SESSION_BUS_ADDRESS=/dev/null
ENV DBUS_SYSTEM_BUS_ADDRESS=/dev/null

# Create app directory
WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install dependencies (skip Chromium download since we installed it above)
RUN npm ci --omit=dev

# Copy the rest of the application
COPY . .

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
