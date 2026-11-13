# HomeCircle protocol

A HomeCircle server hosts one or more **circles** (for example your household,
and your parents and siblings). Only people who joined a circle can see each
other, and circles on the same server are isolated from one another: each has
its own members, encryption key, invites, places, locations and messages, and
every API request is scoped to the circle of the device that makes it. The
server stores and relays data it cannot read: every location, chat message,
place and profile is end-to-end encrypted on the phone before it is uploaded.

The first circle is created with the server's setup code. Its owner becomes a
**server admin**, who can create more circles (`POST /circles`) and owns each one.
A phone in several circles holds a separate identity and key ring per circle,
so the circles can't read each other even through a shared device account.

## Threat model

| Party | Can see | Cannot see |
|---|---|---|
| Your server / hosting provider (Render, Railway, Hetzner, …) | number of circles and members, IP addresses, when each phone uploads, ciphertext sizes, push tokens (and so which members share a phone), which messages their sender marked `urgent` (call-back requests and replies, SOS) and when, that a member sent a call set-up message to another member (and whether it was a ring) and when, which members opted in to the Android backup alert, which members have admin settings (a `member` record) and which pairs have a family name (an `alias` record, never the name), and how many photos each member uploaded and their sizes | names, locations, messages, places, battery, what an urgent message is or why, skins and settings, family names, photos |
| Network attacker | nothing beyond TLS metadata | everything else |
| Apple / Google / Expo push relay | that a push was sent to a device, and its type (`loc_req`, `msg`, `call`, `rec`); urgent messages are pushed at once rather than batched, so their timing is less bunched | any content (an urgent push is identical to any other) |
| Map tile provider (OpenStreetMap by default) | which map area you *view*, and your IP | who you are tracking or why |
| A removed member | everything up to their removal | anything after the key is rotated |

Not covered: a compromised phone, and a malicious server *combined with* a
removed member forging old-epoch data during a rotation window (mitigated by
fingerprint verification, see below).

## Primitives (TweetNaCl)

- `secretbox` – XSalsa20-Poly1305, 24-byte random nonce, used with the circle key.
- `box` – X25519 + XSalsa20-Poly1305, used to deliver a new circle key to one member.
- `sign` – Ed25519, used so members can't impersonate each other.
- `hash` – SHA-512, used for domain-separated key derivation (`H(label ‖ secret)[0..32]`).

## Keys

| Key | Where it lives | Purpose |
|---|---|---|
| Circle key `CK_e` (32 bytes, epoch `e`) | every member's phone (keyring of all epochs) | encrypts everything shared |
| Member box keypair | that member's phone | receive rotated circle keys |
| Member signing keypair | that member's phone | sign everything they send |
| Device token (32 random bytes) | phone; server stores SHA-256 | authenticate API calls |
| Setup token | server env `SETUP_TOKEN` | lets the first person create the first circle |

## Sealed envelope

Everything shared uses one format:

```
plaintext = JSON { v:1, kind, from, circle, epoch, ts, body }
signed    = Ed25519.sign(plaintext, sender.signSecret)        // attached signature
envelope  = { epoch, nonce, ct = secretbox(signed, nonce, CK_epoch) }
```

The recipient opens the secretbox with `CK_epoch`, verifies the signature with
the sender's signing key *taken from that sender's trusted profile*, and checks
`kind`, `from` and `circle` match what the outer request claims. This prevents
the server from replaying a chat message as a location, or one member's data as
another's. The signature is inside the ciphertext, so the server can't even
tell who signed what beyond its own routing metadata.

Kinds: `profile`, `location`, `chat`, `event`, `place`, `circle`, `frequent`, `member`, `alias`.

## Profiles and trust

A member's profile is a sealed `profile` envelope containing their name, colour,
box public key and signing public key. A profile is **self-signed**: the
signature is checked against the signing key inside it, and only accepted when
the outer `boxPub` / `signPub` the server lists match the sealed ones.

