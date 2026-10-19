#!/usr/bin/env bash
# HomeCircle installer for a Linux VPS (DigitalOcean, Hetzner, …) or a
# Raspberry Pi (64-bit Raspberry Pi OS recommended).
#
#   curl -fsSL https://raw.githubusercontent.com/vanhornway/HomeCircle/main/deploy/install.sh | sudo bash
#
# Options (env vars or flags):
#   --mode public|tailscale|cloudflare|local   how phones reach the server (default: public)
#   --domain example.com                       your domain (public mode; default <ip>.sslip.io)
#   --cloudflare-token TOKEN                   tunnel token (cloudflare mode)
set -euo pipefail

REPO="${HOMECIRCLE_REPO:-https://github.com/vanhornway/HomeCircle.git}"
BRANCH="${HOMECIRCLE_BRANCH:-main}"
DIR="${HOMECIRCLE_DIR:-/opt/homecircle}"
MODE="${HOMECIRCLE_MODE:-public}"
DOMAIN="${HOMECIRCLE_DOMAIN:-}"
CF_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --cloudflare-token) CF_TOKEN="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Run as root (sudo)."
case "$MODE" in public|tailscale|cloudflare|local) ;; *) die "--mode must be public, tailscale, cloudflare or local" ;; esac

if ! command -v git >/dev/null 2>&1; then
  say "Installing git"
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq git curl; else die "Install git first."; fi
fi
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker (official get.docker.com script)"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."

say "Fetching HomeCircle into $DIR/src"
mkdir -p "$DIR"
if [ -d "$DIR/src/.git" ]; then
  git -C "$DIR/src" fetch -q origin "$BRANCH" && git -C "$DIR/src" reset -q --hard "origin/$BRANCH"
else
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$DIR/src"
fi

ENV_FILE="$DIR/.env"
touch "$ENV_FILE" && chmod 600 "$ENV_FILE"
get_env() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
set_env() { grep -v -E "^$1=" "$ENV_FILE" > "$ENV_FILE.tmp" || true; echo "$1=$2" >> "$ENV_FILE.tmp"; mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"; }

SETUP_TOKEN="$(get_env SETUP_TOKEN)"
if [ -z "$SETUP_TOKEN" ]; then
  SETUP_TOKEN="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
  set_env SETUP_TOKEN "$SETUP_TOKEN"
fi

PROFILE=""
case "$MODE" in
  public)
    if [ -z "$DOMAIN" ]; then
      IP="$(curl -fsS4 https://api.ipify.org || true)"
      [ -n "$IP" ] || die "Couldn't detect this server's public IP. Pass --domain."
      DOMAIN="${IP//./-}.sslip.io"
      say "No domain given — using $DOMAIN (free wildcard DNS for your IP)"
    fi
    PROFILE="--profile public"
    ;;
  tailscale)
    if ! command -v tailscale >/dev/null 2>&1; then
      say "Installing Tailscale"
      curl -fsSL https://tailscale.com/install.sh | sh
    fi
    tailscale status >/dev/null 2>&1 || { say "Log in to Tailscale (open the link below)"; tailscale up; }
    DOMAIN="$(tailscale status --json --peers=false | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)"
    [ -n "$DOMAIN" ] || die "Couldn't read this device's Tailscale name."
    ;;
  cloudflare)
    [ -n "$CF_TOKEN" ] || die "--cloudflare-token is required (Zero Trust → Networks → Tunnels → create tunnel)."
    [ -n "$DOMAIN" ] || die "--domain is required: the public hostname you routed to http://homecircle:8080 in the tunnel."
    set_env CLOUDFLARE_TUNNEL_TOKEN "$CF_TOKEN"
    PROFILE="--profile cloudflare"
    ;;
  local)
    DOMAIN="${DOMAIN:-localhost}"
    ;;
esac
set_env DOMAIN "$DOMAIN"

say "Building and starting HomeCircle (first build on a Pi takes a few minutes)"
cd "$DIR/src"
# shellcheck disable=SC2086
docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.yml $PROFILE up -d --build

if [ "$MODE" = "tailscale" ]; then
  say "Publishing via Tailscale Funnel"
  tailscale funnel --bg 8080
fi

ADDRESS="https://$DOMAIN"
[ "$MODE" = "local" ] && ADDRESS="http://<this-machine's-LAN-IP>:8080 (local testing only)"
cat > "$DIR/SETUP-INFO.txt" <<INFO
HomeCircle is running.

  Server address: $ADDRESS
  Setup code:     $SETUP_TOKEN

Open the HomeCircle app → "Set up a new server" and enter both.
The setup code only works once, to create your circle.
INFO
chmod 600 "$DIR/SETUP-INFO.txt"
if [ -d /etc/update-motd.d ] && [ ! -f /etc/update-motd.d/99-homecircle ]; then
  printf '#!/bin/sh\n[ -r %s ] && cat %s\n' "$DIR/SETUP-INFO.txt" "$DIR/SETUP-INFO.txt" > /etc/update-motd.d/99-homecircle
  chmod +x /etc/update-motd.d/99-homecircle
fi

echo
cat "$DIR/SETUP-INFO.txt"
echo
say "Update later with: sudo bash $DIR/src/deploy/install.sh --mode $MODE${DOMAIN:+ --domain $DOMAIN}"
