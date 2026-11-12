# Changelog

See the full list of changes on <https://homecircle.umair.us/#changelog>.

## 0.25.1

- The home base reports every minute, since it's plugged in or on solar.
  Settings → Circle → Trackers shows how it's doing: its power, Wi-Fi signal,
  uptime, GPS and how busy the radio channel is. Each tracker shows its
  battery and signal. The home base firmware in `devices/meshtastic` needs
  updating for this. The server doesn't.
- When an admin turns the Meshtastic plugin back on, the home base notices
  within a minute. While it's off, it no longer shows as offline.

## 0.25.0

- Meshtastic trackers, a plugin that's off until an admin turns it on. A home
  base (a Heltec V4 on your Wi-Fi) reads stock Meshtastic trackers such as the
  SenseCAP T1000-E and puts them on the map as a car or something a person
  carries. Locate asks the tracker for a fresh position, Chirp and check-ins
  make it beep, and arrive and leave alerts work for trackers too. A person
  whose phone goes quiet shows at the tracker they carry. Each position shows
  the radio path it took to the home base. The plugin's settings choose how
  long a phone stays quiet before the home base asks, how often the path is
  checked, and which words in a tracker's text mean SOS.
- Settings → Features: plugins are one section you open when you need it, with
  what's on shown at a glance.

## 0.24.1

- Three more of an elder's Urdu replies are recorded voices. No server change.

## 0.24.0

- The helper's memory is the family's. What you add is for everyone in the
  circle, including what you tell it in a direct chat, so anyone can ask about
  it. Tag people on any note or reminder, and choose who sees it: everyone,
  only the people tagged, or only you. Health notes stay private unless you
  share them. Photos, documents and calendars sent to the helper in a direct
  chat stay yours too, with a Share with the circle button on the reply. Say
  "keep that private" or "share that with Sara" after saving something. Private
  notes from before stay private; Memory offers to share them with one tap.
- Group calls in HomeCircle: phone to phone, up to six people, audio only. Join
  late, leave any time, and see who's on and who's talking. WhatsApp's call
  link stays as the fallback.
- Calendars: each person can share when they're busy from their phone's
  calendars, the times only and never what for. Suggest a plan in the group
  chat; everyone answers, and it goes into a calendar only when they tap Add to
  my calendar.
- Travel times: a person's sheet shows their usual trip, and you can ask the
  helper "how long does it take Nyel to get to EVHS?". The numbers are worked
  out on the phone.
- First setup happens on the phone. A new server's first page shows one QR code
  that installs the app and starts setup with everything filled in, so nobody
  ends up in the circle twice. The code is a one-time ticket that lasts 15
  minutes. Setting up in a browser is still there as a small link.
- Elders can call people themselves: a big Call button on each person, a moment
  to change their mind, and the same big call screen. Admins can turn it off.
- Calling: tap a call-back card to call back straight away (hold it for the
  replies), and hear a ring while your call goes out.
- Leaving a place and coming back within 3 minutes no longer shows either
  entry, so kids changing classes near the edge of school stop filling the chat.
- Fixed: on an elder's phone, only the first Urdu message was spoken and later
  ones were beeps. Every line is spoken now, and shown on her screen.
- Fixed: a shopping list's store tabs were cut off when the list was long.
- Needs the HomeCircle app 0.24.0 for group calls, calendars and tagging. Older
  apps keep working with this server.

## 0.23.0

A redesign that keeps every feature and makes each one easier to find and use.

- Tabs are now Map, Chats, Lists and Settings. Lists holds shopping lists,
  reminders and the helper's memory. Places open from the button on the map,
  and tapping a place's name on the map edits it.
- The map opens on the family near you. Anyone far away shows as a chip at the
  edge ("Nani · Lahore"); tap it to go there. Place names sit under their
  place and never cover a pin or another name.
- A person's sheet has three main buttons, Call, Message and Directions, with
  Locate, Check in, Alert me and Chirp below. The People list shows a setting
  that slows someone's updates as a tag ("Location limited", "Battery saver").
- Chats: Call in every direct chat; finished group calls are one line; the
  helper is marked as a helper; one + button holds photos, polls and Ask the
  helper.
- The helper: ask it from + or by starting a message with its name; no more
  "/name" commands (they still work). "Remembered" replies are one line with
  Undo. Its settings split into what everyone uses and a Set up page for
  admins. Dream is now "Tidy up memory".
- Lists: the shopping list comes first, with your usual items in one row.
  Reminders open to edit, with a calendar to pick the date. Places open to
  edit, and a new place starts where you are.
- First run starts with "Join my family" and asks for each permission when it
  is needed. Long explanations moved behind "How this works" links.
- One look everywhere: the same header, confirmations as bottom sheets, a
  floating + to add things, line icons in Settings. Larger, higher-contrast
  text, labels for screen readers, and SOS stays red in dark mode.
- The elder's "Ring everyone" tile now says it in her language.
- Needs the HomeCircle app 0.23.0. The server change is small: the wording of
  the helper's reply after tidying its memory.

