ARG BUILD_FROM=ghcr.io/vanhornway/homecircle:latest
FROM ${BUILD_FROM}

# The regular HomeCircle image has the bridge (server/src/ha-bridge.js) and
# the client it uses (packages/core); it runs instead of the server.
ENTRYPOINT ["/sbin/tini", "--", "node", "--disable-warning=ExperimentalWarning", "/app/server/src/ha-bridge.js"]
CMD []
