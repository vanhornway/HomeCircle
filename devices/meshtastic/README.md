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
  It's for someone (who has it), or a car, a pet, luggage, keys or something
  else, which an admin can change in the app at any time. The app counts
  trackers apart from people and doesn't offer them people's settings.
- **When someone's phone goes quiet**, the home base asks the tracker they
  carry for a fresh position over the mesh.
- **An SOS** from a tracker (a text with "SOS" or the alert bell) becomes an
  SOS in the circle. "OK" or "safe" ends it.
- **The button means something** on a SenseCAP T1000-E with the HomeCircle
  build: 1 to 5 presses, up to 2 s apart (see "The tracker's button" below).
  5 presses are an SOS; a long beep means it went out.
- **Settings from the app:** how often trackers send their position and
  battery, for all of them or one, and what each number of presses says.
  The home base puts the intervals on each tracker over the radio.
- **The app's buttons reach the tracker:**
  - **Locate** asks it for a position over the mesh.
  - **Chirp** and **Ask to check in** make it beep. Its "OK" answers the
    check-in.
  - **Arrived and left** alerts for places work as they do for phones.
- **The radio path:** tapping the tracker shows how its position reached
  home, for example `UT1 → meshunit1 → meshunit2 → Home base`, with the
  signal on each hop (a Meshtastic traceroute).
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
| SenseCAP T1000-E (optional) | stock Meshtastic plus HomeCircle's button: 1 to 5 presses | `tracker-t1000-e-homecircle` (a `.uf2`: copy it onto the T1000-E drive in update mode) |
| Heltec Wireless Tracker (optional) | a tracker that seals at the source and also reports over Wi-Fi | `heltec-wireless-tracker-homecircle` |

## Building and flashing the home base

```bash
pip install platformio                     # once
devices/meshtastic/build.sh ~/meshtastic-homecircle heltec-v4-homebase
```

`build.sh` does the following:
1. Clones the Meshtastic release the modules are written against (v2.7.26).
2. Copies in the HomeCircle modules and the shared tracker library.
3. Registers the modules (`register.py`).
4. Adds one line to Meshtastic's GPS driver that passes the raw GPS data to
   the home base, so it can list satellites.
5. Builds.

To update a home base that's already set up, write only the app (`firmware-….bin` at 0x10000). That keeps its circle membership and settings. For a new board, flash the printed `…factory.bin` with the Meshtastic web flasher
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

   If setup is interrupted, the home base finishes it at its next start:
   - If it joined the circle but has no Wi-Fi saved, the hotspot comes back
     asking only for Wi-Fi.
   - A missing private channel is made again.
4. **Make "Home base" an admin** in the app, so it can add trackers by itself.
5. **Turn on the plugin:** Settings → Features → Plugins → **Meshtastic
   trackers**.
   - Until it's on, the server takes no tracker packets or requests for the
     circle, and the home base stays idle.
   - Its settings are optional: after how long a phone counts as quiet (30
     minutes), how often to trace each tracker's path (30 minutes; 0 for only
     on Locate), and the words that start an SOS ("SOS, help").
   - The home base reads them within 10 minutes. A server older than 0.25
     doesn't know the plugin, and the home base then runs with the defaults.

## Adding a tracker

1. **Put the tracker on the private channel.** Connect the tracker to the
   Meshtastic app on any phone, then open the channel link: the setup page
   shows it, and the home base sends it again if you message it "channel".
   - The link makes HomeCircle the tracker's primary channel, because
     Meshtastic sends positions on the primary.
   - It keeps the tracker on the home base's frequency, so other people's
     nodes still relay for it.
   - That is the only time the tracker needs a phone.
2. **Add it in HomeCircle**, whichever way is easiest:
   - **Its QR code:** Trackers → Add a tracker with its QR code. In the
     Meshtastic app, open the tracker and choose Share contact. Scan its QR
     code, or paste its link. HomeCircle fills in its node id and name, and
     then shows the channel QR code and the home base's key to put on the
     tracker.
   - **Heard nearby:** Trackers lists the nodes the home base hears. Tap one.
   - **In the chat with Home base:**
     - `list`: shows the nodes it can hear, with their ids.
     - `add !a1b2c3d4 Leo's tracker`, `add !0badcafe Honda CR-V as car`, or
       `add https://meshtastic.org/v/#… as pet` (the Share contact link).
       Kinds: car, pet, luggage, keys, other. With none, someone carries it.
     - `link Leo's tracker to Leo`: whose tracker it is. When Leo's phone
       goes quiet, the home base asks this tracker where it is.

   A Share contact link also gives the home base the tracker's key, so it
   can send the tracker its settings before it has even heard it.

**More commands:**

