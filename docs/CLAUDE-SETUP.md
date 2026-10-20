# HomeCircle setup: instructions for Claude

> **For people:** you don't need to read this file. Open Claude (Claude Code
> works best, because it can run the commands for you) and paste:
>
> ```
> Read https://raw.githubusercontent.com/vanhornway/HomeCircle/main/docs/CLAUDE-SETUP.md and follow it to set up HomeCircle for my family.
> ```

---

## Your job

You are helping someone set up **HomeCircle**, a private, end-to-end encrypted
family location sharing and chat app that runs on a server they own. By the
end, they should have:

1. A running HomeCircle server with a public `https://` address.
2. That address and the server's one-time **setup code**.
3. The Android app installed on their phone, and their family circle created.
4. Clear instructions for inviting family members.

Assume the person is **not technical**. Use plain words, one step at a time,
and check each step worked before moving on. Prefer doing things yourself
(running commands) over asking them to, when you have a terminal.

The full human guide, if you need more detail, is
<https://github.com/vanhornway/HomeCircle/blob/main/docs/SETUP.md>. Hosting
details are in
<https://github.com/vanhornway/HomeCircle/blob/main/deploy/README.md>.

## Ground rules

- **Never ask for or type passwords, card numbers or account recovery codes.**
  When an account login or payment is needed (Render, DigitalOcean, Hetzner,
  Tailscale, Cloudflare), tell the person to do that part themselves in their
  browser, then continue.
- **Ask before anything that costs money**, changes their router, or installs
  software on a computer. Say what it is and why.
- The **setup code** and **invite links** are private. Show them to the person,
  but never put them in a URL, a public place, or a file that will be shared.
- If you have a terminal, check what you're working with first (OS, whether
  Docker is installed, whether you're on the target machine) instead of
  guessing.
- If you don't have a terminal (for example in a chat app), give the person
  each command in its own code block, ask them to run it and paste back the
  output, and check the output before moving on.

## Step 1. Choose where the server runs

Ask the person which fits them best. Give a recommendation based on their
answers (how comfortable they are, budget, whether they have a computer that
stays on).

| Option | Cost | Effort | Choose when |
|---|---|---|---|
| **A. Render** | ~$7/month | Clicks only | They want the simplest thing and don't mind paying. **Default recommendation.** |
| **B. Raspberry Pi or Linux box at home** | Free | One command | They have a Pi or Linux machine that's always on and want data at home. |
| **C. Cloud server (DigitalOcean / Hetzner)** | ~$4–6/month | Paste a config | They want their own server and are OK with a little more setup. |
| **D. This computer (Mac / Windows / Linux) with Docker** | Free | A few commands | Testing, or a desktop that's always on and never sleeps. |

The server must stay on 24/7 and be reachable from the internet over HTTPS.
A laptop that sleeps or travels is a poor choice except for trying it out.

## Step 2. Set up the server

### A. Render

The person does this in their browser. Walk them through it:

1. Sign up or log in at <https://render.com> and add a payment method.
2. Open <https://render.com/deploy?repo=https://github.com/vanhornway/HomeCircle>.
3. Enter a service name (suggest something like `smith-family`), then click **Apply**.
4. Wait for the deploy to show **Live** (about 5 minutes).
5. **Server address:** the `https://…onrender.com` URL at the top of the service page.
6. **Setup code:** service → **Environment** → `SETUP_TOKEN` → reveal.

Ask them to paste the server address to you (not the setup code), then verify
it (Step 3).

### B. Raspberry Pi or Linux machine at home

Requirements: 64-bit Raspberry Pi OS or Ubuntu/Debian, always on, internet access.

Tailscale Funnel is the recommended way to make it reachable: free, no router
changes, and family phones don't need Tailscale.

1. Get a terminal on that machine. If you're running there, use it directly.
   If you're on another computer, the person can SSH in (`ssh pi@<pi-address>`);
   they type any password themselves.
