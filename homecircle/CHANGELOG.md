# Changelog

See the full list of changes on <https://homecircle.umair.us/#changelog>.

## 0.16.0

- Steadier on slow or distant connections: the server forgives one missed
  heartbeat (a phone is dropped after about 50 s of silence, not 25 s).
- Home Assistant plugin: spaces and invisible characters in the address or
  token are removed, `https://` is added when the address has no scheme,
  and a token with a character a token can't have says which one and where.
- Phones (app 0.16.0) keep the messages they've opened, so they open in about
  a second however long the history; they also give up on requests after
  20 s and retry, and show each person's app version in Circle health.
- Needs the HomeCircle app 0.16.0 for the phone-side fixes; older apps keep
  working.

## 0.15.0

- Plugin settings, per circle: admins fill them in under the plugin's switch
  in Settings → Features (the app or the web page). They're kept on this
  server; secrets are never sent back to a phone.
- Air and pollen plugin: air quality from Open-Meteo (free, no key; needs
  outbound HTTPS to air-quality-api.open-meteo.com), for a 0.1° grid cell,
  kept 30 minutes. Pollen from Open-Meteo covers Europe; an optional Google
  Pollen API key (pollen.googleapis.com) covers most other places.
- Home Assistant plugin: each person becomes a device of Home Assistant's
  Mobile App integration (`device_tracker.homecircle_<name>`, which Home
  Assistant puts in your zones, plus battery and charging sensors). As this
  app, the address `http://homeassistant:8123` is filled in; you add a
  long-lived access token. Phones send their position to HomeCircle to pass
  straight on; nothing about where anyone is, is kept. Each person can turn
  theirs off. See the Documentation tab.
- Turning a feature off hides it everywhere on phones and the web page (SOS,
  the helper, the map and Places without location sharing).
- Needs the HomeCircle app 0.15.0 for the new tiles and Home Assistant.

## 0.14.0

- Plugins: optional parts of the server that a circle's admins turn on in
  Settings → Features → Plugins. A plugin can only call the outside hosts
  it declares, and answers only circles that have it on.
- Weather plugin: phones send a 0.1° grid cell (about 10 km); the server
  asks Open-Meteo (free, no account or key; needs outbound HTTPS to
  api.open-meteo.com) and keeps each cell 15 minutes. Who asked isn't kept.
- The helper keeps each chat's last 10 messages and its answers (sealed with
  its memory) and reads follow-ups with them: questions about a file just
  sent, or whose a calendar is ("this is my son's school calendar").
- Fixed: the helper's Memory showed "Something went wrong" once its notes
  outgrew one message (often after a dream). Big answers now go in parts
  (needs the HomeCircle app 0.14.0), and the helper may send more messages a
  minute than a phone.
- Needs the HomeCircle app 0.14.0 for the weather tile.

## 0.13.0

- Per-circle features: admins choose what each circle has; the server
  refuses what goes through it while off (chirps, Locate, most visited
  places, the helper, files). Existing circles keep everything on.
- Files for the helper: stored encrypted under the app's data (`files/`),
  up to 15 MB each, counted in the circle's storage; unkept files are
  deleted after 7 days, and all of them when the helper is removed.
  Requests may now take up to 2 minutes (uploads from slow phones).
- The helper: tags, shopping lists, long-term reminders (sent from 9 in the
  morning where the family is), receipts, photos, Word documents and sheets.
- Needs the HomeCircle app 0.13.0.

## 0.12.0

- The circle agent reads calendar PDFs (public links, including Google Drive
  and Dropbox share links, up to 15 MB). The text is read on this server and
  names are swapped out before the AI lists the dates; whoever sent it saves
  or discards them. A PDF is read again only when the file changes.
- Dreaming: admins ask "/<name> dream" (or tap Dream in the app's Memory) to
  have the agent sort, tidy, link and de-duplicate the circle's shared
  memory. One Undo takes it back.
- The web page: links in messages are clickable, and the agent's messages
  have Undo, Save and Discard.
- ws 8.22.0 (security fixes for the live connection).
- Needs the HomeCircle app 0.12.0 for Save, Discard and Dream on phones.

## 0.11.1

- Fixed: with Claude as the AI provider, the circle agent answered every
  question with an "Invalid schema" error from Anthropic. Errors from the
  provider now show its plain message instead of raw JSON.

## 0.11.0

- The circle agent (optional AI helper): switch on `run_agent`, and each
  circle's admin adds it in the app with their own AI provider key and a
  monthly budget. It can't read chats; its memory is encrypted in this app's
  data and deleted when it's removed.
- SOS and delivered/read ticks for the HomeCircle app 0.11.0; the web page
  shows each SOS on People with directions.
- Fixed: the web page could miss votes and messages sent just as it
  reconnected.
- Hardening: limits per phone, per circle and per address, signed message
  ids against replays, padded messages, and the real client address behind
  proxies.

## 0.10.0

- Polls on the web page: vote, see who voted, add an option, spin the wheel,
  close your own poll, and start one with the 📊 button. Polls are sealed like
  messages; the server only stores ciphertext.
- Needs the HomeCircle app 0.10.0 to vote from phones (older apps show a poll
  as text).

## 0.9.1

- The web page's chat folds more than 5 arrived/left alerts in a row into
  one "Movement" line; click it to see them all.

## 0.9.0

- Chirps: a short bird sound (and optionally a flash) on someone's phone, or
  everyone's in a circle. Three in a row, then a 30-minute break.
- Most visited places: each phone can share where it spends the most time,
  end-to-end encrypted like locations.
- Needs the HomeCircle app 0.9.0 for both.

## 0.8.2

- Load-test guardrails: the load-test server now runs in load-test mode (a
  red banner on its web page, and the swarm refuses any other server), at low
  CPU priority with a memory cap, so it can't slow down your family's server.

## 0.8.1

- Fixed: phones could drop out of their circle for good when the live
  connection was slow to log in (for example right after unlocking, or in the
  background). The server now tells them to retry instead.

## 0.8.0

- Lost your phone or signed out? The server's setup code gets you back in:
  rejoin your circle once a member approves, start a new circle, or delete an
  abandoned one. In the app: "Get back in with a setup code"; on the web page:
  "I set up this server".
- A generated setup code (when setup_code is empty) is now kept and shown in
  the log at every start, instead of changing on each restart.

## 0.7.2

- New: an optional load-test server (`load_test_server`) for stress-testing
  HomeCircle on your Home Assistant with a swarm of simulated people. It runs
  next to your real server with its own data, no push notifications, and is
  left out of backups. See docs/LOAD-TEST.md.

## 0.7.1

- Fixed: the map on the web page showed "403 Access blocked" tiles from
  OpenStreetMap instead of the map.

## 0.7.0

- First Home Assistant add-on: HomeCircle with built-in Tailscale Funnel.
