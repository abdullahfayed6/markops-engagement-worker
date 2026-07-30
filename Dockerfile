FROM mcr.microsoft.com/playwright:v1.62.0-noble

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11vnc x11-utils novnc websockify curl tini \
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

ENV NODE_ENV=production \
    DISPLAY=:99 \
    PROFILE_ROOT=/data/accounts
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3000}/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start-worker"]