| Command | What it does |
|---|---|
| `rename Name to New name` | Changes the tracker's name on the map |
| `unlink Name` | It no longer stands in for anyone |
| `remove Name` | Takes the tracker out of the circle |
| `channel` | The link that puts a tracker on the private channel |
| `status` | Shows the circle, how many trackers, and whether Home base is an admin |
| `gps` | Where the home base is (if it has a GPS module, like the Heltec V4's L76K), how good the fix is, the satellites it can see by system with their signal, and a map link. It also puts Home base on the map, refreshed every 10 minutes while it has a fix |

Anyone can ask for `list` and `status`; only admins can change trackers.

**Let the home base set the tracker,** once per tracker, in the Meshtastic
app: connect to the tracker, open Settings → Security, and add the home
base's public key as an Admin key. Settings → Circle → Trackers shows the key
with a copy button when a tracker still needs it. From then on the home base
puts HomeCircle's settings on it over the radio (Meshtastic remote admin,
encrypted to the tracker's key):
- GPS on, smart position on.
- A position at most every N minutes while moving (2 by default) and every
  M minutes otherwise (15).
- A battery report every K minutes (30), so the app shows its battery.
- The buzzer on for the alert bell, so Chirp and Ask to check in beep.
- Meshtastic's 3-press "GPS off" turned off.

It sends them once, when they change in the app. A change made on the tracker
itself, in the Meshtastic app, stays until the app's settings change again.

## The tracker's button

On a SenseCAP T1000-E with the HomeCircle build (`tracker-t1000-e-homecircle`),
press the button 1 to 5 times, no more than 2 s apart. It beeps once for
each press it counts.

| Presses | Means | What the circle gets (editable in the app) |
|---|---|---|
| 1 | I'm OK | Answers "Ask to check in" when the tracker beeped for one: "✅ I'm OK". On its own it sends nothing, so a bump in a pocket stays quiet |
| 2 | Here's where I am | "📍 Here's where I am" and a fresh position |
| 3 | Come pick me up | "🚗 Please come pick me up" and a fresh position, as an urgent alert |
| 4 | On my way home | "🏠 I'm on my way home" and a fresh position |
| 5 | SOS | An SOS on everyone's phone with "🆘 I need help". 5 presses again send "I'm safe" and end it |
| hold | Off or on | Meshtastic's own |

The tracker only counts: it sends `#press N` on the private channel as data, not a text, so other trackers don't beep (with
its position for 2 to 4), and the home base sends the message. So the
messages live in the app: Trackers → Settings for all trackers, or one
tracker's own settings. The HomeCircle build takes over Meshtastic's own
2, 3 and 4 press gestures (send a position, GPS on or off, mute).

## In the app

- **Settings → your circle → Trackers:**
  - Shows the home base (online or offline, its power, Wi-Fi and GPS) and
    each tracker: who carries it, its last position, how many hops away it
    is, its battery and signal, and whether its settings are on it.
  - **Settings for all trackers** and each tracker's **Settings** (its own,
    or the same as every tracker): position and battery intervals, and the
    message for each number of presses. Learn more explains the button.
  - Admins can add a tracker from the nodes the home base hears (name, a car
    or someone carrying it, and who), rename it, change who carries it, or
    remove it.
  - Underneath, it sends the same commands you could type to Home base.
- **On the map:** a tracker is a rounded square with 🚗 or 🎒. When someone's
  phone has been quiet for 30 minutes and the tracker they carry has reported
  since, their own pin moves to the tracker's position, marked 📡. That
  tracker's pin then steps aside.
- **A tracker's sheet** has no Call or Message. Locate, Chirp and Ask to
  check in are worded for a radio. It shows who carries the tracker and the
  radio path.

## What the app's buttons do for a tracker

| In the app | What the home base does |
|---|---|
| Locate | Asks the tracker for its position over the mesh and traces its path. The new position shows on the map, and the tracker answers in your chat with it ("📍 Here now…" with a map link), or says it hasn't answered after 3 minutes |
| Chirp | Sends it a message with the alert bell: it beeps. "Chirp everyone" is for people and leaves trackers out |
| Ask to check in | Makes it beep and asks for its position. "OK" from the tracker sends you "✅ I'm OK" |
| Alert me when they arrive or leave | Works as for phones: the home base checks each position against the circle's places |

How these reach the home base:
- **Locate, Chirp and Ask to check in** go through the server. A tracker tells
  the server which home base keeps it (`PUT /members/me/keeper`). The server
  queues requests for that tracker, and the home base collects them every
  few seconds (`GET /keeper/pending`).
- **The tracker must know the home base's key.** Chirps and check-ins are
  direct messages, encrypted from the home base's key to the tracker's. The
  home base sends its key straight to each tracker when it's added, and again
  every 12 hours. A tracker that never heard it can't open them.
- **The tracker must beep for messages.** The home base turns on the buzzer
  for the alert bell with the tracker's settings. On a tracker that doesn't
  take settings yet, turn on External notification with a buzzer in the
  Meshtastic app.
- **The path** is traced when you tap Locate, and every 30 minutes while
  the tracker reports. It goes into the tracker's sealed location, so the
  server can't read it.

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
- **Locate, Chirp and Ask to check in need a server from this branch.**
  Older servers answer 404, and the home base then tries again every 10
  minutes.
- **The path view** needs the app release that has it. Older apps just
  don't show it.
- **Phones on the mesh** (a Meshtastic node paired with the phone) are still
  to do.
