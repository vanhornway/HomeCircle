#!/bin/sh
# Hosting platforms (Render, Railway, Fly.io) mount volumes owned by root.
# Fix ownership once, then run the server as the unprivileged "node" user.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
