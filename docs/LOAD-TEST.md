# Load-test HomeCircle on Home Assistant

See how your Home Assistant handles a crowd. A **swarm** of simulated people
joins circles on a **separate load-test server** and uses HomeCircle the way
real people do:

- **Families, friends, coworkers, party guests and grandparents**, plus circles
  that **argue about politics** and circles that **chat about history**, with
  lots of emoji 😂🔥 and greetings in local languages (Japanese, Arabic, Hindi,
  Spanish, Swahili…).
- **All over the world:** circles live in 21 cities from Los Angeles to Lagos
  to Tokyo. People move between home, school, work and the city's landmark
  (Central Park, the Colosseum, Shibuya Crossing…), so arrivals and departures
  happen all the time.
- They chat, react, send direct messages, Locate each other, ask for
  check-ins, and open and close the app.

You join any circle from your phone and watch. A dashboard charts the load next
to Home Assistant's CPU and memory, and turns it into **findings**: what broke,
what slowed down, and how many people your Home Assistant can handle.

Your family's circles are never touched. The load-test server runs on the same
machine as your real one, so the CPU and memory numbers are real, but it keeps
its own data, sends no push notifications, and stays out of your backups.

**Where things run:** the load-test **server** runs on Home Assistant (as part
of the HomeCircle add-on). The **swarm** runs on a computer on the same network,
not on Home Assistant: if it ran there, its own work would be counted as
HomeCircle's load.

---

## 0. Get HomeCircle 0.7.2 onto Home Assistant (once)

The load-test server comes with add-on version 0.7.2.

1. On your computer, in your HomeCircle repository, add the changes and push
   them to GitHub (`git am homecircle-load-test.patch`, then `git push`), or
   merge the `swarm` branch.
2. In Home Assistant: **Settings → Apps → Install app → ⋮ (top right) → Check
   for updates**.
3. **Settings → Apps → HomeCircle** now offers **Update** to 0.7.2. Click it.
   Your circles are kept.

## 1. Turn on the load-test server (2 minutes)

1. **Settings → Apps → HomeCircle → Configuration**.
2. Turn on **load_test_server**. Optionally set **load_test_setup_code** to a
   code of your choice (12+ characters). Click **Save**.
