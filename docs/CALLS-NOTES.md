# Voice calls: build notes

What was built on `claude/webrtc-calls-742644`, what could not be checked without a phone, and what comes next. Companion to `CALLS-PLAN.md` (the decisions).

## What is where

| Part | Files |
|---|---|
| Feature flag `calls` (off by default), `call` envelope kind | `packages/core/src/features.js`, `crypto.js` |
| Relay: `POST /calls/signal`, `GET /calls/pending`, `GET /calls/config`; held in memory 45 s; ring push | `server/src/calls.js`, `routes.js`, `hub.js` (`onReady`), `push.js` (`call`), `index.js`, `config.js` |
| Core: `sendCallSignal`, `collectCallSignals`, `callsConfig`, event `callSignal` (opens, verifies, drops stale or repeated) | `packages/core/src/client.js`, `api.js`, `index.d.ts` |
| Engine (no React Native): ICE candidate queue, glare, busy, timeouts, mute, ICE restart, Opus tuning, DTLS fingerprints | `mobile/src/lib/callEngine.ts`, `callSdp.ts`, `callSas.ts` (+ tests) |
| Real WebRTC and microphone | `mobile/src/lib/rtc.ts` |
| Call manager (circles, audio, service, ringing, notification buttons, network changes) | `mobile/src/lib/calls.ts` |
| Call screen and host; Call tile | `mobile/src/components/CallScreen.tsx`, `CallHost.tsx`, `PersonSheet.tsx` (one tile) |
| Android: audio mode and routing, foreground service, wake + Wi-Fi lock, ringing, full-screen notification | `mobile/modules/hc-calls/` (new Kotlin) |
| Background wake | `mobile/src/background/tasks.ts` (one branch for `{ t: 'call' }`) |
| Build config | `mobile/app.json` (WebRTC plugin; microphone no longer blocked), `package.json` (react-native-webrtc 155.0.1, @config-plugins/react-native-webrtc 15.0.2) |

Server knobs: `CALLS_STUN` (comma list, default Cloudflare then Google), `CALLS_TURN_URLS`, `CALLS_TURN_SECRET`, `CALLS_TURN_TTL_HOURS` (6), `CALLS_RELAY_ONLY`.

## Try it on two phones (once the APK is built)

1. Admin: Settings, Features, turn on **Voice calls**. Both phones open the app (so they learn the setting).
2. Person sheet, **Call**. The other phone rings; Answer. Check: voice both ways, mute, Phone/Speaker button, timer, Hang up from either side.
3. Lock the receiver and close the app (swipe away): call again. It should ring on the lock screen (full-screen notification). Tap Answer.
4. During a call switch one phone from Wi-Fi to mobile data: the screen says Reconnecting, then the voice returns.
5. Both call each other at the same moment: one call, no ringing. Call someone on a call: "They're on another call".
6. Tap "Check words" on both screens during a call: the four words match.
7. Diagnostics shows `call:path` (local/remote candidate kinds, `host`/`srflx`/`relay`): this answers how often the family needs TURN.

## Not verified (nothing here has run on a phone)

- The whole Kotlin module (`hc-calls`) has not been compiled. It was reviewed by hand against the Android and Expo APIs; expect a small compile fix or two on the first Gradle build.
- react-native-webrtc 155 on Expo SDK 58 / RN 0.88 (New Architecture, interop layer). The config-plugin table stops at SDK 56. An autolinking check shows the module and `hc-calls` are found, and `expo prebuild` runs and gives the right permissions, but nothing was built.
- Audio quality, echo cancellation, the Opus settings actually taking effect, speaker and Bluetooth routing, the headset-disconnect fallback.
- Whether a push-woken, closed app runs the engine in the same JS runtime the activity later attaches to (the design assumes it does), and how many seconds the ring takes from a cold start.
- `phoneCall|microphone` service type on Android 14 and 15 (falls back to `microphone` if refused), full-screen intent and `setShowWhenLocked` timing over the lock screen, the Decline button (it opens the app and declines there), Do Not Disturb (rings through only if the person gave HomeCircle Do Not Disturb access).
- ICE restart on a real Wi-Fi to mobile change; TURN with a real coturn; iOS (not built).

