# The public demo

A separate HomeCircle server where anyone can try a made-up family of twenty for an hour. It's never a family's own server: `DEMO_MODE=1` makes it refuse real circles.

## What runs

- **The server in demo mode** (`server/src/demo.js`, off unless `DEMO_MODE=1`). It holds only demo copies, hands one to each visitor (`POST /api/v1/demo/start`), and ends a copy when the hour is up, when the visitor leaves, or after 10 minutes with no connection. Setup codes, recovery and new circles are refused.
- **The demo director** (`server/demo/`). The server starts it as a child process. It keeps a few copies ready (each takes about 5 seconds to build), and runs the twenty people in each copy as real clients with their own keys. It holds keys in memory only, so when it restarts it clears every copy and builds new ones.

Each visitor gets their own copy, so strangers never see each other. The visitor's real location is never shared with a demo family: the app leaves demo circles out of location sharing, and the server drops any location or most-visited places a visitor sends, so an app from before demos stays out too.

Visitors start in the app, in a browser, or from the demo page's "Show a QR code for your phone", which gives a one-time link to scan with Settings → Your circles → Join a circle. That works in any version of the app, alongside the person's other circles. An app from before demos has no countdown or end screen: when the copy ends, its banner offers to remove the circle.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `DEMO_MODE` | off | Turns all of this on. Never set it on a family's server. |
| `DEMO_TOKEN` | required | Secret shared by the server and the director, at least 16 characters. |
| `PUBLIC_URL` | | The address visitors reach, e.g. `https://demo.homecircle.umair.us`. |
| `TRUST_PROXY` | off | Set it behind a proxy (Render, Caddy), or every visitor counts as one address. |
| `DEMO_POOL` | 3 | Copies kept ready. |
| `DEMO_MAX_RUNNING` | 10 | Copies with visitors at once. Past this, visitors are told to try again. |
| `DEMO_MINUTES` | 60 | Length of a demo. The day scales to fit. |
| `DEMO_IDLE_MINUTES` | 10 | No connection for this long ends a copy. |
| `DEMO_UNUSED_MINUTES` | 5 | A link handed out and not used in this long frees its copy. |
| `DEMO_STARTS_PER_IP` | 6 | Starts per address per day. |
| `DEMO_STARTS_PER_DEVICE` | 3 | Starts per device per day. |
| `DEMO_DIRECTOR` | on | Off runs the director apart: `node server/demo/director.mjs`. |
| `DEMO_AI_KEY` | | An AI key for Birdie. Without it, Birdie keeps lists, recipes and notes but can't answer questions. |
| `DEMO_AI_PROVIDER` | `anthropic` | Provider for that key. |
| `DEMO_AI_MODEL` | `claude-haiku-5-5` | Model for that key. |
| `DEMO_AI_BUDGET_USD` | 0.25 | Most Birdie may spend on one copy. |

The server needs no persistent disk: copies are throwaway. `AGENT` is turned on by `DEMO_MODE`.

The app reads the server's address from `EXPO_PUBLIC_DEMO_SERVER` when it's built, and defaults to `https://demo.homecircle.umair.us`.

## Running it locally

```bash
DEMO_MODE=1 DEMO_TOKEN=local-demo-only-token DEMO_PACE=6 PORT=8091 HOST=127.0.0.1 DATA_DIR=./data/demo npm --prefix server start
```

Open http://127.0.0.1:8091 and start a demo. `DEMO_PACE=6` plays the day six times faster.

## Changing the family

- `server/demo/family.mjs`: people, places, and everyone's trips through the day.
- `server/demo/script.mjs`: what they say, and how they answer.
- `server/demo/content.mjs`: recipes, notes, shopping lists and reminders.

After changing places or trips, run `node server/demo/build-routes.mjs`. It works out the road routes once with the public OSRM server and saves them in `server/demo/routes.json`. The demo itself uses no routing service. `server/test/demo.test.js` checks that everyone's day holds together.

Everyone and everything in the family is made up. Keep it that way: no real people, no real homes, no other location apps by name.
