FROM ghcr.io/puppeteer/puppeteer:21.0.0

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_OPTIONS="--max-old-space-size=1024"

WORKDIR /app
COPY package.json ./
RUN npm install --no-cache
COPY server.js ./
EXPOSE 3000
CMD ["node", "server.js"]
