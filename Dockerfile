FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 libxss1 libatk1.0-0 libatk-bridge2.0-0 libdrm2 libgbm1 \
    libasound2 libxshmfence1 libx11-xcb1 libxcomposite1 libxdamage1 \
    libxrandr2 libxrender1 libxfixes3 libxi6 libgtk-3-0 \
    ca-certificates fonts-liberation wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true \
    NODE_ENV=production \
    PORT=3000

EXPOSE 3000

CMD ["node", "src/server.js"]
