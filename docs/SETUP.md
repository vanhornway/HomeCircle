# Set up HomeCircle for your family

This guide takes you from nothing to a working family map and chat in about
20 minutes. One person (the "admin") does steps 1–4. Everyone else only does
step 5.

**Prefer to have Claude do it?** Open [Claude Code](https://claude.com/claude-code)
(or any Claude chat) and paste:

```
Read https://raw.githubusercontent.com/vanhornway/HomeCircle/main/docs/CLAUDE-SETUP.md and follow it to set up HomeCircle for my family.
```

Claude asks where you want to run the server, runs the commands it can, and
walks you through the rest.

**You'll need:**

- An Android phone for each person (iPhone: see [the note below](#iphone)).
- One of these to run your server: a hosting account (Render, about $7/month),
  a cheap cloud server (DigitalOcean or Hetzner, about $4–6/month), or a
  computer that stays on at home (Raspberry Pi, Mac, PC).

---

## Step 1. Run your server

Your server is where your family's encrypted data lives. Everything is
encrypted on the phones first, so the server (and whoever hosts it) can't read
locations or messages. Pick **one** option.

### Option A: Render (easiest, no command line)

1. Create an account at <https://render.com> and add a payment method.
2. Click this button: [Deploy to Render](https://render.com/deploy?repo=https://github.com/vanhornway/HomeCircle)
3. Give it a name (for example `smith-family`) and click **Apply**. Wait
   about 5 minutes for the first deploy to finish.
4. Write down two things:
   - **Server address:** shown at the top of the service page, like
     `https://smith-family-xxxx.onrender.com`.
   - **Setup code:** service → **Environment** → `SETUP_TOKEN` → click the eye
     icon to reveal it.

### Option B: A Raspberry Pi or computer at home (free, data stays home)

Needs a Raspberry Pi 3B+ or newer with 64-bit Raspberry Pi OS (or any Ubuntu or
Debian machine) that stays on.

1. Open a terminal on the Pi and run:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/vanhornway/HomeCircle/main/deploy/install.sh | sudo bash -s -- --mode tailscale
   ```
2. It prints a Tailscale login link. Open it and sign in (a free Tailscale
   account is fine). If Tailscale asks you to enable **Funnel**, say yes.
3. When it finishes, it prints your **Server address** (like
   `https://homecircle.tail1234.ts.net`) and **Setup code**. To see them again:
   `sudo cat /opt/homecircle/SETUP-INFO.txt`.

Family phones do **not** need Tailscale installed.

### Option C: A cloud server (DigitalOcean or Hetzner)

1. Create a server with **Ubuntu 24.04**, smallest size.
2. Under *Advanced options → Add initialization scripts* (DigitalOcean) or
   *Cloud config* (Hetzner), paste the contents of
   [deploy/cloud-init.yaml](../deploy/cloud-init.yaml).
3. Wait about 3 minutes, then log in with `ssh root@<server-ip>`. Your
   **Server address** and **Setup code** are shown when you log in.

### Option D: Any computer with Docker

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Download `docker-compose.yml` from the
   [latest release](https://github.com/vanhornway/HomeCircle/releases/latest)
   into a new folder, open a terminal in that folder and run:
   ```bash
   docker compose up -d
   ```
3. Get your **Setup code**:
   ```bash
   docker logs homecircle
   ```
4. Phones need an `https://` address that works from anywhere. The quickest way
   is [Tailscale Funnel](https://tailscale.com/kb/1223/funnel): install
   Tailscale on that computer, then run `tailscale funnel --bg 8080`. The
   address it prints is your **Server address**.

More choices (Fly.io, Railway, Cloudflare Tunnel, your own domain) are in
[deploy/README.md](../deploy/README.md).

**Check it works:** open your server address in a browser. You should see the
HomeCircle page.

---

## Step 2. Install the app

On each Android phone:

1. Open this link on the phone:
   **<https://github.com/vanhornway/HomeCircle/releases/latest/download/HomeCircle.apk>**
2. Tap **Download**. If Chrome warns about the file type, tap **Download anyway**.
3. Open the downloaded file. If asked, allow Chrome to **install unknown apps**
   (Settings → **Allow from this source**), then go back.
4. Tap **Install**. If Google Play Protect warns that the app is unrecognized,
   tap **More details → Install anyway**. This happens because HomeCircle is
   installed directly rather than from the Play Store.

---

## Step 3. Create your family circle (admin only)

1. Open HomeCircle and tap **Set up a new server**.
2. Fill in:
   - **Server address:** from step 1.
   - **Setup code:** from step 1. It only works once.
   - **Circle name:** for example *The Smiths*.
   - **Your name:** what your family calls you.
3. Tap **Create my circle**.

---

## Step 4. Allow location and notifications

When the app asks:

1. **Location:** choose **While using the app**, then on the next screen tap
   **Allow all the time**. Without "all the time", your family only sees
   where you were when you last opened the app.
2. **Notifications:** tap **Allow** so you hear new messages.
3. **Battery (recommended):** Android settings → **Apps → HomeCircle →
   Battery → Unrestricted**. Some phones (Samsung, Xiaomi, OnePlus) otherwise
   stop background updates.

---

## Step 5. Invite your family

1. Admin: open **Settings → Invite**. A QR code and link appear.
2. Each family member installs the app (step 2), opens it and taps
   **Join my family**.
3. They tap **Scan invite QR code** and scan the admin's screen, or paste the
   invite link if you sent it privately (a text message is fine, but don't
   post it publicly). Then they enter their name and tap **Join circle**.
4. They allow location and notifications (step 4).

Each invite works for **one person**, expires after a few days, and contains
part of your family's encryption key, so only share it with the person it's
for. Make a new invite for each family member.

---

## More than one group (circles)

One server can hold several **circles**, for example one for your household and
one for your parents and siblings. Each circle has its own people, map, chat,
places and encryption key, and nobody can see anything from a circle they
aren't in. You don't need a second server.

- **Create another circle:** only the person who set up the server can. Tap
  the circle name at the top of the Map (or go to **Settings → Your circles**),
  then **New circle**. Give it a name, then invite people to it.
- **Join another circle:** when someone invites you to a second circle, tap the
  circle name, then **Join a circle**, and scan their QR code.
- **Switch circles:** tap the circle name at the top of the Map, Chat or Places tab.
- **Choose who sees your location:** in **Settings → Your circles**, turn a
  circle off to stop sharing with it. That also removes your last location there.
- **Delete a circle:** the circle's owner can delete it in **Settings**. Other
  circles aren't affected.

---

## Everyday use

- **Map:** everyone's latest location. Updates about every 15 minutes, and
  sooner when someone moves a lot. Change the interval in **Settings**.
- **People:** tap a person on the Map for **Directions** (opens Google Maps or
  Apple Maps, and shows how old their location is), **Locate**, **Check in**
  ("where are you?" with a one-tap **I'm OK** answer), **Message**, and
  **Alert me** ("notify me when Dad leaves Work").
- **Locate:** anyone in a circle can tap **Locate** next to anyone else (or
  **Refresh everyone**) to ask their phone for a fresh location right now.
  Agreeing to this is part of joining a circle. If someone pauses sharing,
  everyone sees "Paused sharing" instead of an old location.
- **Chats:** the Chats tab lists every conversation: each circle's group chat
  and your direct messages, with unread counts. Tap **New message** to start a
  direct message with anyone in your circles, or tap **Message** next to a
  person on the Map. Direct messages can only be read by the two of you.
  Long-press a message to react with an emoji.
- **How precisely each circle sees you:** in **Settings → Your circles**, choose
  **Exact**, **Approximate** (about 1 km, rounded on your phone before it's
  encrypted) or **Paused** (with an optional reason they can read).
- **Low battery:** at 10% and again at 5%, your phone sends one last update so
  your circle knows where you were if it dies.
- **Places:** tap **Add a place**, type an address (or tap the map), and pick a
  radius in feet. Turn on **Add to all my circles** to share it with every
  circle you're in. When someone arrives or leaves, their circle's group chat
  gets a message.
- **Place alerts:** in **Settings → Place alerts**, untick **Announce my
  arrivals and departures** if you don't want your arrivals posted in chat, or
  untick **Show place alerts in my chats** to hide other people's.
- **Message history:** a circle's admin chooses how long messages are kept
  (Settings → Message history): 1 day, 1 week, 1 month, 3 months or 1 year.
  Nothing is kept longer than a year.
- **Going back:** swipe from the left edge (iPhone) or use Android's back
  gesture or button.
- **On a laptop:** open your server address in a browser to see the map and
  chat.

---

## iPhone

There's no iPhone app download yet. Until there is, iPhone users can open the
server address in Safari to see the map and chat, but their location is only
shared while that page is open.

## Notes for this test version

- **Message notifications** show while HomeCircle is open or recently used.
  Notifications for a fully closed app, and **Locate** reaching a closed app,
  need push setup that's still being added.
- **Updating the app:** download the APK from the same link and install it over
  the old one. Your circle and keys are kept.
- **Updating the server:** Render updates on its own when the code changes. On a
  Pi or cloud server, run `sudo bash /opt/homecircle/src/deploy/install.sh` again.
  With Docker, run `docker compose pull && docker compose up -d`.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Can't reach the server" | Open the server address in the phone's browser. If it doesn't load, the server is off or the address is wrong. Fix the address under **Settings → Change server address**. |
| "Setup code is wrong" | The code works once and is case-sensitive. On Docker without `SETUP_TOKEN`, it changes each time the server restarts; run `docker logs homecircle` again. |
| Someone's location is old | Check they chose **Allow all the time** and set Battery to **Unrestricted**. Opening the app on their phone sends a fresh update. |
| New phone | Ask the admin for a new invite. The admin can remove the old phone in **Settings**: tap **Remove** next to the person. |
