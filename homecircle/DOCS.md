# HomeCircle

Private family location sharing and chat, end-to-end encrypted, running on
your Home Assistant. Your family's phones connect to it from anywhere through
Tailscale Funnel: a free, secure `https://` address with no router changes.

## Set up (about 10 minutes)

### 1. Get a Tailscale key (free)

1. Sign up at <https://login.tailscale.com/start> (Google, Microsoft, Apple or
   GitHub login is fine).
2. **DNS** page: make sure **MagicDNS** is on, then under **HTTPS Certificates**
   click **Enable HTTPS**.
3. **Settings → Keys → Generate auth key**. Leave the defaults (not reusable,
   not ephemeral) and click **Generate key**. Copy the key (`tskey-auth-…`).

### 2. Start HomeCircle

1. Open HomeCircle's **Configuration** tab, paste the key into
   **tailscale_auth_key**, and click **Save**.
2. Open the **Info** tab and click **Start**. Turn on **Start on boot** and
   **Watchdog**.
3. Open the **Log** tab. After about a minute you'll see:

   ```
   Phones can reach HomeCircle at:  https://homecircle.your-tailnet.ts.net
   ...
   and this setup code:  …
   ```

   If it says **Funnel … is off**, open the link it shows, click **Enable**, and
   restart HomeCircle.
4. **Keep it connected:** Tailscale signs devices out after 180 days unless
   you turn that off. At <https://login.tailscale.com/admin/machines>, click
   **⋯** next to **homecircle** → **Disable key expiry**.

### 3. Create your circle

1. Install the app on your phone from
   <https://homecircle.umair.us> (Android) and open it.
2. Tap **Set up a new server** and enter the address and setup code from the
   log.
3. Invite your family from **Settings → Invite**.

## Options

| Option | What it does |
|---|---|
| `tailscale_auth_key` | Connects HomeCircle to your Tailscale account. Only needed the first time; the login is remembered. |
| `tailscale_hostname` | The first part of the address (`homecircle` → `https://homecircle.<tailnet>.ts.net`). |
| `setup_code` | Optional: choose your own setup code (12+ characters) instead of the random one in the log. |
| `run_agent` | Runs the circle agent, an optional AI helper that remembers dates, schedules and decisions for a circle. It can't read your chats. Each circle's admin then adds it in the app (Settings → Circle agent) with their own AI provider key. Off by default. |
| `load_test_server` | Runs a second, separate HomeCircle on port 8081 (and `https://…:8443` with Tailscale) for stress tests with simulated people. Your circles aren't touched. See the [load-test guide](https://github.com/vanhornway/HomeCircle/blob/main/docs/LOAD-TEST.md). |
| `load_test_setup_code` | Optional: your own setup code for the load-test server (12+ characters). |
| `load_test_reset` | Deletes the load-test server's data on the next start. Turn it off again afterwards. |

## Everyone's location in Home Assistant (optional)

To start automations when someone arrives or leaves ("lights on when Maya gets
home"):

1. In Home Assistant: your profile → **Security** → **Long-lived access
   tokens** → **Create token**, and copy it.
2. In the HomeCircle app, as a circle admin: **Settings → Features →
   Plugins → Home Assistant** on. The address is filled in
   (`http://homeassistant:8123`); paste the token and tap **Connect**.
3. Each person shows up under **Settings → Devices & services → Mobile App**
   as *HomeCircle Name*, with `device_tracker.homecircle_name` (Home Assistant
   puts it in your zones) and a battery sensor. Phones that are open send
   their location right away; others with their next update.

Use them like any phone's tracker: a **Zone** trigger, or **State** going to
`home`. Anyone can turn theirs off in the app under **Settings → Location
sharing → Home Assistant**. To remove someone, delete their device in Home
Assistant.

## Good to know

- **Backups:** HomeCircle's data (all encrypted) and the Tailscale login are in
  its app data, which Home Assistant backups include.
- **Privacy:** messages and locations are encrypted on the phones. Neither
  Home Assistant, Tailscale nor anyone else can read them. The one exception
  is the Home Assistant plugin, if a circle's admin turns it on: then each
  phone also sends its location to HomeCircle to pass on to your Home
  Assistant (nothing about where anyone is gets kept).
- **Family phones don't need Tailscale.** Funnel makes the address reachable
  from anywhere.
- **Home network only:** without a Tailscale key, HomeCircle still runs at
  `http://<your-home-assistant-ip>:8080`, but phones can't reach it away from
  home.
- **Updating:** when Home Assistant shows an update for HomeCircle,
  click **Update**. Your circles are kept.

Something not working? See the troubleshooting table in the
[full guide](https://github.com/vanhornway/HomeCircle/blob/main/docs/HOME-ASSISTANT.md#troubleshooting).
