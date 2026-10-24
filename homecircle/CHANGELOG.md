# Changelog

See the full list of changes on <https://homecircle.umair.us/#changelog>.

## 0.10.1

- Fixed: the web page could miss votes and messages sent just as it
  reconnected, so counts differed between devices and a closed poll could
  announce the wrong winner.

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
