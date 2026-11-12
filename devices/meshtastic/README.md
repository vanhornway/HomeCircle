# HomeCircle on Meshtastic

People can be found even where their phone has no signal. A **home base**,
a Meshtastic node on your home Wi-Fi, listens to the mesh for your family's
Meshtastic trackers and puts them on the HomeCircle map. Your HomeCircle
server can be anywhere: Render, a VPS, or at home.

```
 tracker (any Meshtastic tracker,          other people's nodes relay
 stock firmware: T1000-E, Heltec,  ── LoRa ──────────────────────────▶  home base (Heltec V4)
 LilyGO…)                                                                │ your home Wi-Fi, HTTPS out
                                                                         ▼
                                                     HomeCircle server (Render or anywhere)
                                                                         │
                                                                         ▼
                                                      phones: the tracker's pin on the map
```

- **Any Meshtastic tracker** works, with its normal firmware. Nobody pairs it
  with a phone or the HomeCircle app. You put it on the private HomeCircle
  channel once, in the Meshtastic app.
- **Each tracker is its own pin**, named by an admin: "Leo's tracker",
  "Honda CR-V". It is a member of the circle, and the home base holds its keys.
- **When someone's phone goes quiet**, the home base asks the tracker they
  carry for a fresh position over the mesh.
- **An SOS** from a tracker (a text with "SOS" or the alert bell) becomes an
  SOS in the circle. "OK" or "safe" ends it.
- **Admins manage it by chatting with "Home base"** in the HomeCircle app. No
  new app is needed.

## Who can read what

- **A stock tracker** can't seal its position for the circle. It sends a
  normal Meshtastic position, encrypted with the HomeCircle channel's key.
  - The home base reads it and seals it with the circle key, as that
    tracker's member.
  - **Can read it:** the circle, the home base, and Meshtastic nodes that have
    the private channel's key (your own).
  - **Can't read it:** the server, your hosting provider, and other people's
    nodes (they relay without being able to read it).
- **The home base is a full member** and holds the circle key: it can read
  the circle's locations and messages. Keep it somewhere safe. If it's lost,
  remove it in the app, and the circle key changes.
- **HomeCircle-firmware trackers** (`heltec-wireless-tracker-homecircle`,
  below) seal at the tracker itself. The home base passes their packets on
  without being able to read them.

## What you need

| Part | Use | Build env |
|---|---|---|
| **Heltec WiFi LoRa 32 V4** | the home base: indoors, on USB power and Wi-Fi, with a good antenna | `heltec-v4-homebase` |
| Any Meshtastic tracker: SenseCAP T1000-E, Heltec Wireless Tracker, LilyGO T-Beam or T-Echo, RAK… | carried by a person or kept in a car | stock Meshtastic |
| Heltec Wireless Tracker (optional) | a tracker that seals at the source and also reports over Wi-Fi | `heltec-wireless-tracker-homecircle` |

## Building and flashing the home base

```bash
pip install platformio                     # once
devices/meshtastic/build.sh ~/meshtastic-homecircle heltec-v4-homebase
```

`build.sh` does the following:
1. Clones the Meshtastic release the modules are written against (v2.7.26).
2. Copies in the HomeCircle modules and the shared tracker library.
3. Registers the modules and builds.

Flash the printed `…factory.bin` with the Meshtastic web flasher
(flasher.meshtastic.org, "Open custom firmware"), or run
`pio run -d ~/meshtastic-homecircle -e heltec-v4-homebase -t upload`.

The firmware is GPL-3.0, because Meshtastic is. The module files say so.

## Setting it up

1. **Power the home base on.** Its screen shows a Wi-Fi network,
   **HomeCircle Home Base XXXX**, and its password.
2. **Join that network** from a phone. The setup page opens; if it doesn't,
   open `http://192.168.4.1`.
