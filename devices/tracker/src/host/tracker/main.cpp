// The tracker's protocol code on this computer, driven from the command line,
// for tests against a real server (test/e2e.mjs). Not part of the firmware.
//
//   tracker-host --store FILE join LINK NAME
//   tracker-host --store FILE location LAT LNG [BATTERY%]
//   tracker-host --store FILE sos start|safe
//   tracker-host --store FILE settings
//   tracker-host --store FILE refresh
#include <cstdio>
#include <cstdlib>

#include "../common.h"

namespace {

using host::CurlHttp;
using host::FileStore;
using host::nowMs;

int done(hc::Status s, hc::Device& d) {
  if (s == hc::Status::Ok) {
    printf("ok\n");
    return 0;
  }
  fprintf(stderr, "%s: %s\n", hc::statusName(s), d.error().c_str());
  return s == hc::Status::Offline ? 3 : s == hc::Status::Removed ? 4 : 1;
}

int usage() {
  fprintf(stderr, "usage: tracker-host --store FILE join LINK NAME | location LAT LNG [BATTERY%%] | sos start|safe | settings | refresh\n");
  return 2;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 4 || std::string(argv[1]) != "--store") return usage();
  if (!hc::cryptoInit()) return fprintf(stderr, "libsodium didn't start\n"), 1;
  curl_global_init(CURL_GLOBAL_DEFAULT);
  CurlHttp http;
  FileStore store(argv[2]);
  hc::Device device(http, store, nowMs);
  std::string cmd = argv[3];

  if (cmd == "join") {
    if (argc < 6) return usage();
    hc::Status s = device.join(argv[4], argv[5]);
    if (s == hc::Status::Ok) printf("member %s in circle \"%s\"\n", device.memberId().c_str(), device.circleName().c_str());
    return done(s, device);
  }
  if (!device.load()) return fprintf(stderr, "this tracker hasn't joined a circle\n"), 1;

  if (cmd == "location") {
    if (argc < 6) return usage();
    hc::Fix fix;
    fix.lat = atof(argv[4]);
    fix.lng = atof(argv[5]);
    fix.accuracy = 8;
    fix.speed = 0;
    fix.battery = argc > 6 ? atoi(argv[6]) : -1;
    hc::TrackerSettings t;
    return done(device.shareLocation(fix, "update", t.moving, t.still), device);
  }
  if (cmd == "sos") {
    if (argc < 5) return usage();
    return done(device.sos(std::string(argv[4]) == "start"), device);
  }
  if (cmd == "settings") {
    hc::TrackerSettings t;
    hc::Status s = device.fetchSettings(t);
    if (s == hc::Status::Ok) {
      printf("{\"fromAdmin\":%s,\"mode\":\"%s\",\"moving\":%d,\"still\":%d,\"quiet\":%s,\"sos\":%s}\n", t.fromAdmin ? "true" : "false", t.mode.c_str(), t.moving, t.still,
             t.quiet ? ("{\"from\":\"" + t.quietFrom + "\",\"to\":\"" + t.quietTo + "\"}").c_str() : "null", t.sos ? "true" : "false");
      return 0;
    }
    return done(s, device);
  }
  // The mesh: print packets (base64url) as a Meshtastic node would send them.
  if (cmd == "mesh-register") return done(device.registerMesh(), device);
  if (cmd == "mesh-location") {
    if (argc < 6) return usage();
    hc::Fix fix;
    fix.lat = atof(argv[4]);
    fix.lng = atof(argv[5]);
    fix.accuracy = 12;
    fix.battery = argc > 6 ? atoi(argv[6]) : -1;
    hc::Bytes p = device.meshLocation(fix);
    printf("%s\n", hc::toB64(p).c_str());
    fprintf(stderr, "%zu bytes\n", p.size());
    return 0;
  }
  if (cmd == "sos-offline") {
    if (argc < 5) return usage();
    return done(device.sos(std::string(argv[4]) == "start", false), device);
  }
  if (cmd == "mesh-sos") {
    hc::Bytes p = device.meshSos();
    if (p.empty()) return fprintf(stderr, "no SOS\n"), 1;
    printf("%s\n", hc::toB64(p).c_str());
    fprintf(stderr, "%zu bytes\n", p.size());
    return 0;
  }
  if (cmd == "refresh") {
    hc::Status s = device.refresh();
    if (s == hc::Status::Ok) printf("epoch %ld\n", device.epoch());
    return done(s, device);
  }
  return usage();
}
