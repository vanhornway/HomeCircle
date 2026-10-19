# HomeCircle

**Private family location sharing on a server you own.** A self-hosted,
end-to-end encrypted alternative to Life360: a live family map, on-demand
"Locate", arrival alerts for places, and a family chat.

- **One server = one family.** Location and chat are shared only with people who joined your server.
- **End-to-end encrypted.** Phones encrypt everything before upload. The server and your hosting provider only see ciphertext.
- **Battery-friendly.** Updates about every 15 minutes (configurable from 5 to 60), on big moves, on place arrivals, or right away when someone taps **Locate**.
- **Host anywhere.** Render, Railway, Fly.io, DigitalOcean, Hetzner, any VPS, or a Raspberry Pi at home. They all use one Docker image.

```
landing/          Marketing site + "choose your server" wizard (static HTML)
server/           Node.js server: API, WebSocket, SQLite, push relay, built-in web app
packages/core/    Shared crypto + client logic (used by web, mobile and tests)
mobile/           iOS + Android app (Expo / React Native)
deploy/           Docker Compose, Caddy, installer, cloud-init, hosting guide
docs/PROTOCOL.md  Encryption design and threat model
```

## How it works

1. **Deploy a server.** See [deploy/README.md](deploy/README.md) or open `landing/index.html`.
2. **Set up.** In the app, the first person taps **Set up a new server** and enters the address and the one-time setup code. This creates the circle and its encryption key on their phone.
3. **Invite.** Settings → Invite shows a QR code or link. The secret half of the link never reaches the server.
4. **Share.** Each phone uploads its encrypted location in the background. Viewers get live updates over WebSocket while the app is open.
   **Locate** sends a content-free silent push that makes the target phone take one fresh GPS fix.

Details: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Develop

Requirements: Node 22.13+ (uses built-in `node:sqlite`).

```bash
# shared core
cd packages/core && npm install

# server + built-in web app on http://localhost:8080 (setup code: dev-setup-token)
cd server && npm install && npm run dev

# end-to-end tests (real server + clients over HTTP/WebSocket)
cd server && npm test

# simulate a family member who walks around, chats and answers Locate requests
node server/scripts/simulate-member.mjs "<invite link>" "Bob" 40.73 -73.99
```

### Mobile app

```bash
cd mobile && npm install
npx expo run:ios       # or: npx expo run:android  (needs Xcode / Android Studio)
```

Background location, geofencing and push notifications need a **development
build**. Expo Go doesn't support them. Without Xcode or Android Studio, build in the cloud:

```bash
npx eas-cli@latest init            # sets extra.eas.projectId (needed for push)
npx eas-cli@latest build --profile development --platform ios
```

Before release, change `ios.bundleIdentifier` / `android.package` in
`mobile/app.json`. Also set `LANDING_URL` in `mobile/src/theme.ts`.

## Before you publish

The deploy buttons and installers pull from the public GitHub repo
`vanhornway/HomeCircle` (set in `render.yaml`, `deploy/install.sh`,
`deploy/cloud-init.yaml` and `landing/config.js`), so it has to exist and be
public. CI (`.github/workflows/ci.yml`) runs the tests and publishes a
multi-arch image to `ghcr.io/vanhornway/homecircle`.

## Known limitations

- **iOS background behavior is up to iOS.** If someone force-quits the app, iOS stops background location and silent pushes until they open it again. Geofence arrivals still work. Others then see the "last seen" time.
- **Push goes through Expo's relay → APNs/FCM.** Payloads are content-free, but those services can see that a push happened. Set `PUSH_PROVIDER=none` to disable (Locate then only reaches open apps).
- **One device per person.** A new phone needs a new invite; an admin removes the old one.
- **Trust in the web app.** The browser version is served by your server, so it's only as trustworthy as that server. The mobile app doesn't have this issue.
- **No forward secrecy per message.** The circle key changes when someone is removed. Compare safety numbers in person to rule out a swapped key.
