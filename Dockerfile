FROM node:20-bullseye-slim
 
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-sandbox \
    fonts-freefont-ttf \
    fonts-liberation \
    ca-certificates \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
 
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true \
    npm_config_puppeteer_skip_chromium_download=true
 
WORKDIR /app
 
COPY package*.json ./
RUN npm install --ignore-scripts
 
COPY src/ ./src/
 
RUN ls -la /app/src/
 
EXPOSE 3001
 
CMD ["node", "src/index.js"]
 