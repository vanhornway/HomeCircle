# Run HomeCircle on Home Assistant

If you already run Home Assistant at home, this is the quickest free way to
host HomeCircle. It takes about 15 minutes. Your family's data stays in your
house and is included in your Home Assistant backups. Phones reach it from
anywhere through **Tailscale Funnel**: a free, secure `https://` address with
no router changes, and nothing extra to install on the phones.

**You need:**

- Home Assistant **OS** or **Supervised**, the versions with an Add-on Store
  (**Settings → Add-ons**). Home Assistant Container or Core can't run
  add-ons; use the [Docker option](SETUP.md#option-d-any-computer-with-docker)
  instead.
- A free Tailscale account. You'll create it in step 2.
- An Android phone for the app.

---

## 1. Add HomeCircle to Home Assistant (3 minutes)

1. Click this link, enter your Home Assistant address if asked, and click
   **Add**:

   [![Add the HomeCircle repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fvanhornway%2FHomeCircle)

   <details><summary>Link doesn't work? Add the repository by hand.</summary>

   In Home Assistant go to **Settings → Add-ons → Add-on Store**, click **⋮**
   (top right) → **Repositories**, paste
   `https://github.com/vanhornway/HomeCircle`, and click **Add**.
   </details>

2. In the Add-on Store, find **HomeCircle** (refresh the page if it isn't
   there yet), open it and click **Install**. It takes 2–5 minutes, longer on
   a Raspberry Pi 3.

## 2. Get a Tailscale key (5 minutes)

Tailscale gives HomeCircle its public `https://` address.

1. Sign up at <https://login.tailscale.com/start>. A Google, Microsoft, Apple
   or GitHub login is fine. If it asks you to add a device, skip that step.
2. Open the **DNS** page: <https://login.tailscale.com/admin/dns>.
   - **MagicDNS** must be on (it is for new accounts).
   - Under **HTTPS Certificates**, click **Enable HTTPS**.
3. Open **Settings → Keys**: <https://login.tailscale.com/admin/settings/keys>.
   Click **Generate auth key…**, keep the defaults, click **Generate key** and
   copy the key (it starts with `tskey-auth-`).

## 3. Start HomeCircle (2 minutes)

1. In Home Assistant, open the HomeCircle add-on's **Configuration** tab.
2. Paste the key into **tailscale_auth_key** and click **Save**.
3. Go to the **Info** tab, turn on **Start on boot** and **Watchdog**, then
   click **Start**.
4. Open the **Log** tab and wait about a minute. You'll see:

   ```
   [homecircle] Phones can reach HomeCircle at:  https://homecircle.tail1234.ts.net
   ...
     and this one-time setup code:  k3J9-…
   ```

   Write down the **address** and the **setup code**.

   If the log instead says **Funnel … is off**, open the link printed below
   that line, click **Enable**, then click **Restart** on the Info tab.

5. **Keep it connected.** Tailscale signs devices out after 180 days unless
   you turn that off. Open <https://login.tailscale.com/admin/machines>, click
   **⋯** next to **homecircle**, and choose **Disable key expiry**.

**Check it:** open the address on your phone's browser. You should see the
HomeCircle page.

## 4. Create your circle (3 minutes)

1. On your Android phone, open <https://homecircle.umair.us>, tap
   **Download for Android**, and install the app.
2. Open HomeCircle, tap **Set up a new server**, and enter the address and
   setup code from the log.
3. Allow location **All the time** and notifications. **Settings → Setup
   check** shows anything left to fix.
4. Invite your family from **Settings → Invite**. They just install the app
   and open your link; they don't need Tailscale.

That's it. The rest of the [setup guide](SETUP.md#step-4-allow-location-and-notifications)
covers everyday use.

---

## Good to know

- **Choose your own setup code:** set **setup_code** in the Configuration tab
  (12+ characters). Otherwise the add-on creates a random code each time it
  starts, until your circle exists.
- **Address name:** **tailscale_hostname** sets the first part of the
  address. The default is `homecircle`.
- **Backups:** HomeCircle's data (all encrypted) and its Tailscale login are
  in the add-on's data, which Home Assistant backups include. Restore a backup
  and everything comes back, with the same address.
- **Updates:** when Home Assistant shows an update for HomeCircle, click
  **Update**. Your circles are kept.
- **Already use the Tailscale add-on?** That's fine. HomeCircle runs its own
  separate Tailscale connection, which shows up as its own machine.
- **Privacy:** locations and messages are encrypted on the phones. Neither
  Home Assistant, Tailscale nor anyone else can read them.
- **On your home network only**, without Tailscale, the server is at
  `http://<home-assistant-ip>:8080`. Phones need the Tailscale address to
  work away from home.

## Troubleshooting

| The log says | Do this |
|---|---|
| `Tailscale login failed … invalid key` | The key was mistyped, already used, or expired. Generate a new one (step 2.3), paste it, Save, Restart. |
| `Tailscale didn't connect` | Same as above. Also check that Home Assistant has internet access. |
| `Funnel … is off` | Open the link in the log and click **Enable**, then restart. If there's no link, check that **HTTPS** is enabled (step 2.2). |
| `No Tailscale auth key set` | Paste a key in the Configuration tab, Save, Restart. |
| The address doesn't open on the phone | Wait 1–2 minutes after the first start (the certificate is being created), then try again. Turn off any VPN on the phone. |
| HomeCircle isn't in the Add-on Store | Refresh the page, or **⋮ → Check for updates**. Make sure the repository URL is exactly `https://github.com/vanhornway/HomeCircle`. |
