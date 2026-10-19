# HomeCircle protocol

One HomeCircle server hosts exactly **one circle** (one family). Only people who
joined that server can see each other. The server stores and relays data it
cannot read: every location, chat message, place and profile is end-to-end
encrypted on the phone before it is uploaded.

## Threat model

| Party | Can see | Cannot see |
|---|---|---|
| Your server / hosting provider (Render, Railway, Hetzner, …) | number of members, IP addresses, when each phone uploads, ciphertext sizes, push tokens | names, locations, messages, places, battery |
| Network attacker | nothing beyond TLS metadata | everything else |
| Apple / Google / Expo push relay | that a push was sent to a device, and its type (`loc_req`, `msg`) | any content |
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
| Setup token | server env `SETUP_TOKEN` | lets the first person create the circle |

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

Kinds: `profile`, `location`, `chat`, `event`, `place`, `circle`.

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

## Removing a member and rotating the key

1. An admin calls `DELETE /members/:id` (or a member leaves). Their token is
   revoked immediately and the circle is marked `rotationNeeded`.
2. An admin's app generates `CK_{e+1}`, and for every remaining member creates
   `box(CK_{e+1}, nonce, member.boxPub, admin.boxSecret)`, then posts all of them
   to `POST /keys/rotate`. The server requires one envelope per active member.
3. Every member fetches `GET /keys/envelopes`, opens theirs with the admin's
   trusted box key, adds `CK_{e+1}` to their keyring, and re-publishes their
   profile under the new epoch. Outstanding invites are revoked.

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

## Chat and events

`POST /messages` stores a sealed `chat` or `event` envelope (place arrivals,
"left school"…). The server can't tell them apart. It assigns a sequence
number, broadcasts over WebSocket, and sends a generic push ("New activity in
HomeCircle") to members who aren't connected. Messages expire after
`MESSAGE_RETENTION_DAYS` (default 90).

## Places

Places (Home, School…) are sealed `place` envelopes. Each phone registers them
as OS geofences locally, so arrival/departure is detected on the device, never
on the server.

## API summary (`/api/v1`, Bearer device token unless noted)

| Method | Path | Notes |
|---|---|---|
| GET | `/info` | public: version, whether setup is done |
| POST | `/setup` | public + setup token, once |
| POST | `/join/preview` | public + invite auth |
| POST | `/join` | public + invite auth |
| GET | `/state` | circle info, members, current epoch, rotationNeeded |
| PUT | `/members/me/profile` | re-seal profile |
| PUT | `/members/me/push` | register push token |
| DELETE | `/members/:id` | admin, or yourself (leave) |
| POST | `/members/:id/role` | owner: promote/demote admin |
| POST/GET/DELETE | `/invites` | admin |
| POST | `/keys/rotate` | admin |
| GET | `/keys/envelopes` | your rotated keys |
| GET / PUT | `/locations`, `/locations/me` | latest sealed locations |
| POST | `/locations/request` | ask phones for a fresh fix |
| GET / POST | `/messages` | `?after=seq&limit=n` |
| GET / PUT / DELETE | `/places`, `/places/:id` | sealed places |
| PUT | `/circle` | admin: re-seal circle info |
| WS | `/api/v1/ws` | first frame `{type:"auth", token}` |
