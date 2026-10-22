ARG BUILD_FROM=ghcr.io/vanhornway/homecircle:latest
FROM ${BUILD_FROM}

# Tailscale gives HomeCircle a public https:// address (Funnel) without
# opening ports on your router. jq reads the add-on options.
RUN apk add --no-cache tailscale jq

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/sbin/tini", "--", "/run.sh"]
CMD []
