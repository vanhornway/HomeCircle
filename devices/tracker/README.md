# HomeCircle Tracker

Firmware that turns a small ESP32 board into a HomeCircle tracker: a device
for a car's glovebox or a child's bag that runs for weeks or months on a
battery. It wakes, finds where it is, sends that to the circle, and sleeps.
It also has an SOS button. It doesn't need the HomeCircle app or a phone of
its own. This is in addition to the planned tracker skin for spare Android
phones.

A tracker is an ordinary member of the circle. It joins with an invite link
and makes its own keys. It seals everything with the circle key, exactly as
the app does (docs/PROTOCOL.md), so the server can't read where it is. Admins
see it on the map under the name it was given, such as "Car" or "Leo's tracker".

## What it does

- **Reports its location** every few minutes while moving and less often
  while still. An admin sets both intervals. The defaults are 2 minutes and
  60 minutes.
- **SOS:** hold the button for 2 seconds. The circle gets an SOS just like one
  from the app, and the tracker reports every minute until it is called off.
  To call it off, hold the button for 5 seconds; the circle sees "safe". An
  SOS made with no signal is saved and sent as soon as the tracker connects.
- **A short press** sends a location right away.
- **Follows the circle:** it picks up a new circle key when someone is
  removed. It stops when it is removed itself.
- **Battery and charging** go with each location, so Circle health shows them.

**On a Meshtastic node:** the same protocol code also runs inside Meshtastic
firmware (`devices/meshtastic`). A LoRa tracker such as the Heltec Wireless
Tracker can then report over the mesh, through a home base, when it has no
internet.

## Boards

| Board | Connects by | Good for | Rough price |
|---|---|---|---|
| **LilyGO T-SIM7080G-S3** (`t-sim7080g-s3`) | LTE-M / NB-IoT cellular, with GNSS in the same modem | A car, a bike, a bag: anywhere with LTE-M coverage | about $35–45, plus a data SIM |
| **Any ESP32-C3 board + a UART GPS module** (`esp32c3-wifi`) | Wi-Fi only | A child's bag that comes home or to school every day; a cheap first build | about $8–12 in parts |

Plain Arduinos (Uno, Nano) can't do it: they have 2 KB of memory, and the
encryption and HTTPS need far more. An ESP32 is the smallest chip that works.

**The cellular board needs a SIM that supports LTE-M or NB-IoT.** Many IoT
SIMs do (1NCE, Hologram, Soracom, and others). Check that your carrier has
LTE-M coverage where the tracker will be.

**Pins:** the T-SIM7080G-S3 pins come from LilyGO's published pin map
(`src/firmware/board_sim7080.cpp`). Check them against your board's revision
before flashing. Each pin can be overridden with a build flag, for example
`-DHC_SOS_PIN=18`. The board's BOOT button is the SOS button unless you wire
another one.

**Wiring the ESP32-C3 build** (all changeable with build flags in
`board_c3wifi.cpp`):