Because a profile can only be produced by someone who holds the circle key, the
server cannot inject a fake member with its own keys. Members can also compare
**safety numbers** (a fingerprint of a member's public keys) in person.

## Setup (first boot)

1. Server starts. If `SETUP_TOKEN` is unset it generates one and prints it in the logs.
2. The owner's app generates keys and `CK_1`, then calls `POST /api/v1/setup`
   with the setup token, their public keys, sealed profile and sealed circle
   info (circle name). The server records them as `owner` and returns a device token.
3. The setup endpoint is permanently closed after this.

**Setting up from the phone (0.24.0).** A new server's first page sends the setup code to
`POST /setup/ticket` and draws the ticket it gets back as a QR code: `https://<server>/start#t=<ticket>`.
After the `#`, it never reaches the server or its logs. A ticket is 8 characters, works for 15
minutes, replaces any earlier one, is kept only in memory, and works only in place of the setup
code on `POST /setup` for the first circle. `POST /setup/ticket` with a ticket checks it. The
page on the phone offers the app, then opens it with `intent://setup?server=…&t=…`.

## Invites

```
S          = 32 random bytes                    (never sent to the server)
inviteAuth = H("homecircle/invite-auth" ‖ S)    (sent by the joiner to prove they hold S)
wrapKey    = H("homecircle/invite-wrap" ‖ S)
wrapped    = secretbox({ circleKey: CK_e, epoch: e, circle }, wrapKey)
link       = https://your-server/join#<inviteId>.<base64url(S)>
```

The admin uploads `inviteId`, `SHA-256(inviteAuth)`, `wrapped`, and an expiry.
The part after `#` is never sent to a web server by browsers, and the app sends
only `inviteAuth`. Invites are single-use, expire (default 48 h), and are all
revoked when the key rotates.

Join: `POST /join/preview {inviteId, inviteAuth}` → `wrapped`; the joiner
decrypts it, generates keys, seals a profile, then `POST /join` consumes the
invite and returns a device token.

**An elder's invite** (Settings → Circle → Mark someone as an elder) adds
`companion: { name, page, skin }` inside `wrapped`: the name the family gave
her, whether this circle is her `care` or `grandkids` page, and the skin her
phone shows (`elderly` today). Her phone joins under that name, so nobody
types on it, and switches to that skin as it joins. The server sees the same
`wrapped` box as for any invite. Invites can last up to 168 hours; an elder's
lasts 7 days, so a helper near her has time to set up her phone. The inviter
confirms in the app that the person is 13 or older.

## Removing a member and rotating the key

1. An admin calls `DELETE /members/:id` (or a member leaves). Their token is
   revoked immediately and the circle is marked `rotationNeeded`.
2. An admin's app generates `CK_{e+1}`, and for every remaining member creates
   `box(CK_{e+1}, nonce, member.boxPub, admin.boxSecret)`, then posts all of them
   to `POST /keys/rotate`. The server requires one envelope per active member.
3. Every member fetches `GET /keys/envelopes`, opens theirs with the admin's
   trusted box key, adds `CK_{e+1}` to their keyring, and re-publishes their
   profile under the new epoch. Outstanding invites are revoked.

## Signing in a browser from the phone (0.29.0)

A member already in a circle on their phone can sign in the web app as
themselves, without an invite or the setup code:

1. The web page makes a one-time box key pair `(B, b)` and calls `POST /link
   { boxPub: B, label }` (public). The server keeps `{ B, label }` under a
   random link id for 5 minutes, in memory only. The page shows
   `homecircle://link?server=…&l=<id>&k=<B>&n=<label>` as a QR code.
2. The phone scans it, shows the label ("Chrome on macOS"), and on the
   person's OK makes its own one-time pair `(P, p)` and sends
   `POST /link/:id { sealed: box({ v: 1, account }, nonce, B, p), from: P }`
   with its own token. `account` is the circle's account without the token:
   identity keys, keyring, pinned keys, profile.
3. The server creates a session for that member (a token of the browser's
   own, kept as a hash) and hands `{ token, sealed, from }` to the page once,
   on its next `GET /link/:id`. The page opens `sealed` with `b` and is that
   member from then on.

The key `B` reaches the phone in the QR code, not from the server, so the
server can't swap in its own and read the account; it only passes the sealed
box on. A browser's token is separate from the phone's: `GET /sessions` lists
a member's browsers and `DELETE /sessions/:id` signs one out (`current` is the
browser asking). Removing a member deletes their sessions. A browser doesn't
count as the member being online (the phone still gets its pushes, location
requests and chirps), its reads don't move the phone's delivered ticks, it
can't change the phone's push token, and a browser "leaving" only signs itself
out.

## Live connection

Open apps keep one WebSocket per circle at `/api/v1/ws`. The first frame is
`{type:"auth", token}` (so the token never appears in a URL or access log); the
server answers `{type:"ready"}` and then relays events. It pings every 25 s and
clients answer `{type:"pong"}`.

The server closes the socket with these codes:

