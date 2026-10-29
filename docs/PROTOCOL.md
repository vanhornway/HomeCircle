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
| Your server / hosting provider (Render, Railway, Hetzner, …) | number of circles and members, IP addresses, when each phone uploads, ciphertext sizes, push tokens (and so which members share a phone), which messages their sender marked `urgent` (call-back requests and replies, SOS) and when, which members have admin settings (a `member` record) and which pairs have a family name (an `alias` record, never the name), and how many photos each member uploaded and their sizes | names, locations, messages, places, battery, what an urgent message is or why, skins and settings, family names, photos |
| Network attacker | nothing beyond TLS metadata | everything else |
| Apple / Google / Expo push relay | that a push was sent to a device, and its type (`loc_req`, `msg`); urgent messages are pushed at once rather than batched, so their timing is less bunched | any content (an urgent push is identical to any other) |
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
`now`, `5min`, `morning` or `evening` (her time). The first `now` in server
order takes the request and closes it for everyone; a reply from the asker
herself, or sent as a direct message, doesn't count. Each family phone
schedules its own reminders while a request that asks it is open and it
hasn't replied, so the server never learns about reminders. Both carry a
readable `text` for older apps.

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
  language and he/she. Only admins may write one, and phones accept it only
  if an admin signed it.
- `alias`, subject `caller.member`: a family name, what one member calls
  another ("Nani"), with an optional relationship. Either of them or an admin
  may write it, and phones accept it only from one of those. Names are per
  pair, so the same person can be "Nani" to one grandchild and "Dadi" to
  another.

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

## API summary (`/api/v1`, Bearer device token unless noted)

| Method | Path | Notes |
|---|---|---|
| GET | `/info` | public: version, whether setup is done |
| POST | `/setup` | public + setup token, once |
| POST | `/join/preview` | public + invite auth |
| POST | `/join` | public + invite auth |
| GET | `/state` | circle info, members, current epoch, rotationNeeded, retention |
| POST | `/circles` | server admin: create another circle |
| DELETE | `/circle` | owner: delete the circle |
| PUT | `/circle/retention` | admin: `{ days: 1 \| 7 \| 30 \| 90 \| 365 }` |
| GET / POST | `/messages` | group messages + your DMs; `to` makes a DM; `urgent: true` skips push batching (10 a minute per sender) |
| PUT | `/members/me/profile` | re-seal profile |
| PUT | `/members/me/push` | register push token |
| DELETE | `/members/:id` | admin, or yourself (leave) |
| POST | `/members/:id/role` | owner: promote/demote admin |
| POST/GET/DELETE | `/invites` | admin |
| POST | `/keys/rotate` | admin |
| GET | `/keys/envelopes` | your rotated keys |
| GET / PUT | `/locations`, `/locations/me` | latest sealed locations |
| GET | `/records` | sealed member settings and family names (`?kind=member` or `alias`) |
| PUT / DELETE | `/records/:kind/:subject` | `member`: admins; `alias` (`caller.member`): either of them or an admin |
| POST / GET / DELETE | `/files`, `/files/:id` | encrypted files; `?purpose=photo` for a member's photo (kept) |
| POST | `/locations/request` | ask phones for a fresh fix |
| GET / POST | `/messages` | `?after=seq&limit=n` |
| GET / PUT / DELETE | `/places`, `/places/:id` | sealed places |
| PUT | `/circle` | admin: re-seal circle info |
| WS | `/api/v1/ws` | first frame `{type:"auth", token}` |
