#!/bin/sh
# Starts Tailscale (if a key is set), publishes HomeCircle with Funnel, then
# runs the HomeCircle server. Everything is kept in /data, which Home
# Assistant includes in its backups.
set -u
OPTIONS=/data/options.json
opt() { jq -r --arg k "$1" '.[$k] // empty' "$OPTIONS" 2>/dev/null; }

TS_KEY="$(opt tailscale_auth_key)"
TS_HOST="$(opt tailscale_hostname)"
SETUP_CODE="$(opt setup_code)"
[ -n "$TS_HOST" ] || TS_HOST=homecircle

export DATA_DIR=/data/homecircle
export PORT=8080
export TRUST_PROXY=true
[ -n "$SETUP_CODE" ] && export SETUP_TOKEN="$SETUP_CODE"
mkdir -p "$DATA_DIR" /data/tailscale
chown -R node:node "$DATA_DIR"

say() { echo "[homecircle] $*"; }
line() { echo "──────────────────────────────────────────────────────────"; }

if [ -n "$TS_KEY" ] || [ -f /data/tailscale/tailscaled.state ]; then
  TS="tailscale --socket=/tmp/tailscaled.sock"
  tailscaled --tun=userspace-networking --statedir=/data/tailscale --socket=/tmp/tailscaled.sock >/tmp/tailscaled.log 2>&1 &
  for i in $(seq 1 30); do $TS status >/dev/null 2>&1 && break; [ -S /tmp/tailscaled.sock ] && $TS version >/dev/null 2>&1 && break; sleep 1; done
  if [ -n "$TS_KEY" ]; then
    $TS up --timeout=60s --authkey="$TS_KEY" --hostname="$TS_HOST" >/tmp/tailscale-up.log 2>&1 || { say "Tailscale login failed:"; cat /tmp/tailscale-up.log; }
  else
    $TS up --timeout=30s --hostname="$TS_HOST" >/tmp/tailscale-up.log 2>&1 || true
  fi
  DNS="$($TS status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')"
  if [ -n "$DNS" ]; then
    if $TS funnel --bg 8080 >/tmp/funnel.log 2>&1; then
      export PUBLIC_URL="https://$DNS"
      line; say "Phones can reach HomeCircle at:  https://$DNS"; line
    else
      line
      say "Tailscale is connected, but Funnel (the public https address) is off."
      say "Turn it on with the link below, then restart this add-on:"
      cat /tmp/funnel.log
      line
    fi
  else
    line; say "Tailscale didn't connect. Check the auth key in the add-on's Configuration tab."; cat /tmp/tailscale-up.log 2>/dev/null; line
  fi
else
  line
  say "No Tailscale auth key set. HomeCircle runs on your home network only:"
  say "  http://<your-home-assistant-ip>:8080"
  say "To use it away from home, add a Tailscale auth key in the Configuration tab."
  line
fi

cd /app
exec su-exec node node --disable-warning=ExperimentalWarning server/src/index.js