| Code | Meaning | What the app does |
|---|---|---|
| 4000 | No auth frame within 10 s (a slow or paused phone) | Reconnect |
| 4001 | The token isn't valid: the member was removed, the circle deleted, or the server doesn't know this device | Check with `GET /state`. If that works, reconnect. If it also answers 401, keep the keys and ask the person whether to remove the circle from the device. |
| 4002 | The first frame wasn't an auth frame | Reconnect |
| 1001 | Server shutting down | Reconnect |

Devices only delete their keys on an explicit `{type:"removed"}` for
themselves or `{type:"circle_deleted"}`, or when the person chooses to.
Deleting keys can't be undone, and a server that lost or misplaced its data
answers 401 just like one that removed you. (Servers before 0.8.1 sent 4001
for timeouts too, and apps before 0.8 deleted their keys on any 4001.)

## Location

- Each phone keeps only its **latest** sealed location on the server
  (`PUT /locations/me`). There is no server-side history.
- Default schedule: a background upload about every **15 minutes**, plus on
  significant movement (>500 m) and when entering/leaving a place.
- **Request a location** ("Sync now"): `POST /locations/request` → the server
  sends a WebSocket message to target phones that are open, and a content-free
  silent push (`{t:"loc_req"}`) to the rest. The target phone takes one fresh
  GPS fix and uploads it; the requester gets it live over WebSocket.
  Requests are rate-limited per requester (default 60 s) to protect batteries.
- Viewers never poll: the app fetches all latest locations once when opened and
  then listens on a WebSocket only while it's in the foreground.
- Joining a circle means agreeing that its members can see your location and
  request it at any time (the app asks for this consent before joining).
- **Pausing** replaces your latest location with a sealed `location` envelope
  whose body is `{ "paused": true, "reason"?: "…" }`, so the circle sees that you
  paused (and why, if you said) rather than an old position. Phones in several
  circles choose per circle.
- **Approximate sharing** rounds the position to a ~1 km grid on the phone,
  before sealing, and marks the body `approx: true` (no place id). The exact
  position never leaves the phone.
- **Low battery**: at 10% and 5% the phone sends one update with
  `trigger: "low_battery"`.
- **Locate cooldowns** are per requester and target, separate from "refresh
  everyone", so asking one person never blocks asking another. On top of the
  60 s cooldown, each requester can ask the same person at most 6 times an
  hour. The response includes `delivery: { <memberId>: "delivered" |
  "pushed" | "unreachable" }` (open WebSocket, silent push sent, or neither),
  which the app shows as Locate progress. It reveals nothing the server didn't
  already know.
- **Phone health**: the sealed location body may carry `power` (`"saver"` /
  `"normal"`), `perm` (`"always"` / `"foreground"`) and `precise` (boolean),
  so the circle can see why someone's updates are late. Like everything else
  in the body, the server can't read them.
- **Place events are retried, never duplicated**: an arrive/leave event is
  queued on the phone with a fixed message id and re-sent until the server
  accepts it. The server rejects a repeated id with `409`, which the phone
  treats as delivered.
- **Diagnostics** (what woke the phone in the background, uploads, failures)
  are kept for 7 days on the phone only, encrypted with a key in the OS
  keystore. They leave the phone only when the user sends them, as a direct
  message.
- **Asleep and Do Not Disturb (0.22.0)**: the sealed location body may also
  carry `dnd: true` (the phone is in Do Not Disturb), `tz` (its IANA time
  zone, so others can tell the local time) and, on an elder's phone, `used`
  (when she last used the app, for the inactivity check). A family phone
  that sees a call-back request while its owner is asleep or in Do Not
  Disturb sends the reply `asleep` for them (see Chat and events). Like the
  rest of the body, the server can't read any of it.
- **Skin acknowledgement (0.22.1)**: the body may carry `skin` (`full` or
  `elderly`) and, in the Elderly Companion, `page` (`care` or `grandkids`):
  what the phone is showing. It lets an admin who switched someone see that
  their phone followed ("Updated"), or that it hasn't yet ("Waiting…").
- **Check-ins** are direct messages whose sealed body carries
  `checkin: "request"` or `"ok"`; asking also sends a location request to that
  one person.

## Chat and events

`POST /messages` stores a sealed `chat`, `event` or `reaction` envelope (place
arrivals, "left school"…). The server can't tell them apart. It assigns a
sequence number, broadcasts over WebSocket, and sends a content-free push to
members who aren't connected.

