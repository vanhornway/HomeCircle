# Hosting your HomeCircle server

Every option runs the same Docker image and needs **persistent storage** (a
disk or volume at `/data`). Your circle's data is end-to-end encrypted, so the
hosting company only ever stores ciphertext.

The deploy buttons and installers pull from the public GitHub repo
`vanhornway/HomeCircle`. If you fork it, change the repo in `render.yaml`,
`deploy/install.sh`, `deploy/cloud-init.yaml` and `landing/config.js`.

| Option | Effort | Rough cost* | Good for |
|---|---|---|---|
| [Render](#render) | 1 click | ~$7/mo | easiest managed hosting |
| [Railway](#railway) | 1 click (after you publish a template) | ~$5/mo | easiest managed hosting |
| [Fly.io](#flyio) | 4 commands | ~$3/mo | cheap managed hosting |
| [DigitalOcean](#digitalocean--hetzner) | paste a config | ~$4–6/mo | your own VPS |
| [Hetzner](#digitalocean--hetzner) | paste a config | ~€4/mo | cheapest VPS, EU |
| [Raspberry Pi](#raspberry-pi--home-server) | 1 command | hardware only | data never leaves your home |

\*Check current pricing with each provider; free tiers that sleep or lack disks won't work.

After deploying, open the HomeCircle app → **Set up a new server**, then enter
your server address and the **setup code**. The setup code works once, to create
your circle.

---

## Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/vanhornway/HomeCircle)

`render.yaml` creates a Docker web service on the Starter plan with a 1 GB disk
and a randomly generated `SETUP_TOKEN`.

- **Address:** `https://homecircle-xxxx.onrender.com` (shown on the service page)
- **Setup code:** service → Environment → `SETUP_TOKEN` → reveal

## Railway

Railway deploys from `railway.json`. Volumes are added in the template:

1. In Railway: **New Project → Deploy from GitHub repo** → pick your fork.
2. Service → **Settings → Volumes → Add volume**, mount path `/data`.
3. Service → **Variables**: `SETUP_TOKEN` = `${{secret(24)}}`, `TRUST_PROXY` = `true`.
4. Service → **Settings → Networking → Generate domain**.
5. (Optional) **Project → Settings → Create template** to get your own
   one-click `https://railway.com/template/…` link. Put it in `landing/config.js`.

- **Setup code:** service → Variables → `SETUP_TOKEN`

## Fly.io

```bash
fly launch --copy-config --no-deploy --name my-family-homecircle
fly volumes create homecircle_data --size 1
fly secrets set SETUP_TOKEN=$(openssl rand -base64 18)
fly deploy
```

`fly.toml` keeps one machine always running: phones upload in the background
and "Locate" requests must reach the server at any time.

- **Address:** `https://my-family-homecircle.fly.dev`
- **Setup code:** the value you set. Run `fly secrets set` again to change it before setup.

## DigitalOcean / Hetzner

1. Create a server with **Ubuntu 24.04**. The smallest size is plenty.
   - DigitalOcean: Create → Droplets → *Advanced options → Add initialization scripts*
   - Hetzner Cloud: Add server → *Cloud config*
2. Paste [`cloud-init.yaml`](cloud-init.yaml).
3. Wait ~3 minutes, then `ssh root@<server-ip>`. The address and setup code
   are printed at login. They're also in `/opt/homecircle/SETUP-INFO.txt`.

Without a domain, the installer uses `<your-ip>.sslip.io` (free wildcard DNS)
and gets a real HTTPS certificate from Let's Encrypt. To use your own domain,
point an A record at the server and re-run:

```bash
sudo bash /opt/homecircle/src/deploy/install.sh --mode public --domain family.example.com
```

Already have a Linux server? Run the installer directly:

```bash
curl -fsSL https://raw.githubusercontent.com/vanhornway/HomeCircle/main/deploy/install.sh | sudo bash
```

## Raspberry Pi / home server

Use a Pi 3B+ or newer with **64-bit Raspberry Pi OS Lite**. Phones need to reach
your server from anywhere, not just home Wi‑Fi, so pick one way to expose it:

**A. Tailscale Funnel (recommended, no router changes, free)**

```bash
curl -fsSL https://raw.githubusercontent.com/vanhornway/HomeCircle/main/deploy/install.sh | sudo bash -s -- --mode tailscale
```

You'll get a stable public address like `https://homecircle.tail1234.ts.net`.
Enable Funnel for your tailnet when Tailscale prompts you. Phones don't need
Tailscale installed.

**B. Cloudflare Tunnel (no open ports, needs a domain on Cloudflare)**

Create a tunnel in Cloudflare Zero Trust (Networks → Tunnels). Add a public
hostname (e.g. `family.example.com`) pointing to `http://homecircle:8080`, then:

```bash
sudo bash install.sh --mode cloudflare --domain family.example.com --cloudflare-token <token>
```

**C. Port forwarding**

Forward TCP 80 and 443 on your router to the Pi. Point a dynamic DNS name
(e.g. DuckDNS) at your home IP, then run `install.sh --mode public --domain you.duckdns.org`.

With A and B, the tunnel provider terminates TLS. Your circle's data is still
end-to-end encrypted, so they only see ciphertext and timing. With C, TLS ends
on your Pi.

## Configuration

| Variable | Default | |
|---|---|---|
| `SETUP_TOKEN` | random, printed in logs | one-time code to create the first circle (more circles are created in the app) |
| `DATA_DIR` | `/data` | SQLite database location |
| `PORT` | `8080` | |
| `TRUST_PROXY` | `false` | set `true` behind a proxy (all options above do) |
| `MESSAGE_RETENTION_DAYS` | `365` | longest any circle may keep messages (each circle's admin picks 1 day to 1 year); can't exceed 365 |
| `LOCATION_REQUEST_COOLDOWN_SECONDS` | `60` | how often one person can tap "Locate" |
| `PUSH_PROVIDER` | `expo` | `none` disables push (locate requests then only reach open apps) |
| `TILE_URL` / `TILE_ATTRIBUTION` | OpenStreetMap | map tiles the apps load |
| `WEB_CLIENT` | `true` | serve the browser version at `/` |

## Backups and updates

- **Backup:** copy `/data/homecircle.db` (it's all ciphertext). Losing it means
  everyone has to re-join, but no one's keys are exposed.
- **Update:** redeploy (Render/Railway/Fly), or re-run `install.sh` on a VPS or Pi.
  Your circles, keys and messages are kept, and any database changes apply
  themselves when the new version starts.
- **Order:** update the server **before** people install a newer app. Older
  apps keep working with a newer server, but a newer app may use features an
  older server doesn't have yet.

### Updating on Render

The blueprint has `autoDeploy: false`, so Render only updates when you ask:

1. Check the version you're on: open `https://<your-service>.onrender.com/api/v1/info`
   and look at `"version"`.
2. Optional safety net: Render keeps daily snapshots of the disk (service →
   **Disks**). Make sure a recent one exists, especially when jumping several
   versions.
3. Dashboard → your **homecircle** service → **Manual Deploy** → **Deploy latest commit**.
4. Wait until the deploy shows **Live** (2–4 minutes). Phones show
   "Can't reach your server" for about a minute, then reconnect by themselves.
5. Open `/api/v1/info` again and check that `"version"` changed.

If the deploy fails, Render keeps the previous version running; open the
deploy's logs to see why. To go back to an earlier version, use **Rollback**
on an earlier deploy (your data stays on the disk).
