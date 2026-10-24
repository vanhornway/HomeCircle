# HomeCircle server — one image for Render, Railway, Fly.io, DigitalOcean,
# Hetzner, any VPS, and Raspberry Pi (linux/amd64, linux/arm64, linux/arm/v7).
FROM node:22-alpine AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
RUN apk add --no-cache tini su-exec \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
# In /app so both server/src and packages/core/src (the agent uses it) find them.
COPY --from=deps /app/server/node_modules ./node_modules
COPY server/package.json server/docker-entrypoint.sh ./server/
COPY server/src ./server/src
COPY server/public ./server/public
COPY packages/core/src ./packages/core/src
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/app/server/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