**Direct messages** carry `to` (a member of the same circle). They're sealed
like any envelope, but the secretbox key is the pair's **direct key**:
`KDF("homecircle/direct-v1", X25519(my box secret, their box public key))`, which
only those two phones can compute. The signed plaintext includes `to`, so a
DM can't be passed off as a group message or redirected to someone else. The
server stores `to_id` in the clear (it routes the message) and only returns a
DM to its sender and recipient. Reactions to a DM are DMs too.

**Call-back requests** come from a phone in the Elderly Companion skin.
A request is a group `chat` message whose sealed body carries
`callback: { state: "ask", for, tz, awake, remind }`: `for` is `null`
(everyone in the circle) or one member id, `tz` her time zone, `awake`
whether it's outside her sleep hours, and `remind` the minutes between
reminders on the family's phones (`0` for none). Replies are group `chat`
messages with `callback: { state: "reply", of, reply }`, where `reply` is
`now`, `5min`, `morning` or `evening` (her time), or `asleep`, which a family phone sends by itself when its owner is asleep or in Do Not Disturb (it doesn't take or close the request). The first `now` in server
order takes the request and closes it for everyone; a reply from the asker
herself, or sent as a direct message, doesn't count. Each family phone
schedules its own reminders while a request that asks it is open and it
hasn't replied, so the server never learns about reminders. Both carry a
readable `text` for older apps.

**Reminders done.** The circle helper's confirmation that a reminder is done
carries a body field `reminderDoneId`, sent to everyone who got the reminder,
so their reminder cards close too. Older apps show the line as text.

**Fetching history.** `GET /messages?tail=1&limit=n` returns the newest `n`
messages (group, and your direct ones); `?before=seq&limit=n` the `n` newest
below `seq`. `?after=seq` still returns what's new. This lets an app open on
the newest messages and fetch older ones as you scroll.

**Phone numbers and WhatsApp.** A profile may carry a sealed `phone` (an
international number, normalised to digits), used only to open WhatsApp on the phone of
someone who tapped Call on WhatsApp, and the circle record may carry a
`groupCallLink` (a WhatsApp group call link, `/video/…` or `/voice/…`, set by an admin). Both are
behind the circle's WhatsApp feature (`whatsapp`, off by default). The app
only opens WhatsApp; nothing reaches the server.

**Urgent messages.** `POST /messages` takes an outer `urgent: true`
(routing metadata, like `to`) on call-back requests, replies to them and SOS
start and safe. Its push goes at once instead of waiting out the server's
45-second batching of chat pushes, and stands in for any batched one still
waiting; the push itself is the same as any other. Past 10 urgent messages
a minute from one sender, the rest are delivered like ordinary messages,
never refused.

**Records** are sealed settings the server keeps one copy of per kind and
subject, written by admins or the people concerned and read by every member
(`GET /records`, `PUT` and `DELETE /records/:kind/:subject`):

- `member`, subject a member id: admin settings about that member: which
  skin their app shows (`full` or `elderly`), and for an elder her page
  (`care` or `grandkids`), Ring everyone, Games, tile order, photos an admin
  added for her tiles, sleep hours, reminder interval, inactivity check-in,
  language and he/she, and for a tracker how it reports (`tracker: { mode:
  "car" | "carried", moving, still, quiet: { from, to } | null, sos, node,
  carriedBy }`,
  minutes between reports while moving and while still). Only admins may
  write one, and phones accept it only if an admin signed it.

**Tracker devices** (`devices/tracker`) are small ESP32 boards that join a
circle with an ordinary invite and speak this protocol themselves: a sealed,
self-signed profile; sealed `location` envelopes (with `app: "tracker"` and
`skin: "tracker"`); SOS as urgent group `chat` messages; their own `member`
record for settings; new circle keys only from an admin whose profile they
verified before. They have no push token and sleep between reports, so a
Locate request reaches them at their next report.
- `alias`, subject `caller.member`: a family name, what one member calls
  another ("Nani"), with an optional relationship. Either of them or an admin
  may write it, and phones accept it only from one of those. Names are per
  pair, so the same person can be "Nani" to one grandchild and "Dadi" to
  another.

A change to a `member` record (and its deletion) also sends that member a
silent, content-free push `{ t: "rec", c }` (never to the writer), so a
phone that is closed or whose live connection is down fetches the records
and follows a switch between the full app, the care page and the grandkids
page. Phones also fetch the records whenever they reconnect or come back to
the app. After a key rotation the admin who rotated seals every record it
can read again under the new key, so members who join later can read them.

The server checks who may write from the ids alone and can't read a record.
Phones also check that the ids sealed inside match the subject, so a record
can't be moved to another member or pair. A removed member's records are
deleted with them. A phone takes its skin from the `member` records about
its own person (the most restricted across its circles); an elder's phone
announces itself in the group chat (`elderJoined`), and an admin's phone then
saves her settings as a `member` record.

**Photos** are files encrypted on the phone with a key of their own
(`POST /files?purpose=photo`, up to 2 MB, 40 per member, behind the circle's
Photos feature). The key travels only inside a sealed profile (your own
photo, as `photo: { id, key, at }`) or a `member` record (photos an admin
adds for an elder's tiles). Photos are kept until replaced or until whoever
uploaded them leaves; removing the circle's helper deletes only its own
files. Profiles may also carry `g` (`m` or `f`), a member's he/she for
languages whose verbs need it.

**Retention.** Each circle keeps messages (group and direct) for 1, 7, 30, 90
or 365 days, chosen by its admins (`PUT /circle/retention`, default 90).
Nothing is ever kept longer than a year; `MESSAGE_RETENTION_DAYS` can only
lower that cap. Expired messages are deleted from the server hourly.

## Voice calls (0.22.0, off until an admin turns on the `calls` feature)

A call is between two members of one circle. The voice is WebRTC (DTLS-SRTP,
Opus), phone to phone; the server never carries it unless a relay is used.

- **Signals** (ring/offer, answer, ICE candidates, hang-up, busy, decline)
  are sealed envelopes of kind `call`, sealed with the pair's direct key and
  signed like any other, so the server can neither read nor alter them. They
  are not messages: `POST /calls/signal` `{ to, id, epoch, nonce, ct, ring? }`
  (the envelope at most 16 KB) relays one and **never stores it**. If the
  recipient has an open WebSocket it gets `{ type: "call_signal", from, id,
  env, at }`; otherwise the signal waits in server memory for 45 seconds (64
  per member, 2,000 in all) and is fetched with `GET /calls/pending`, which
  also removes it. A signal flagged `ring: true` (the first offer of a call)
  also sends a content-free high-priority push (`{ t: "call" }`), even to a
  phone that looks connected.
- **Limits**: 90 signals a minute per sender, 6 rings a minute per sender and
  3 a minute per sender and recipient; past that `429` with `retryAfter`.
- **Connecting**: `GET /calls/config` returns `{ iceServers, relayOnly? }`:
  STUN servers, and if the admin configured a relay, a TURN entry with
  short-lived credentials (Cloudflare or Metered keys, or a coturn shared
  secret: `username = expiry:hash`, `credential = HMAC-SHA1`). The app uses
  the relay only when a direct connection fails (always, with
  `CALLS_RELAY_ONLY`). See `docs/CALLS-NOTES.md`.
- **Checking nobody is in the middle**: both phones show four words derived
  from the two DTLS fingerprints; the people compare them aloud.
- The server learns who sent a call signal to whom, when, and how big;
  not the answer, the codec, the addresses inside the offer, or how long the
  call lasted. A relay, if used, sees encrypted media packets and the
  phones' IP addresses.

**Missed calls and length.** After a call, the caller's phone sends an
ordinary sealed direct message with a body `call: { state: "missed" }` or
`call: { state: "ended", seconds }` (plus readable `text`), which the app
shows as a line in the chat. A missed one notifies; an ended one is silent.

## Group calls (0.24.0, with the `calls` feature)

A group chat message `{ groupCall: { state: 'start', mesh: true } }`, sent urgent, starts a
call in HomeCircle. `{ state: 'join', of }` and `{ state: 'leave', of }` say who's on it; the
call is on while someone is (at most four hours after the last join, for phones that vanished).

Phones connect directly, up to six. Whoever joins sends `m-offer` to everyone on the call;
the others answer with `m-answer`, and `m-ice` carries candidates, all as ordinary sealed call
signals. `m-bye` says a phone left. If two phones call each other at once, the lower member id's
call stands. If a phone hears of someone joining and isn't called within 3 s, the lower id calls.
Only the phone that called restarts a dropped connection.

## Busy times and plans (0.24.0)

`PUT /busy/me` stores one sealed envelope of kind `busy` per member: `{ blocks: [{ s, e }] }`,
start and end in ms for the coming 14 days. Nothing else is in it, and each person turns it on
for themselves. `GET /busy` lists the circle's; a `busy` event says one changed.

A plan is a group chat message with `body.plan` `{ title, start, end, allDay, where }`. Answers
are reactions `{ target, rsvp: 'going' | 'maybe' | 'no' }`, and whoever made it can send
`{ target, cancelPlan: true }`.

When someone asks the helper about travel or free time, the message to it may carry
`travel` (per person and route: trips counted, usual, low and high minutes, usual leaving and
arriving times, weekdays or not, the recent trend) and `busyDays` (`{ who, days }`), worked
out on the phone. The helper has no circle key and sees nothing else about movement.

## Places

Places (Home, School…) are sealed `place` envelopes. Each phone registers them
as OS geofences locally, so arrival/departure is detected on the device, never
on the server. A geofence report is only a hint: the phone confirms it with a
fresh GPS fix, and needs a margin beyond the radius (scaled by the fix's
accuracy) before counting someone as gone. Regular location updates run the
same check, catching crossings the OS missed. A place can be added to several circles at once: each circle
gets its own sealed copy, linked by a random `group` id inside the envelope,
and the phone watches it once and posts the arrival or departure to every
circle that has it. Addresses are looked up with the phone's own geocoder
(Google on Android, Apple on iOS) and stored only inside the envelope.

## Mesh packets (trackers on a Meshtastic mesh)

A HomeCircle tracker with a LoRa radio (`devices/meshtastic`) that has no
internet sends its location and SOS as one Meshtastic packet each, on the
`PRIVATE_APP` port, usually on a private channel named `HomeCircle`. A home
base, a Meshtastic node attached to the server (`MESH_NODE`) or to a bridge
at home (`server/scripts/mesh-bridge.mjs`), hands them to
`POST /mesh/packets`. Nobody but the circle can read them: not the mesh,
not the home base, not the server.

```
0   2  "hc"           2  1  version 1       3  1  type: 1 location, 2 SOS start, 3 SOS safe,
                                                       4 group message, 5 direct message
4   8  sender ref = SHA-512("homecircle/mesh-ref" ‖ member id)[0..8]
12  4  counter (LE; only goes up)          16  2  epoch (LE)
18  12 message id (all but locations: the same id as the same message sent over the internet)
30  8  recipient ref (direct messages only): their mesh ref, for the server to deliver it
…      secretbox(content ‖ Ed25519 signature, nonce, CK_epoch)
       nonce = SHA-512("homecircle/mesh-nonce" ‖ header)[0..24]
-8  8  tag = HMAC-SHA-512(sender's mesh key, everything before)[0..8]
```

- **Content:** a location is `ts` (u32 seconds), `lat` and `lng` (i32,
  1e-7°), `accuracy` (u16 m), `speed` (u16 cm/s), `battery` (u8 %) and flags
  (charging, SOS on): 18 bytes, 124 with the rest. An SOS start is `ts`; an
  SOS safe is `ts` and the id of the SOS it ends.
- **Messages from a phone over the mesh** (types 4 and 5): with no internet,
  or when the person asks for it, the app seals a short message itself and
  sends it over Bluetooth to the Meshtastic tracker that person carries. The
  tracker broadcasts it as a `PRIVATE_APP` packet on its primary channel, and
  a home base hands it in like any other.
  - Content is `ts` and the text in UTF-8, at most 99 bytes for a group
    message. The tracker addresses it to the home base (its node id is in
    the home base's status) with `want_ack`, so Meshtastic retries it and
    learns the next hop. That costs Meshtastic's 12-byte PKI overhead, which
    leaves 221 bytes per packet.
  - A direct message's text is sealed again: `secretbox(text,
    SHA-512("homecircle/mesh-direct" ‖ header)[0..24], DK)` with the
    two members' direct key. That leaves 75 bytes, and the rest of the circle
    can't read it.
  - The server finds the recipient from the ref after the id, stores it as a
    direct message, and sends it to that person only. The body is
    `{ text, via: "radio" }`, and the apps mark it as sent over the mesh.
  - The phone registers its mesh key while online (`PUT /members/me/mesh`).
    Its counter is the time in seconds, or one more than the last.
- **The signature** covers `"homecircle/mesh-v1\0" ‖ circle ‖ "\0" ‖ member ‖
  "\0" ‖ header ‖ content`, so a packet can't be moved to another circle,
  member, type or epoch. Apps check it with the sender's verified signing key,
  exactly as for any envelope.
- **The tag and counter** are for the server, which can't check signatures.
  A tracker registers a random 32-byte mesh key over HTTPS
  (`PUT /members/me/mesh`, when it joins). The server stores a packet only if
  its tag matches that key and its counter is higher than any before, so
  nobody else on the mesh can fill or replay a tracker's location.
- **Stored** as `{ epoch, mesh }` (a location) or a message with that
  envelope (an SOS, pushed as urgent; a phone's group or direct message). The same SOS arriving over the internet
  and the mesh is one message. Apps before 0.25 can't open these and skip them.

### A home base (stock Meshtastic trackers)

Stock Meshtastic trackers can't seal anything for the circle. A **home base**
is a member of the circle on a Meshtastic node with Wi-Fi
(`devices/meshtastic`, `hc::HomeBase`). It holds one more identity for each
tracker: an ordinary member, named by an admin, joined with an invite the
home base makes as an admin. When it hears a tracker's position on the
private `HomeCircle` channel, it seals it as that member's `location`, with
`via: "radio"`, `app: "meshtastic"`, and the time the fix was taken.

- **Who can read it:** the home base and nodes with the channel key, besides
  the circle; the server still can't.
- **Admins drive it in direct messages:** `list`, `add !nodeid Name [as car]`,
  `rename`, `link Name to Person`, `unlink`, `remove`, `channel` and `status`.
  It answers in the same conversation, and only admins may change trackers.
- **The tracker's member record** (`tracker.node`, `tracker.carriedBy`,
  `tracker.mode`) is signed by the home base as an admin. It tells the apps
  whose tracker it is.
- **When the person who carries a tracker goes quiet,** the home base asks
  the tracker for a position over the mesh (a Meshtastic position request).
  Their phone counts as quiet when its latest sealed location is older than
  the longer of 30 minutes and twice its "still" interval plus 5 minutes.
  This doesn't happen while they've paused sharing.
- **A tracker's text** containing "SOS" (or the alert bell) is sent as an SOS
  from that tracker; "ok" or "safe" ends it.
- **Requests for a tracker.** A tracker names its keeper, the home base
  (`PUT /members/me/keeper`). After that the server queues requests for it in
  memory, and the home base collects them (`GET /keeper/pending`):
  - Locate on the tracker. The delivery shows as "pushed".
  - A chirp to it.
  - A direct message to it, which is how "Ask to check in" travels.

  The home base asks the tracker for a position, makes it beep (a text with
  the alert bell), and answers check-ins with `checkin: "ok"` when the tracker
  sends "ok". The server learns which member keeps which, but nothing more.
- **Its own status:** the home base is on mains or solar power, so every
  minute it writes the member record about itself:
  `homeBase: { at, every, quietMinutes, self, gps, heard, trackers }`.
  - `every` is how often it reports, in seconds. The app shows it offline
    after three missed reports (at least 5 minutes). Older home bases
    reported every 5 minutes without `every`.
  - `self: { battery, volts, plugged, wifi, up, heap, ch, tx }` covers its
    power, Wi-Fi signal in dBm, uptime in seconds, free memory in KB, how
    busy the LoRa channel is, and its own airtime (both in percent).
  - `gps: { fix, sats, hdop }` covers its own GPS.
  - `heard: [{ node, name, at, hops, snr, battery, plugged, volts }]`
    lists the nodes it hears, with each node's telemetry.
  - `trackers: [{ node, member, at, radio }]` lists its trackers: `at` is
    the last position on the map, and `radio` has the same fields as a
    heard node.

  It's sealed like any record, and the app's Trackers screen reads it. It
  reuses the rest of the record for 10 minutes between full reads, so a
  status is one write.
  - `key` is the home base's Meshtastic public key (base64).
  - Each tracker's `settings` is `"set"`, `"sending"` or `"needs-key"`: the
    tracker doesn't list that key as an admin key yet.
- **Tracker settings:** every tracker follows the Meshtastic plugin's
  settings: `movingMinutes`, `stillMinutes`, `batteryMinutes` and
  `press1`…`press5`, where empty means the default. One tracker can differ
  through its member record:
  `tracker.custom: { moving, still, battery, presses: { "1"…"5": text } }`,
  holding only what differs from the circle.
  - The home base puts the intervals on the tracker with Meshtastic remote
    admin. Those are PKI-encrypted admin messages: it reads the device,
    position, telemetry and external-notification configs (whose answers
    carry the session key), then sets them inside one edit.
  - The tracker's acknowledgement of the commit means the settings are on
    it. They're sent only when HomeCircle's settings change.
- **Button presses:** the HomeCircle T1000-E build sends `#press N` (1 to 4)
  as a text on its primary channel, with its position for 2 to 4. 5 presses
  send the SOS text.
  - The home base posts the message for N to the circle's chat as the
    tracker. 3 and SOS are urgent.
  - 1 press only answers a waiting check-in.
- **Arrived and left:** the home base reads the circle's places and checks
  each tracker position with the apps' rule. It sends the same
  `{ type: "place", action, placeId, placeName, at }` events a phone sends.
- **The radio path:** the home base runs a Meshtastic traceroute when someone
  locates a tracker, and every 30 minutes. The sealed location then carries
  `mesh: { hops, at, path: [{ id, name, snr, lat, lng }] }` (a relay's position, rounded to ~100 m, when it has said where it is), listing the nodes from the
  tracker to the home base, each with the signal it was heard with.

## API summary (`/api/v1`, Bearer device token unless noted)

| Method | Path | Notes |
|---|---|---|
| GET | `/info` | public: version, whether setup is done |
| POST | `/setup` | public + setup token, once |
| POST | `/setup/ticket` | public + setup token or ticket, until the first circle exists |
| GET | `/busy` | |
| PUT, DELETE | `/busy/me` | |
| POST | `/join/preview` | public + invite auth |
| POST | `/join` | public + invite auth |
| GET | `/state` | circle info, members, current epoch, rotationNeeded, retention |
| POST | `/circles` | server admin: create another circle |
| DELETE | `/circle` | owner: delete the circle |
| PUT | `/circle/retention` | admin: `{ days: 1 \| 7 \| 30 \| 90 \| 365 }` |
| GET / POST | `/messages` | group messages + your DMs; `to` makes a DM; `urgent: true` skips push batching (10 a minute per sender) |
| PUT | `/members/me/profile` | re-seal profile |
| PUT | `/members/me/push` | register push token; `fallback: true` (Android) opts in to one generic visible backup alert if the phone hasn't fetched a message soon after its wake-up (12 s, 4 s for urgent) |
| DELETE | `/members/:id` | admin, or yourself (leave; a linked browser only signs itself out) |
| POST | `/link` | public: a browser starts a sign-in `{ boxPub, label }` → `{ id, expiresAt }` |
| GET | `/link/:id` | public: `waiting`, or once `{ state: 'linked', token, sealed, from }` |
| POST | `/link/:id` | the phone answers: `{ sealed, from }` |
| GET | `/sessions` | your linked browsers |
| DELETE | `/sessions/:id` | sign out a browser (`current`: this one) |
| POST | `/members/:id/role` | owner: promote/demote admin |
| POST/GET/DELETE | `/invites` | admin |
| POST | `/keys/rotate` | admin |
| GET | `/keys/envelopes` | your rotated keys |
| GET / PUT | `/locations`, `/locations/me` | latest sealed locations |
| PUT / DELETE | `/members/me/mesh` | a tracker's mesh key `{ key }` (32 bytes) |
| POST | `/mesh/packets` | public: up to 20 mesh packets a home base heard; each proves its sender (Mesh packets) |
| PUT / DELETE | `/members/me/keeper` | a tracker names the home base that keeps it `{ keeper }` |
| GET | `/keeper/pending` | a home base collects Locate, chirps and direct messages waiting for its trackers |
| GET | `/records` | sealed member settings and family names (`?kind=member` or `alias`) |
| PUT / DELETE | `/records/:kind/:subject` | `member`: admins; `alias` (`caller.member`): either of them or an admin |
| POST / GET / DELETE | `/files`, `/files/:id` | encrypted files; `?purpose=photo` for a member's photo (kept) |
| POST | `/locations/request` | ask phones for a fresh fix |
| GET / POST | `/messages` | `?after=seq&limit=n`; `?tail=1&limit=n` newest; `?before=seq&limit=n` older |
| POST | `/calls/signal` | feature `calls`: relay one sealed call signal, never stored; `ring: true` also pushes |
| GET | `/calls/pending` | feature `calls`: signals held while this phone was asleep (removes them) |
| GET | `/calls/config` | feature `calls`: STUN and optional TURN credentials |
| GET / PUT / DELETE | `/places`, `/places/:id` | sealed places |
| PUT | `/circle` | admin: re-seal circle info |
| WS | `/api/v1/ws` | first frame `{type:"auth", token}` |