3. Still in Configuration, under **Network**, check that port **8081** has a
   number next to it (it's 8081 by default).
4. **Info** tab → **Restart**.
5. **Log** tab. After about a minute:

   ```
   [homecircle] Load-test server is ON (separate data, no push notifications):
   [homecircle]   on your home network:  http://<your-home-assistant-ip>:8081
   [homecircle]   from anywhere:         https://homecircle.<tailnet>.ts.net:8443
   [load-test] …  and this setup code:  k3J9-…
   ```

   Write down the **https address** and the **setup code** (unless you chose
   one).
6. **Your Home Assistant's IP address:** **Settings → System → Network**,
   under IPv4 (for example `192.168.1.20`).

## 2. Let the swarm read CPU and memory (3 minutes)

1. **HomeCircle's sensors:** **Settings → Devices & services → Home Assistant
   Supervisor** → open the **HomeCircle** device → under **Sensors**, click
   the hidden/disabled entities and enable **CPU percent** and **Memory
   percent**.
2. **The whole machine:** **Settings → Devices & services → Add integration →
   System Monitor** (if you don't have it), then enable **Processor use**,
   **Memory usage** and **Load (1 min)**.
3. **A token:** click your name (bottom left) → **Security** tab →
   **Long-lived access tokens → Create token**, name it "swarm", and copy it.

Without this, the swarm still runs and measures response times; the CPU and
memory charts and findings stay empty.

## 3. Start the swarm on your computer (5 minutes)

You need [Node.js 22](https://nodejs.org) and a copy of the repository.

```sh
cd HomeCircle
cd packages/core && npm ci && cd ../../server && npm ci
node scripts/swarm.mjs \
  --server http://192.168.1.20:8081 \
  --setup-code k3J9-… \
  --invite-server https://homecircle.your-tailnet.ts.net:8443 \
  --ha-url http://192.168.1.20:8123 \
  --ha-token eyJhbGciOi… \
  --scale small
```

- `--server`: your Home Assistant's IP address, port **8081**.
- `--setup-code`: only needed the first time. The swarm keeps its keys in a
  `.swarm` folder and picks up where it left off next time.
- `--invite-server`: the `https://…:8443` address from the log, used in the
  join links for your phone. Without Tailscale, leave it out; the links then
  only work while your phone is on your Wi-Fi.
- `--ha-url`: Home Assistant itself, port **8123**.

Open **<http://localhost:8090>**. Leave the window running; **Ctrl+C** stops
the swarm and saves the report.

## 4. Join circles from your phone

The dashboard lists every circle with where it is and a **Join** button. Click
it, then in the HomeCircle app choose **Join my family** and scan the QR code.

- Start with **Load test HQ 📊**. Send **status** for the current load, or
  **report** for the findings. New problems are posted there by themselves, so
  you hear about them on your phone.
- Join a **Politics chat** to watch an argument unfold, a **History buffs**
  circle for a calmer conversation, and a family on another continent to see
  arrivals and departures at its landmark.
- Write to the simulated people: someone answers within seconds (or when their
  app is next open). Direct messages and check-in requests get answers too.

## 5. Turn it up

Start small, watch for a few minutes, then raise **one thing at a time**, so
the findings can tell what each change did.

| Run | What it shows |
|---|---|
| `--scale small --speed 1` | A normal day for ~85 people in 7 circles: your baseline. |
| `--scale medium --speed 5` | ~115 people in 11 circles having a busy day. |
| `--scale large --speed 10` | ~250 people in 26 circles, 10× busier than normal. |
| `--scale xl --speed 20` | ~540 people in 54 circles at 20×: a stress test. |

- **Speed:** how many times busier than a normal day. At 10×, people move,
  chat and open the app ten times as often. Change it live with the buttons at
  the top of the dashboard.
- **Circles and people:** on the dashboard, each kind of circle (family,
  friends, coworkers, party, extended family, politics, history) has **−** and
  **+** for how many circles run and how many people are in each (2–49).
  Fewer circles **pause** (they come back as they were); fewer people **leave**
  their circle (its key rotates, as in real life). **Use varied** goes back to
  each circle's natural size.
- The same from the command line:

  ```sh
  # 4 families of 6, 3 politics chats of 25, one party of 40
  node scripts/swarm.mjs --server … --circles family=4,politics=3,party=1,friends=0,work=0,elders=0,history=0 --people family=6,politics=25,party=40
  ```

  Your last mix is remembered between runs.
- `--ramp 10` brings circles online over 10 minutes, so you can watch CPU climb
  as people arrive. `--duration 60` stops after an hour. `--near 34.05,-118.25`
  puts every circle around one spot instead of around the world.

Each change draws a dashed line on the charts, so you can see what it did.

## 6. Learn from it: findings and the report

The **Findings** card on the dashboard updates every 10 seconds:

| Finding | What it tells you |
|---|---|
| 🔴 **Failed calls** (by call and error) | What broke, with what to check: server errors point to the add-on log, "couldn't reach the server" to restarts or memory. |
| 🟠 **Responses slowed down at about N people** | The point where your Home Assistant stops being comfortable, and what CPU was at the time. |
| 🔵 **Estimated capacity** | Requests per minute (and people) before HomeCircle's CPU reaches 70%, from how CPU grew as you raised the load. |
| **Slowest calls** | Which part of HomeCircle to optimize first. |
| **Chat delivery** | How long messages take to reach people with the app open. |
| **Memory keeps growing** | A possible leak, when memory climbs while the load stays the same. |
| **Live connections dropped** | Open apps losing their connection (restarts, overload, Tailscale timeouts). |
| **Rate limits, key rotations, joins** | How the server's protections and membership changes behave under load. |
| **This computer was the bottleneck** | When the swarm itself, not the server, limited the test. |

**Download report** (or Ctrl+C) saves a Markdown report in `.swarm/`: the
findings, a table of each load step (people, requests, response times, CPU,
memory), every API call with its failures, and what the simulated people did.
A timeline CSV (every 10 s) sits next to it. Paste the report into a chat with
Claude to work out what to fix first.

A good first session:

1. `--scale small --speed 1` for 10 minutes: your baseline.
2. Speed 5, then 20, 10 minutes each.
3. Raise one kind of circle (say politics to 5 circles of 30), 10 minutes.
4. Download the report.

## Reading the charts

| Watch | Healthy | Trouble |
|---|---|---|
| **Latency p95** | Under 300 ms | Over 1 s, or climbing while load is steady |
| **Chat delivery p95** | Under 1 s | Several seconds |
| **Errors / min** | 0 | Any steady count (see **API calls**) |
| **HomeCircle CPU** | Comfortably under 70% | Pinned near 100% |
| **HomeCircle memory** | Flat once everyone is online | Rising for an hour |
| **Whole machine** | Room left for Home Assistant | Automations or the UI get slow |

Tailscale's own CPU counts toward the add-on's. The swarm talks to port 8081
directly; phones that come in through Funnel add a little more.

## What the swarm doesn't simulate

- **Push notifications.** Off on the load-test server so your phone isn't
  flooded. A real server also sends a small request to Expo's relay for each.
- **Locate for people whose app is closed.** A real phone would get a push and
  answer; the swarm plays that part when one simulated person Locates another.
  If you Locate someone whose app is closed, they won't answer.
- **Background location limits.** Simulated phones report on the app's
  schedule (every 500 m while moving, every 15 minutes while still) without the
  delays iOS and Android add.

## Clean up

- **Pause:** Ctrl+C. Run the same command later to continue with the same
  circles.
- **Start over:** turn on **load_test_reset**, restart the add-on, turn it off
  again, and delete the `.swarm` folder. The next run needs the new setup code.
- **Done for good:** turn **load_test_server** off and restart the add-on.
  Leave the load-test circles in the app (or reset the server first: the app
  drops circles whose server no longer knows them).
