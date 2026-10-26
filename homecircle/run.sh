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
# The Home Assistant plugin offers this Home Assistant's own address.
export HOMECIRCLE_ADDON=true
[ -n "$SETUP_CODE" ] && export SETUP_TOKEN="$SETUP_CODE"
# The circle agent (optional AI helper): runs inside the server when on.
[ "$(opt run_agent)" = "true" ] && export AGENT=true
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

# Optional load-test server: a second, separate HomeCircle on port 8081 for
# stress tests (server/scripts/swarm.mjs). Same hardware, so CPU and memory
# are real, but its own data, so simulated people never touch your circles.
# No push notifications (a swarm would flood your phone), and it trusts
# X-Forwarded-For so each simulated person counts as its own IP for rate
# limits, like real phones.
LT_ON="$(opt load_test_server)"
LT_DIR=/data/homecircle-loadtest
if [ "$LT_ON" = "true" ]; then
  LT_CODE="$(opt load_test_setup_code)"
  if [ "$(opt load_test_reset)" = "true" ]; then
    rm -rf "$LT_DIR"
    say "Load test: deleted the load-test server's data. Turn load_test_reset off again."
  fi
  mkdir -p "$LT_DIR"
  chown -R node:node "$LT_DIR"
  if [ -n "$LT_CODE" ] && [ "${#LT_CODE}" -lt 12 ]; then
    say "Load test: load_test_setup_code must be 12+ characters; using a random code instead."
    LT_CODE=""
  fi
  (
    cd /app
    # Invite links come from the address the swarm uses, not the family URL.
    unset PUBLIC_URL
    # LOAD_TEST=1: the server says it's for load tests (the swarm refuses any
    # other) and its web page shows a banner. It runs at low CPU priority with
    # a memory cap, so a swarm can't slow down or starve the family's server
    # on the same machine.
    export DATA_DIR="$LT_DIR" PORT=8081 PUSH_PROVIDER=none TRUST_PROXY=true SETUP_TOKEN="$LT_CODE" LOAD_TEST=1
    while true; do
      nice -n 15 su-exec node node --max-old-space-size=384 --disable-warning=ExperimentalWarning server/src/index.js 2>&1 |
        while IFS= read -r l; do echo "[load-test] $l"; done
      echo "[load-test] server stopped; restarting in 5 s"
      sleep 5
    done
  ) &
  line
  say "Load-test server is ON (separate data, no push notifications):"
  say "  on your home network:  http://<your-home-assistant-ip>:8081"
  if [ -n "${DNS:-}" ]; then
    if $TS funnel --bg --https=8443 http://127.0.0.1:8081 >/tmp/funnel-loadtest.log 2>&1; then
      say "  from anywhere:         https://$DNS:8443"
    else
      say "  (couldn't publish it on https://$DNS:8443:)"
      cat /tmp/funnel-loadtest.log
    fi
  fi
  say "Its setup code is printed below with the [load-test] prefix."
  line
elif [ -n "${DNS:-}" ]; then
  # Load test switched off: stop publishing its old address, if any.
  $TS funnel --https=8443 off >/dev/null 2>&1 || true
fi

cd /app
exec su-exec node node --disable-warning=ExperimentalWarning server/src/index.js