3. **Fill in the setup page:**
   - **Home Wi-Fi** name and password (2.4 GHz).
   - **An invite link** from the HomeCircle app (Settings → Your circle →
     Invite). The link also tells the home base where your server is, so
     there is no separate address to type.
   - **Where you are**, so the radio uses your country's LoRa band.

   The home base joins your circle as **Home base**. It creates the private
   HomeCircle channel, shows the link that puts trackers on it, and restarts
   on your Wi-Fi.
4. **Make "Home base" an admin** in the app, so it can add trackers by itself.

## Adding a tracker

1. **Put the tracker on the private channel.** Connect the tracker to the
   Meshtastic app on any phone, then open the channel link: the setup page
   shows it, and the home base sends it again if you message it "channel".
   - The link makes HomeCircle the tracker's primary channel, because
     Meshtastic sends positions on the primary.
   - It keeps the tracker on the home base's frequency, so other people's
     nodes still relay for it.
   - That is the only time the tracker needs a phone.
2. **In HomeCircle, message Home base:**
   - `list`: shows nodes it can hear, with their ids.
   - `add !a1b2c3d4 Leo's tracker`, or `add !0badcafe Honda CR-V as car`.
   - `link Leo's tracker to Leo`: whose tracker it is. When Leo's phone goes
     quiet, the home base asks this tracker where it is.

**More commands:**

| Command | What it does |
|---|---|
| `rename Name to New name` | Changes the tracker's name on the map |
| `unlink Name` | It no longer stands in for anyone |
| `remove Name` | Takes the tracker out of the circle |
| `channel` | The link that puts a tracker on the private channel |
| `status` | Shows the circle, how many trackers, and whether Home base is an admin |

Anyone can ask for `list` and `status`; only admins can change trackers.

**Settings on the tracker,** in the Meshtastic app:
- Smart position on.
- A position interval to taste: every 15 minutes is the default, shorter
  for a child out alone.
- On the T1000-E, its button's alert set to send a message containing
  "SOS".

## How "phone offline" works

The home base reads every member's latest location, which it can because it
is a member. A person counts as quiet after 30 minutes, or after twice their
phone's "still" interval plus 5 minutes if that is longer.

When the person who carries a tracker is quiet:
- The home base asks that tracker for a position over the mesh.
- It asks at most once every 10 minutes, and not when the tracker reported
  in the last 10 minutes.
- It leaves the tracker alone if the person paused sharing.

The tracker's pin shows the answer, marked "via radio". Its member record
says whose tracker it is, so the app can show the person at their tracker.

## Range

LoRa reaches about 1–5 km in town and 10 km or more with line of sight.
Each relaying node extends that, up to 3 hops by default and 7 at most.

"Lost in the forest" works when a chain of nodes connects the tracker to the
home base. Your own nodes or the public mesh both count. A solar node on
high ground near home helps a lot. Far from any node, nothing gets through
until the tracker is back in range.

## Without a home base on Wi-Fi

A HomeCircle server at home can talk to a Meshtastic node over USB or
Wi-Fi itself (`MESH_NODE`, deploy/README.md). Any computer at home can run
`server/scripts/mesh-bridge.mjs` for a server elsewhere. Both only pass on
HomeCircle-firmware trackers' sealed packets. Stock trackers need the home
base above.

## Not done yet

- **Not tested on real hardware or on air.** Both firmwares build against
  Meshtastic 2.7.26. The home base's logic, with a simulated radio, and the
  sealed packets are tested end to end against a real server
  (`devices/tracker/test/homebase.mjs` and `test/e2e.mjs`).
- **The app doesn't yet show** "via radio", or a person at their tracker
  when their phone is quiet. The data is there: the location's `via` and the
  tracker's `carriedBy` in its member record. This needs an app release.
- **Locate in the app** doesn't reach a stock tracker. The home base asks it
  only when its person's phone is quiet. Sending a Locate to the home base
  needs a small server change.
- **Phones on the mesh** (a Meshtastic node paired with the phone) are still
  to do.
