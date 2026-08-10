FROM node:20-slim

# Install wget, gnupg, and Chrome dependencies
RUN apt-get update && apt-get install -y \
    tini \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    --no-install-recommends

# Add official Google Chrome repository and install Google Chrome Stable
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use Google Chrome Stable
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

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

# Run as PID 1 via tini instead of node directly - Puppeteer/Chrome spawns several child
# processes (zygote, GPU, renderers), and when one gets killed abruptly (e.g. by this app's
# own zombie-cleanup pkill/kill -9 in syncWorker.js) an orphan can get reparented to PID 1.
# Node only reaps processes it spawned itself, not arbitrary reparented orphans, so those
# became permanent zombies that no kill -9 can remove - they piled up until the container's
# process table filled up ("fork: retry: Resource temporarily unavailable"). tini reaps any
# orphan regardless of what killed its original parent.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