2. Run:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/vanhornway/HomeCircle/main/deploy/install.sh | sudo bash -s -- --mode tailscale
   ```
   This installs Docker and Tailscale if needed, then builds and starts
   HomeCircle. On a Pi, the first build can take 5–10 minutes.
3. When it prints a Tailscale login link, the person opens it and signs in. If
   Tailscale asks them to enable **Funnel** for their tailnet, they should approve it.
4. At the end it prints the **Server address** (`https://<name>.<tailnet>.ts.net`)
   and **Setup code**. Read them again any time with:
   ```bash
   sudo cat /opt/homecircle/SETUP-INFO.txt
   ```

Other ways to expose a home server: Cloudflare Tunnel (`--mode cloudflare`, needs a
domain on Cloudflare) or port forwarding (`--mode public --domain …`, needs router
changes). See deploy/README.md. Only use these if the person asks or Tailscale
won't work.

### C. Cloud server (DigitalOcean or Hetzner)

1. The person creates an **Ubuntu 24.04** server (smallest size) in their
   provider's web console.
2. Before creating it, they paste the contents of
   <https://raw.githubusercontent.com/vanhornway/HomeCircle/main/deploy/cloud-init.yaml>
   into **Advanced options → Add initialization scripts** (DigitalOcean) or
   **Cloud config** (Hetzner).
3. After about 3 minutes, connect with `ssh root@<server-ip>`. The address and
   setup code are shown at login, or run `cat /opt/homecircle/SETUP-INFO.txt`.
   The address is `https://<ip-with-dashes>.sslip.io` unless they set up a domain.

If they already have a Linux server, skip cloud-init and run the installer on it:
```bash
curl -fsSL https://raw.githubusercontent.com/vanhornway/HomeCircle/main/deploy/install.sh | sudo bash
```
(Ports 80 and 443 must be open to the internet.)

### D. This computer, with Docker

