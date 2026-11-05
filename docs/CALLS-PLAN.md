# In-app voice calls: plan and decisions

Status: working plan for the `claude/webrtc-calls-742644` branch. Not user documentation; the parent session turns the relevant parts into PROTOCOL / ARCHITECTURE / README at release.

History: calls were ruled out on 26 Oct 2026 and reversed on 31 Oct 2026. The user's spec is `webrtc_voice_architecture_edge_cases.md` (a web-style sketch); this plan adapts it to this codebase. Where the spec and the task brief disagree, the brief wins and the difference is listed under "Differences from the spec".

## What it is

A 1-on-1 voice call between two members of the same circle, media peer to peer (WebRTC, DTLS-SRTP, Opus). The server only brokers the setup and forgets it. Off by default: a per-circle feature `calls` that admins turn on. An elder's skin never gets calls in this release.

## Signaling: sealed, ephemeral, never stored

Every signal (ring/offer, answer, ICE candidate, hang-up, busy, decline) is a normal sealed envelope of a new kind `call`, sealed with the pair's direct key (`CircleClient._seal(..., { to })`), so the server cannot read or alter it. The SDP is inside, so the server also cannot swap the DTLS fingerprints (the usual WebRTC weak point). Plaintext is padded to 256/1024/4096/8192 bytes like chat, so an ICE candidate, a hang-up and an offer are not told apart by size. The signed body carries `callId`, `op`, `ts`; receivers drop signals older than 60 s and ones for a call they don't know (replay and stale-call protection). The direct key is derived from pinned identity keys, so signals from a non-member or a changed key do not open.

Relay (new, `server/src/calls.js` + routes):

- `POST /api/v1/calls/signal` `{ to, id, env, ring? }`. Checks: feature `calls` on, recipient is an active, non-agent member of the sender's circle, not self, envelope at most 16 KB, per-sender rate limit (120 signals a minute, 6 rings a minute, 3 rings a minute per pair). Returns `{ online, pushed }`.
- Delivery: a WebSocket frame `{ type: 'call_signal', from, id, env, at }` to every socket of the recipient. If the recipient has no open socket the signal is held **in memory only** for 45 s (at most 64 per recipient, 2000 in total) and handed over the moment their socket authenticates, or on `GET /calls/pending` (collect and clear). Nothing is written to SQLite, the message log or the file store; a server restart forgets everything.
- Ring push: a signal sent with `ring: true` (the first offer of a call, set by the client; ICE restarts and candidates don't) also sends the recipient a content-free high-priority push through the existing push path, even if they look connected (a half-dead socket looks connected; a push to a phone already ringing changes nothing). Rings are limited to 6 a minute per sender and 3 per pair. Android gets `{ t: 'call', c }` data-only, other platforms a generic "Incoming call" alert. No name, no call id.
- `GET /calls/config` returns `{ iceServers }`: the STUN servers the admin configured (`CALLS_STUN`, default Cloudflare then Google), plus, only if configured, a TURN relay with short-lived credentials (a hosted free-tier service the server fetches from, or the family's own coturn). Apps fall back to built-in STUN if the server is older.

What the server learns: that member A sent a signal to member B at time T, how big (bucketed), and whether it was flagged as a ring. Not the callee's answer, the codec, the SDP, the IPs inside it, or how long the call lasted. STUN servers see each phone's public IP when a call starts; the two phones see each other's IP (relay-only mode hides it, with a TURN server). Proposed PROTOCOL threat-model rows are at the end of the final report.

## Phone side

- `react-native-webrtc` 155 with `@config-plugins/react-native-webrtc` (Expo config plugin: camera/microphone strings, Android `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH_CONNECT`; no video, so the camera permission is not requested for calls). Dev builds only, as today. Untested on Expo SDK 58 / RN 0.88 (the plugin table stops at SDK 56): the first APK build is the compatibility test.
- `VoiceCallEngine` (`mobile/src/lib/callEngine.ts`): pure logic, peer-connection factory and signal sender injected, unit-tested in Node. One call at a time. Handles ICE candidate queueing until the remote description is set, glare, busy, ring timeout (45 s), connect timeout (30 s), hang-up, mute with `track.enabled = false` (never `stop()`), Opus tuning in the SDP (about 32 kbit/s, mono, in-band FEC, DTX off), ICE restart after `disconnected` (5 s grace) or `failed`.
- Call manager (`mobile/src/lib/calls.ts`): wires the engine to every circle's client, the microphone permission, native audio and the call UI state. The call screen is a full-screen modal in a new `components/CallScreen.tsx`, mounted once in the root layout by `components/CallHost.tsx` so it covers whatever screen is open; `PersonSheet.tsx` gets one tile and an import.
- Audio: a small native Expo module `hc-calls` owns audio mode/focus, speaker and Bluetooth routing, the foreground service, wake and Wi-Fi locks and the incoming-call notification, instead of adding `react-native-incall-manager` (4.3.0, old-style module, unclear on RN 0.88) as a second unmaintained-risk dependency. It is new Kotlin that **I cannot compile here** (no Gradle, by instruction): reviewed by hand, to be verified by the parent's APK build.

## Phases

0. This plan, the `calls` feature flag.
1. Server relay and tests; core call-signal methods and tests; `VoiceCallEngine` and tests; call screen; Call tile.
2. Ringing a locked or closed Android phone: push wake, full-screen notification, `phoneCall|microphone` foreground service, partial wake lock + Wi-Fi lock, audio focus, Bluetooth. Telecom/ConnectionService evaluated, not built (cost below). iOS CallKit/PushKit: notes only.
3. If time: short authentication string from the DTLS fingerprints; coturn fallback endpoint and docs.

## Decisions

- HTTP POST for signals, WebSocket only for delivery: reuses auth, rate limits and the server's `hub`; the sender may be backgrounded with no socket. The cost is one request per ICE candidate; candidates are batched for 100 ms client-side.
- Glare: **the lower member id keeps its offer**; the higher id abandons its own and answers the other (the brief says this; the spec's table says the opposite, and the two sides must agree, so the brief's rule is implemented and documented).
- Busy while in another call (any circle). A phone cellular call in progress is not detected in phase 1.
- Missed calls: the callee's phone shows a local "Missed call" notification when a ring ends unanswered. A "missed call" line in the chat (an ordinary sealed DM from the caller) is not built; open decision in the build notes.
- One device per member in HomeCircle (each phone is its own member), so there is no "answered on another phone" case to handle.
- No video, no screen sharing. Group calls came later: see Group calls in `PROTOCOL.md`.

## Differences from the spec

- Spec puts signaling on "the existing message pipeline" marked ephemeral; messages there are stored by design, so a separate relay path is used.
- Spec's `crypto.randomUUID`, `navigator.mediaDevices`, `document.getElementById('remote-audio-sink')` don't exist in React Native: `randomId`, `mediaDevices` from react-native-webrtc, and remote audio plays automatically through the native audio device.
- The spec's `optimizeSdpForVoice` regex hardcodes payload type 111; the engine reads the Opus payload type from the SDP.
- The spec relies on Opus DTX/NAT keep-alives from a muted track; Opus DTX is disabled in the SDP and ICE consent freshness (every 5 s) keeps the pinhole open on its own.
- Spec sends an unauthenticated `RTC_SIGNAL` envelope with plain `senderId`; here the envelope is sealed and signed.
