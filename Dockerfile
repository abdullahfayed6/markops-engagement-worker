FROM mcr.microsoft.com/playwright:v1.54.0-jammy

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev
COPY docker/start.sh /usr/local/bin/start-worker
RUN chmod +x /usr/local/bin/start-worker && mkdir -p /data/accounts

ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS -H "X-Worker-Secret: ${WORKER_SECRET}" http://127.0.0.1:${PORT:-3000}/health || exit 1
CMD ["/usr/local/bin/start-worker"]