## 0.22.4

- Elders can be called. Their phone listens for calls in the Elderly
  Companion skin too and rings with a screen made for them: the name they know
  the caller by, "calling you now" said in their language, one big answer
  button; on the line, the sound is on the speaker and there is one big
  hang-up button.
- Call on a person's sheet opens two buttons: Call in HomeCircle or Call on
  WhatsApp. A button that can't be used says why.
- Admins can set anyone's phone number (Settings → the circle → People →
  the person), not only an elder's. People lists everyone with their profile
  and number.
- Needs the HomeCircle app 0.22.4; no server change.

## 0.22.3

- Fixed: a voice call answered from the lock screen, or with HomeCircle
  closed or in the background, could stay on "Connecting" and never connect.
  The answering phone now waits until HomeCircle is on screen before opening
  the microphone, the caller sends its connection details again once the call
  is answered (details sent while the other phone was asleep could be lost),
  and an answered call that hasn't connected within 6 seconds sets up its
  connection again (up to 3 times). A call can no longer stay on
  "Connecting": it connects or ends with a reason within 30 seconds.
- Diagnostics show each step of a call (call:answer, call:ice).
- Needs the HomeCircle app 0.22.3 on both phones; no server change.

## 0.22.2

- WhatsApp group call: Start group call (the Group call button in the group
  chat) opens WhatsApp in the circle's call and sends an urgent sealed message,
  so every phone shows "started the group call · tap to join". The
  notification opens WhatsApp straight into the call, and each join adds a line
  to the chat. Starting while a call is on joins it. A call reads as over 30
  minutes after the last join. The link stays sealed in the circle record; the
  server sees only sealed messages.
- Elder phones hear "The family call has started. {name} is waiting for you."
  in Urdu, and one touch on the notification joins.
- Elder phones: the first 11 Urdu phrases are real recordings (her buttons,
  "your message was sent", "calling you now"); the rest still use the phone's
  own voice or tones until they're recorded.
- Needs the HomeCircle app 0.22.2; no server change.

## 0.22.1

- Fixed: tapping Call closed the app. The app now asks for the microphone
  before calling or answering, and the service that keeps a call going falls
  back to what Android allows instead of stopping the app.
- Fixed: switching a person between the full app, elder care and grandkids
  didn't always reach their phone. A phone now catches up on settings when it
  opens or reconnects, a closed app gets a silent push to follow, and admins
  see Waiting, then Updated. Settings records are sealed again after a key
  change so people who join later can read them.

## 0.22.0

- Voice calls (Settings → Features → Voice calls, off until an admin
  turns it on): call one person in the app. The voice goes phone to phone,
  encrypted; the server only passes the sealed set-up messages along and keeps
  none. Missed calls and call lengths show in the chat, and both people can
  compare four words to be sure nobody is in the middle. Optional relay for
  phones that can't reach each other directly (Cloudflare, Metered or your own
  coturn: see docs/CALLS-NOTES.md).
- WhatsApp links (a plugin, off until an admin turns it on): Call on WhatsApp
  on a person's sheet and on call-back cards, and a Group call button in the
  group chat. It opens WhatsApp on the phone. Phone numbers are sealed in the
  profile; the group call link is set by an admin.
- Asleep and Do Not Disturb: phones share (sealed) when they're in Do Not
  Disturb and what time it is for them. A family phone answers an elder's
  call-back request with "asleep" when its owner is, and rings quietly at
  night. An elder's tile fades with a moon while they sleep.
- Check-ins for elders: when an elder's phone hasn't been seen for a long
  while, the family is asked to check on them.
- SOS from an elder rings through Do Not Disturb on family phones that have
  allowed it (Settings → Chirps & SOS → Do Not Disturb access).
- Elder app: Urdu is spoken more reliably (it retries the phone's voice and
  falls back to the recordings), the top message clears after 2 minutes so she
  can ask again, the heart badge is gone, and only her newest request is
  reminded.
- Family chat: the person sheet is compact and leaves the map tappable, “What
  do you call …?” moved to Settings → Circle, pinch to zoom the chat text
  (85–200%, with a Reset chip; Settings → This phone), and reminders and
  call-backs are highlighted cards. Marking a reminder Done now closes it on
  every phone (needs this server version).
- Shopping lists: estimated prices (marked “~”, regular prices only), a
  quantity you set with +, and an estimate and cost range for the whole cart.
- Faster start: the chat opens on the newest messages, the cache is safer, and
  a cold start is quicker (the server now answers “newest messages” requests).
- Notifications: one per conversation, old messages stay quiet, an optional
  backup alert for Android phones that hold the wake-up back when locked, and
  push timing in Diagnostics. Other people's arrivals and departures no longer
  notify by default (a switch in Places; “notify me when” rules still work).
- Map: the People drawer and the tab labels fit large text, and the plugin tile
  starts as a small circle; double-tap it to step through small and big and
  back. The size is remembered on each phone.

## 0.21.0

