# Changelog

See the full list of changes on <https://homecircle.umair.us/#changelog>.

## 0.7.2

- New: an optional load-test server (`load_test_server`) for stress-testing
  HomeCircle on your Home Assistant with a swarm of simulated people. It runs
  next to your real server with its own data, no push notifications, and is
  left out of backups. See docs/LOAD-TEST.md.

## 0.8.0

- Lost your phone or signed out? The server's setup code gets you back in:
  rejoin your circle once a member approves, start a new circle, or delete an
  abandoned one. In the app: "Get back in with a setup code"; on the web page:
  "I set up this server".
- A generated setup code (when setup_code is empty) is now kept and shown in
  the log at every start, instead of changing on each restart.

## 0.7.1

- Fixed: the map on the web page showed "403 Access blocked" tiles from
  OpenStreetMap instead of the map.

## 0.7.0

- First Home Assistant add-on: HomeCircle with built-in Tailscale Funnel.