| From | To |
|---|---|
| GPS TX | GPIO 4 |
| GPS RX | GPIO 5 |
| GPS power switch (a P-MOSFET, or the module's EN pin) | GPIO 6 |
| SOS button to GND, with a 100 kΩ pull-up to 3.3 V | GPIO 3 |
| Battery + through a 1:2 divider (two 100 kΩ) | GPIO 2 |

Switch the GPS off between wakes. A GPS module left on draws about 25 mA and
empties a small battery in a day or two. A coin cell or supercap on the GPS
backup pin keeps its almanac, so each fix takes seconds instead of a minute.

## Flashing

You need PlatformIO (`pip install platformio`, or the VS Code extension).

```bash
cd devices/tracker
pio run -e t-sim7080g-s3 -t upload        # or -e esp32c3-wifi
pio device monitor
```

The monitor prints the tracker's setup network and password:

```
Setup: join the Wi-Fi network "HomeCircle Tracker 3FA2" (password k7m2qx9p4t) …
```

**Write the password on the device.** It is the same every time, because it
comes from the chip itself.

## Setting it up

1. An admin opens the HomeCircle app and makes an invite: **Settings → Your
   circle → Invite**.
2. Power the tracker on. On a phone, join the **HomeCircle Tracker XXXX**
   Wi-Fi network with the password you wrote down. The setup page opens; if
   it doesn't, open `http://192.168.4.1`.
3. Fill in the page:
   - a name for the tracker
   - the invite link
   - the Wi-Fi networks it may use
   - on the cellular board, the SIM's APN
4. Press **Join the circle**. The tracker joins and turns its setup network
   off. A minute or two later it appears on the map.

Turn on **SOS** in the circle's features (Settings → Your circle → Features).
Otherwise the app shows a tracker's SOS only as a chat message.

**Starting over:** hold the button while powering on, and keep holding for
10 seconds. The tracker forgets its circle and opens the setup page again.

## Settings an admin can change

How often the tracker reports lives in the admin's `member` record about it
(`tracker: { mode, moving, still, quiet, sos }`; docs/PROTOCOL.md). The
tracker reads it about every sixth wake. The app's screen for these settings
comes with the tracker skin. Until then the defaults apply, and an admin can
set them from the shared client:

```js
await client.setMemberRecord(trackerId, { tracker: { mode: 'car', moving: 5, still: 120, sos: true } });
```

## Battery life (estimates, not measured)

Each report is one wake: a GNSS fix (5–30 s), connecting, sending, and back to sleep.

| | Per report | Asleep | 3,000 mAh lasts about |
|---|---|---|---|
| T-SIM7080G-S3, parked, hourly | 0.5–1 mAh (LTE-M attach and HTTPS dominate) | well under 1 mA with the modem's power cut | 2–4 months |
| T-SIM7080G-S3, moving, every 2 min | 0.3–0.6 mAh (warm GNSS, network still attached) | — | 1–3 days of driving |
| ESP32-C3 + GPS, hourly | about 0.2–0.4 mAh | 20 µA–1 mA, depending on the board's regulator and LED | 1–6 months |

In a car, power it from a USB socket. Plugged in, it charges, and the 2-minute
moving interval costs nothing. Cheap C3 boards often have a power LED and a
regulator that waste more current than the chip. Desolder the LED, or pick a
board with a low-quiescent regulator. Measure your own build with a USB power
meter before relying on these numbers.

## What it doesn't do yet

- **Not tested on real hardware.** The protocol code is tested end to end
  against a real server (below), and both builds compile. Nothing has run on
  a board yet: check the pins, the modem and the battery figures on a real
  one before relying on it.
- **Locate now:** the tracker sleeps, and the server can't wake it. A Locate
  request waits until the tracker's next report.
- **Positions taken offline** aren't sent later. The server keeps only each
  member's latest location, so a tracker that was out of signal sends where
  it is now, not the path it took. The path needs the trip history from the
  tracker plan.
- **Quiet-hours alert** ("the car moved at night") isn't built. The tracker
  reads the hours but doesn't act on them yet.
- **The SIM7080G can't use GNSS and LTE at the same time.** It looks for
  satellites first with the radio off, then connects.

## Security

- **HTTPS** is checked against a short list of root certificates
  (`src/firmware/roots.h`): Let's Encrypt, Google Trust Services, DigiCert,
  Sectigo and Amazon. These cover Render, Railway, Fly and Home Assistant
  Cloud. A server whose certificate chains to another root needs that root
  added. Plain `http://` works only for testing on a local network.
- **The tracker's keys and the circle key** are kept in the chip's flash. A
  stolen tracker can be read by someone with the tools. If one goes missing,
  remove it from the circle: that changes the circle key, and the tracker can
  no longer read or send anything. To protect the flash itself, turn on
  ESP32 flash encryption when flashing; it is permanent on that chip.
- **The setup page** is on the tracker's own WPA2 network, never the
  internet. The invite link is used once and not stored.
- Like any member, a tracker is visible to everyone in the circle. It never
  shows anyone else's location, because it has no screen.

## Tests

The protocol code builds for this computer too (`env:native`). The end-to-end
test does the following:
1. Starts a local HomeCircle server.
2. Makes a circle with the app's own client.
3. Has the tracker code join, send locations and an SOS, and read its settings.
4. Has it follow a key rotation and notice being removed.

The admin's client opens and checks everything the tracker sends.

```bash
brew install libsodium          # macOS; libsodium-dev on Linux
cd devices/tracker
pio run -e native
node test/e2e.mjs
```

## Layout

- `lib/homecircle/`: the protocol (join, keys, sealing, location, SOS,
  settings). It has no Arduino code, and the same files build for the boards
  and for tests.
- `src/firmware/`: the boards, HTTPS, flash storage, the setup page and the
  wake cycle.
- `src/host/`: a command-line driver for the tests.
- `test/e2e.mjs`: the end-to-end test.