- Photos: add your own photo in Settings → You → Profile. It shows wherever
  the app shows you, and on an elder's tiles. Admins can add a photo for
  someone's tile on her page (your own replaces it). Photos are encrypted on
  the phone; the server keeps only ciphertext.
- Elderly Companion settings: Settings → Circle → Elderly Companion → her
  name: her skin (and back to the full app), care or grandkids page, Ring
  everyone, Games, sleep hours, reminder interval, check-in time, language and
  he/she. People on her tiles: their order, her Urdu name for each, photos.
- Mark someone already in the circle as an elder; they stop being an admin.
- Family names: what you call each person ("Ammi", "Nani"), set by you, by
  them, or by an admin. Call-back cards and chats use your name for them.
- He or she in your profile, for the Urdu an elder hears.
- Her phone speaks Urdu with the phone's own voice until the recordings are
  made (needs an Urdu text-to-speech voice), and hides people whose profile
  it can't read yet.
- Fixed: removing the circle helper no longer deletes members' photos.

## 0.20.0

- Call-back requests: an elderly family member on the simple Elderly
  Companion screens asks the whole circle, or one person, to call her back.
  The request shows in the group chat; long-press (or tap) it to answer:
  calling now, in 5 minutes, in the morning or in the evening (her time).
  She hears the answer in Urdu. Until someone says they're calling now, the
  people asked get a reminder every 10 minutes from their own phone.
- Elderly Companion skin: Settings → Circle → Mark someone as an elder makes
  an invite that switches her phone to big tiles, Ring everyone and SOS
  (press and hold, to her care circle only), with no way back to the full
  app from her phone. Her requests wait for the internet if there's none.
  Her spoken lines are placeholder tones until the Urdu recordings are made.
- Urgent delivery: call-back requests and replies and SOS skip the
  45-second push batching and arrive at once. The push looks like any other;
  the server only learns that a message was marked urgent.
- Invites ask you to confirm the person is 13 or older.
- The web app shows call-back requests with reply buttons.

## 0.19.2

- Shopping lists: everything bought at a store (from receipts, order
  histories and Done shopping) is offered back to pick from, most often bought
  first, up to 300 per store (500 remembered). Before, an item had to be
  bought twice and only 8 were offered. Each new receipt adds what's new.
- The helper reads an order history or a list of what's bought at a store
  like a receipt, every page of it.

## 0.19.1

- Fixed: in 0.19.0 the circle helper answered every question with "The
  compiled grammar is too large". The format it asks Anthropic for is
  smaller again (a note's details are key and value pairs), and if a provider
  ever rejects the format, the helper asks once more for plain JSON instead
  of failing.
- Long recipes: the helper may write up to 8,000 tokens when it keeps or
  gives a recipe, a chat message may be up to 64 KB, and a long answer comes
  in parts.

## 0.19.0

- The circle helper keeps recipes, contacts, health notes, documents, trips
  and a home manual as their own kinds of note. Recipes and how-to steps are
  kept word for word, not summed up; each kind has its own folder in
  Download memory, and trips go in its calendar.
- Reminders follow from what's kept: before a document expires (6 months
  ahead for a passport, 60 days for anything else), a refill or vaccine date,
  and upkeep that repeats every few months. Reminders can now repeat every
  1 to 60 months.
- Health notes are private to the person who kept them unless they say
  they're for the circle.
- The helper never keeps a password, a door, alarm or gate code, a PIN, or a
  whole card, account, ID, passport or Social Security number: these are taken
  out on the server before anything is saved or sent to the AI provider, and
  only the last 4 digits of a number are kept. Phone numbers stay whole.
- A recipe's ingredients can be added to a shopping list.
- Needs the HomeCircle app 0.19.0 for editing places and the new note kinds
  in Memory; older apps keep working.

## 0.18.0

- Fewer wake-ups for chat: message notifications to the same person are
  combined for 45 seconds and replace each other, and say which circle they're
  for, so a phone fetches only that circle.
- Download memory: the circle helper zips everything a person can see of its
  memory as an Obsidian vault (notes, calendars as .ics, shopping lists,
  reminders and kept files), encrypts each part and leaves it for their phone.
  Parts are deleted within the hour and don't count against the circle's
  storage.
- Phones on 0.18.0 report how often they update, shown under each name.
- Needs the HomeCircle app 0.18.0 for the battery settings and Download memory;
  older apps keep working.

## 0.17.0

- New plugin, Prayer times (off until an admin turns it on in Features): the
  server works out the five daily prayers for a grid cell itself, for the
  madhab the phone asks for, and asks Open-Meteo only for the cell's time
  zone (kept a week). Fajr and Isha follow the region's usual method, picked
  from the time zone; Hanafi Asr uses the two-shadow rule; Shia use the
  Ja'fari method. Maghrib is 3 minutes after sunset. Checked against
  Evergreen Islamic Center, San Jose's 2026 timetable.
- Needs the HomeCircle app 0.17.0 for the tile; older apps keep working.

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