## Telecom / ConnectionService: what it would cost

What is built: a foreground service, a full-screen-intent notification and our own audio focus. It does not tell Android a call is in progress, so: no pause when a cellular call arrives (two calls can overlap), no headset or car hang-up button, no entry in the system's call UI, and Android 14 may take the full-screen permission away from apps that are not calls or alarms (Play grants it to apps whose core function is calls; for a sideloaded APK check Settings, Apps, Special access; `openFullScreenSettings()` opens it).

The proper route is Jetpack Core-Telecom (`androidx.core:core-telecom`, `CallsManager.addCall` with a `CallAttributesCompat`, which on Android 8 to 13 uses a self-managed ConnectionService underneath). It would add: the OS treating HomeCircle as a phone call (priority for the process and the microphone, hold on a cellular call, Bluetooth and car controls, system audio routing). Cost: roughly 300 to 500 lines of Kotlin with a coroutine whose lifetime is the call, one Gradle dependency, `MANAGE_OWN_CALLS` (already declared), and device testing on several makes (Samsung, Xiaomi and others differ). Estimate three to five days with phones. Recommendation: test what is built first; add Core-Telecom if calls drop when the screen is off, or cellular calls clash.

## iOS: what CallKit and PushKit would need (not built)

- PushKit VoIP push, which Expo push cannot send: the app registers a `PKPushRegistry` token, the server stores it next to the Expo token and sends a content-free VoIP push straight to APNs (HTTP/2 with a `.p8` key, topic `<bundle id>.voip`). Apple kills an app that does not report a call to CallKit right after a VoIP push, so the call must be reported before the sealed offer is fetched (show a generic "HomeCircle", then update the name once opened).
- CallKit (`CXProvider`, `CXCallController`): answer and decline, mute and hold from the system UI, and the audio session handed over in `didActivate` (WebRTC's `RTCAudioSession`). `react-native-callkeep` or a small Swift module.
- Background modes `voip` and `audio`, `NSMicrophoneUsageDescription` (the plugin already sets it), and a Mac build. About one to two weeks including a TestFlight round. `canCall()` returns false on iOS today.

## Running coturn (optional, for pairs that cannot connect directly)

Needs a server with a public IP (a VPS or a home server with a forwarded port); not Render, not the Home Assistant add-on. `/etc/turnserver.conf`:

```ini
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=<same value as CALLS_TURN_SECRET>
realm=turn.example.org
external-ip=<public IP>
min-port=49160
max-port=49200
no-multicast-peers
no-cli
# A relay must never reach into the server's own network:
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
# optional TLS on 443 for networks that block UDP:
# tls-listening-port=443
# cert=/etc/letsencrypt/live/turn.example.org/fullchain.pem
# pkey=/etc/letsencrypt/live/turn.example.org/privkey.pem
```

Open UDP and TCP 3478 and UDP 49160 to 49200. In HomeCircle's server environment:

```
CALLS_TURN_URLS=turn:turn.example.org:3478?transport=udp,turn:turn.example.org:3478?transport=tcp
CALLS_TURN_SECRET=<a long random string>
```

Phones fetch short-lived credentials (6 hours by default) from `GET /calls/config`. `CALLS_RELAY_ONLY=1` sends all media through the relay so the phones never learn each other's address (the relay then carries about 100 kbit/s per call, both ways). A relay sees encrypted packets, sizes and timing, not the voice.

## Open decisions

1. Should the Decline button decline without opening the app? It needs a native receiver that can send the sealed decline (a headless task) or a server "decline by token" path; today it opens the app.
2. A "missed call" line in the chat (sealed DM from the caller) so history shows it, and a "called" line for answered calls?
3. Which STUN servers are acceptable by default (they see each phone's address at call start); the default is Cloudflare then Google, change with `CALLS_STUN` or leave empty-list to your own coturn (it also does STUN).
4. Whether to add Core-Telecom now, and the Play Console declarations (full-screen intent, `phoneCall` service) if the app goes to Google Play.
5. Calls from or to the web client (browsers have WebRTC; the web client has no push, so it could only ring while open).
