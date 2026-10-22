# Changelog

See the full list of changes on <https://homecircle.umair.us/#changelog>.

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
