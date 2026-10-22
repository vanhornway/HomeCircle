# Load-test HomeCircle on Home Assistant

See how your Home Assistant handles a crowd. A **swarm** of simulated
people (families with kids, friends, coworkers, party guests, grandparents)
joins circles on a **separate load-test server** and uses HomeCircle the way
real people do. You join every circle from your phone and watch, while a
dashboard charts the load next to Home Assistant's CPU and memory.

Your family's circles are never touched. The load-test server runs on the same
machine as your real one, so the CPU and memory numbers are real, but it keeps
its own data, sends no push notifications, and stays out of your backups.

**You need:** HomeCircle add-on 0.7.2 or newer, and a computer on the same
network as Home Assistant with [Node.js 22](https://nodejs.org) and a copy of
this repository.

---

## 1. Turn on the load-test server (2 minutes)

1. In Home Assistant, go to **Settings → Apps → HomeCircle → Configuration**.
2. Turn on **load_test_server**. Optionally set **load_test_setup_code** to a
   code of your choice (12+ characters). Click **Save**.
3. On the **Info** tab, click **Restart**.
4. In the **Log** tab you'll see:

   ```
   [homecircle] Load-test server is ON (separate data, no push notifications):
   [homecircle]   on your home network:  http://<your-home-assistant-ip>:8081
   [homecircle]   from anywhere:         https://homecircle.<tailnet>.ts.net:8443
   [load-test] …  and this one-time setup code:  k3J9-…
   ```

   Note the **setup code** (unless you chose one).

## 2. Let the swarm read Home Assistant's CPU and memory (3 minutes, optional)

The dashboard charts the HomeCircle add-on's CPU and memory, and the whole
machine's, from Home Assistant's own sensors.

1. **HomeCircle's sensors:** **Settings → Devices & services → Home Assistant
   Supervisor**, open the **HomeCircle** device, and enable the **CPU percent**
   and **Memory percent** entities (they're off by default).
2. **The whole machine:** add the **System Monitor** integration if you don't
   have it, and enable **Processor use**, **Memory usage** and **Load (1 min)**.
3. **A token:** click your name (bottom left) → **Security** → **Long-lived
   access tokens** → **Create token**. Copy it.

Without this, the swarm still runs and measures latency; the CPU and memory
charts stay empty. Home Assistant's own **History** page shows the same
sensors too.

## 3. Start the swarm (5 minutes)

On your computer, in a copy of this repository:

```sh
cd packages/core && npm ci && cd ../../server && npm ci
node scripts/swarm.mjs \
  --server http://192.168.1.20:8081 \
  --setup-code k3J9-… \
  --invite-server https://homecircle.your-tailnet.ts.net:8443 \
  --ha-url http://homeassistant.local:8123 \
  --ha-token eyJhbGciOi…
```

- `--server` is the load-test server on your home network (your Home
  Assistant's IP address, port **8081**).
- `--setup-code` is only needed the first time. The swarm saves its keys in a
  `.swarm` folder and picks up where it left off next time.
- `--invite-server` is the `https://…:8443` address from the log, used in
  the join links for your phone. Leave it out if Tailscale isn't set up: the
  links then use the home-network address, which only works while your phone
  is on your Wi-Fi.

Then open **<http://localhost:8090>**.

## 4. Join the circles from your phone

The dashboard lists every circle with a **Join** button. Click it, then in the
HomeCircle app choose **Join my family** and scan the QR code. Do this for as
many circles as you like; **Load test HQ 📊** is a good first one. Send
**status** there and the swarm replies with the current load.

In each circle you'll see the simulated people move around the map, arrive at
and leave places, chat, react, and Locate each other. Write to them: someone
answers within a few seconds (or when their app is next open). A direct
message or a check-in request gets answered too.

## 5. Turn it up

Start small, watch for a few minutes, then raise one thing at a time.

| Run | What it shows |
|---|---|
| `--scale small --speed 1` | A normal day for ~45 people in 5 circles: your baseline. |
| `--scale medium --speed 5` | ~90 people having a busy day. |
| `--scale large --speed 10` | ~250 people, 10× busier than normal. |
| `--scale xl --speed 20` | ~500 people at 20×: a stress test. |

- **Speed** is how many times busier than a normal day it is: at 10×, people
  move, chat and open the app ten times as often. Change it live with the
  buttons at the top of the dashboard.
- **Scale** adds circles. Running again with a bigger scale keeps the circles
  you already joined and adds more.
- `--ramp 10` brings circles online over 10 minutes, so you can watch CPU
  climb as people arrive. `--duration 60` stops after an hour.

Every 10 seconds the swarm adds a row to a CSV file in `.swarm/` (the path is
at the bottom of the dashboard): people, requests per minute, latency, errors,
and the Home Assistant sensors. Open it in a spreadsheet to compare runs.

## Reading the results

| Watch | Healthy | Trouble |
|---|---|---|
| **Latency p95** | Under 300 ms | Over 1 s, or climbing while load is steady |
| **Chat delivery p95** | Under 1 s | Several seconds: the live connections are falling behind |
| **Errors / min** | 0 | Any steady count. The **API calls** table shows which call fails |
| **HomeCircle CPU** | Comfortably under 70% | Pinned near 100% (of one core) |
| **HomeCircle memory** | Flat once everyone is online | Rising steadily for an hour: a leak worth reporting |
| **Whole machine** | Room left for Home Assistant itself | Automations or the UI get slow |

The **Swarm (this computer)** line shows the swarm's own CPU. If the dashboard
says this computer is too busy, latency figures are inflated by the swarm, not
the server: lower the speed or run part of the swarm from another computer
(use a different `--data` folder there).

Tailscale's own CPU counts toward the add-on's. The swarm talks to port 8081
directly, so phones that come in through Funnel would add a little more.

## What the swarm doesn't simulate

- **Push notifications.** The load-test server has them off so your phone
  isn't flooded. A real server also sends a small HTTPS request to Expo's
  relay for each notification.
- **Locate for people whose app is closed.** A real phone would get a push and
  answer; the swarm plays that part itself when one simulated person Locates
  another. If you Locate someone whose app is closed, it won't answer.
- **Background location limits.** Simulated phones report on the app's
  schedule (every 500 m while moving, every 15 minutes while still) without
  the delays iOS and Android add.

## Clean up

- **Pause:** press **Ctrl+C** in the swarm's window. Run the same command
  again later to continue with the same circles.
- **Start over:** turn on **load_test_reset**, restart the add-on, turn it off
  again, and delete the `.swarm` folder. The next run needs the new setup
  code.
- **Done for good:** turn **load_test_server** off and restart the add-on.
  Leave the load-test circles in the app (or reset the server first: the app
  drops circles whose server no longer knows them).
