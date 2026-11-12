// The home base's code on this computer, for tests (test/homebase.mjs).
// It stands in for the Meshtastic node: commands on stdin play the radio,
// and what the home base asks of the radio is printed. Each command's
// output ends with a line ".".
//
//   setup LINK                      join the circle as "Home base"
//   heard !id NAME                  a node is heard
//   position !id LAT LNG BATTERY    a node's position arrives
//   text !id TEXT                   a text from a node
//   mesh BASE64                     a HomeCircle-firmware tracker's packet
//   advance SECONDS                 let time pass
//   tick                            do what's due; prints "request !id" for position requests
//   selfgps LAT LNG SATS HDOP       the home base's own GPS fix
//   nmea SENTENCE                   a line from its GPS module
//   whoami                          the home base's member id
#include <cstdio>
#include <iostream>
#include <map>

#include <hc_homebase.h>

#include "../common.h"

namespace {

struct FakeRadio : hc::Radio {
  std::map<uint32_t, hc::HeardNode> heard;
  std::vector<uint32_t> asked;
  void requestPosition(uint32_t node) override { asked.push_back(node); }
  void nodes(std::vector<hc::HeardNode>& out) override {
    for (auto& kv : heard) out.push_back(kv.second);
  }
  std::string channelLink() override { return "https://meshtastic.org/e/#TEST"; }
  // The home base's own GPS, set by "selfgps"; its sky, fed by "nmea".
  hc::SelfGnss self;
  hc::GnssSky skyView;
  bool selfGnss(hc::SelfGnss& out) override {
    out = self;
    return self.present;
  }
  const hc::GnssSky* sky() override { return &skyView; }
  std::vector<uint32_t> traced;
  void traceroute(uint32_t node) override { traced.push_back(node); }
  std::string nodeName(uint32_t num) override {
    auto h = heard.find(num);
    return h == heard.end() ? "" : h->second.name;
  }
  std::vector<std::string> alerts;
  void alert(uint32_t node, const std::string& text) override {
    std::string shown;
    for (char c : text) shown += c == '\a' ? std::string("\\a") : std::string(1, c);
    alerts.push_back(hc::nodeId(node) + " " + shown);
  }
};

std::string rest(const std::string& line, size_t words) {
  size_t at = 0;
  for (size_t i = 0; i < words && at != std::string::npos; i++) {
    at = line.find(' ', at);
    if (at != std::string::npos) at++;
  }
  return at == std::string::npos ? "" : line.substr(at);
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3 || std::string(argv[1]) != "--store") return fprintf(stderr, "usage: homebase-host --store FILE\n"), 2;
  if (!hc::cryptoInit()) return 1;
  curl_global_init(CURL_GLOBAL_DEFAULT);
  host::CurlHttp http;
  host::FileStore store(argv[2]);
  FakeRadio radio;
  hc::HomeBase hb(http, store, host::nowMs, radio);
  hb.load();

  std::string line;
  while (std::getline(std::cin, line)) {
    std::string cmd = line.substr(0, line.find(' '));
    if (cmd == "setup") {
      hc::Status s = hb.setup(rest(line, 1));
      printf("%s %s\n", hc::statusName(s), s == hc::Status::Ok ? hb.base().memberId().c_str() : hb.base().error().c_str());
    } else if (cmd == "whoami") {
      printf("%s\n", hb.base().memberId().c_str());
    } else if (cmd == "heard" || cmd == "position" || cmd == "text") {
      uint32_t node;
      std::string args = rest(line, 1);
      if (!hc::parseNodeId(args.substr(0, args.find(' ')), node)) {
        printf("bad node\n");
      } else if (cmd == "heard") {
        hc::HeardNode h;
        h.num = node;
        h.name = rest(line, 2);
        h.heardAtMs = host::nowMs();
        radio.heard[node] = h;
      } else if (cmd == "position") {
        hc::Fix f;
        double lat = 0, lng = 0;
        int batt = -1;
        sscanf(rest(line, 2).c_str(), "%lf %lf %d", &lat, &lng, &batt);
        f.lat = lat;
        f.lng = lng;
        f.battery = batt;
        f.accuracy = 10;
        hb.onPosition(node, f, host::nowMs());
      } else {
        hb.onText(node, rest(line, 2));
      }
    } else if (cmd == "selfgps") {
      // selfgps LAT LNG SATS HDOP
      double lat = 0, lng = 0, hdop = 0;
      int sats = 0;
      sscanf(rest(line, 1).c_str(), "%lf %lf %d %lf", &lat, &lng, &sats, &hdop);
      radio.self.present = true;
      radio.self.hasFix = true;
      radio.self.lat = lat;
      radio.self.lng = lng;
      radio.self.satsUsed = sats;
      radio.self.hdop = (float)hdop;
      radio.self.fixType = 3;
      radio.self.altitudeM = 21;
      radio.self.fixAtMs = host::nowMs();
    } else if (cmd == "nmea") {
      for (char c : rest(line, 1) + "\r\n") radio.skyView.feed(c, host::nowMs());
    } else if (cmd == "route") {
      // route !id RELAY,RELAY SNR4,SNR4,SNR4: a traceroute's answer
      uint32_t node;
      std::string args = rest(line, 1);
      size_t sp1 = args.find(' '), sp2 = args.find(' ', sp1 + 1);
      std::vector<uint32_t> back;
      std::vector<int> snr;
      if (hc::parseNodeId(args.substr(0, sp1), node)) {
        std::string relays = args.substr(sp1 + 1, sp2 - sp1 - 1), snrs = sp2 == std::string::npos ? "" : args.substr(sp2 + 1);
        for (size_t at = 0; at < relays.size();) {
          size_t comma = relays.find(',', at);
          std::string r = relays.substr(at, comma == std::string::npos ? std::string::npos : comma - at);
          uint32_t n;
          if (hc::parseNodeId(r, n)) back.push_back(n);
          if (comma == std::string::npos) break;
          at = comma + 1;
        }
        for (size_t at = 0; at < snrs.size();) {
          size_t comma = snrs.find(',', at);
          snr.push_back(atoi(snrs.substr(at, comma == std::string::npos ? std::string::npos : comma - at).c_str()));
          if (comma == std::string::npos) break;
          at = comma + 1;
        }
        hb.onRoute(node, back, snr);
      }
    } else if (cmd == "mesh") {
      hc::Bytes b;
      if (hc::fromB64(rest(line, 1), b)) hb.onMeshPacket(b);
    } else if (cmd == "advance") {
      host::clockOffsetMs() += (int64_t)atol(rest(line, 1).c_str()) * 1000;
    } else if (cmd == "tick") {
      hb.log.clear();
      hb.tick();
      for (uint32_t n : radio.asked) printf("request %s\n", hc::nodeId(n).c_str());
      radio.asked.clear();
      for (auto& a : radio.alerts) printf("alert %s\n", a.c_str());
      radio.alerts.clear();
      for (uint32_t n : radio.traced) printf("trace %s\n", hc::nodeId(n).c_str());
      radio.traced.clear();
      if (!hb.log.empty()) printf("log: %s\n", hb.log.c_str());
    } else {
      printf("unknown command\n");
    }
    printf(".\n");
    fflush(stdout);
  }
  return 0;
}