1. Check Docker: `docker version`. If it's missing, ask before installing
   Docker Desktop (Mac/Windows, <https://www.docker.com/products/docker-desktop/>)
   or Docker Engine (Linux, `curl -fsSL https://get.docker.com | sudo sh`), and
   make sure it's running.
2. Create a folder and start the server:
   ```bash
   mkdir -p ~/homecircle && cd ~/homecircle
   curl -fsSLO https://github.com/vanhornway/HomeCircle/releases/latest/download/docker-compose.yml
   docker compose up -d
   ```
3. Read the setup code from the log line `one-time setup code:`:
   ```bash
   docker logs homecircle
   ```
   Without `SETUP_TOKEN` set, this code changes every time the container
   restarts, until the circle is created. To make it stable, uncomment
   `SETUP_TOKEN` in `docker-compose.yml`, set a random value of 12+ characters,
   and run `docker compose up -d` again.
4. Make it reachable over HTTPS with Tailscale Funnel:
   - Ask before installing Tailscale (<https://tailscale.com/download>). The
     person signs in themselves.
   - Run `tailscale funnel --bg 8080`. If it says Funnel isn't enabled, it
     prints a link for the person to approve, then run it again.
   - `tailscale funnel status` shows the **Server address** (`https://….ts.net`).
5. Remind them this computer must stay on and not sleep, or the family's
   locations stop updating.

For a quick throwaway test only, `cloudflared tunnel --url http://localhost:8080`
gives a temporary `https://….trycloudflare.com` address, which changes every
time it runs. Don't use that for real family use.

## Step 3. Verify the server

With the server address (call it `$URL`, no trailing slash):

```bash
curl -s $URL/api/v1/info
```

Expected: JSON containing `"app":"homecircle"` and `"setup":false`. If you
can't run commands, have the person open `$URL` in their phone's browser; they
should see the HomeCircle web page.

| Result | Meaning / fix |
|---|---|
| `"setup":false` | Ready. Continue. |
| `"setup":true` | A circle already exists on this server. The setup code won't work again; the person should join with an invite from the existing admin, or start fresh with a new server. |
| Timeout / connection refused | Server not running or not exposed. Check `docker ps`, `docker logs homecircle`, `tailscale funnel status`, or the Render deploy log. |
| 502 / 503 | Server still starting, or the tunnel can't reach port 8080. Wait a minute and retry, then check the container is running. |
| Certificate error | The HTTPS certificate isn't issued yet (public mode needs ports 80/443 open and DNS pointing at the server). Wait a few minutes, then check firewall/DNS. |

## Step 4. Install the Android app

Tell the person to do this on their Android phone:

1. Open <https://github.com/vanhornway/HomeCircle/releases/latest/download/HomeCircle.apk>.
2. Tap **Download** (and **Download anyway** if Chrome warns).
3. Open the file. If asked, allow Chrome to **install unknown apps**, go back, then tap **Install**.
4. If Google Play Protect says the app is unrecognized: **More details → Install anyway**.

If you have a terminal and the phone is connected by USB with USB debugging on,
you can install it for them instead:
```bash
curl -fsSL -o HomeCircle.apk https://github.com/vanhornway/HomeCircle/releases/latest/download/HomeCircle.apk
adb install -r HomeCircle.apk
```

**iPhone:** there's no iPhone app download yet. iPhone users can open the
server address in Safari for the map and chat, but they only share location
while that page is open. Tell them this plainly.

## Step 5. Create the circle

Guide the person through the app:

1. Open HomeCircle → **Set up a new server**.
2. **Server address:** from Step 2. **Setup code:** from Step 2. **Circle name:**
   e.g. *The Smiths*. **Your name:** what the family calls them.
3. Tap **Create my circle**.
4. When asked for location, choose **While using the app**, then **Allow all the
   time**. Allow notifications.
5. Recommend: Android Settings → **Apps → HomeCircle → Battery → Unrestricted**,
   so updates keep working in the background.

Confirm by running `curl -s $URL/api/v1/info` again: it should now show
`"setup":true`.

## Step 6. Invite the family

Tell the person:

- In the app: **Settings → Invite** shows a QR code and link.
- Each invite works for **one person** and expires after a few days. Make a new
  one for each family member.
- The family member installs the app (Step 4), taps **Join my family**, then
  scans the QR code or pastes the link, enters their name, ticks the box
  agreeing that the circle can see and request their location, and allows
  location and notifications.
- The invite link contains part of the family's encryption key. Send it only to
  the person it's for (a private text is fine). Don't post it anywhere public.

### More than one group

If the person wants separate groups (for example their household, and their
parents and siblings), tell them they don't need another server. One server
holds any number of isolated circles. After creating the first circle, they
tap the circle name at the top of the Map (or **Settings → Your circles**), then
**New circle**, and invite people to it. Only the person who set up the server
can create circles. Each circle has its own members, chat, map and encryption
key.

## Step 7. Wrap up

Give the person a short summary to keep. Tell them to save it somewhere
private, because it includes the server details:

- Their server address, and where it runs (Render / Pi / cloud / this computer).
- How to see the server's status:
  - Render: the dashboard.
  - Pi or cloud: `sudo cat /opt/homecircle/SETUP-INFO.txt`.
  - Docker: `docker ps`.
- How to update the server:
  - Render: updates automatically.
  - Pi or cloud: `sudo bash /opt/homecircle/src/deploy/install.sh` with the same `--mode`.
  - Docker: `docker compose pull && docker compose up -d` in `~/homecircle`.
- How to update the app: download the APK from the same link and install it
  over the old one; the circle is kept.
- Backups: the data lives in `/data/homecircle.db` inside the container
  (Docker volume `homecircle-data`). It's all encrypted. If it's lost, everyone
  re-joins with new invites.

Things to mention honestly:

- This is a test version. Notifications for messages and **Locate** reach a
  phone reliably while the app is open or recently used; delivery to a fully
  closed app needs push setup that's still being added.
- Don't promise features that aren't listed here.
