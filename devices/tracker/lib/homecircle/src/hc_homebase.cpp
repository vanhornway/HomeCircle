#include "hc_homebase.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace hc {

namespace {

const int64_t MIN = 60 * 1000;
const int64_t DIRECT_EVERY = 20 * 1000;      // read admins' messages
const int64_t WATCH_EVERY = 5 * MIN;         // look for quiet phones
const int64_t SEND_GAP = 1 * MIN;            // at most one location a minute per tracker (unless SOS or asked)
const int64_t ASK_GAP = 10 * MIN;            // at most one position request per tracker every 10 minutes
const char* const HELP =
    "Home base commands:\n"
    "• list: trackers, and nodes I can hear\n"
    "• add !a1b2c3d4 Name (add \"as car\" for a car)\n"
    "• rename Name to New name\n"
    "• link Name to Person: who carries it; I ask it for a position when their phone goes quiet\n"
    "• unlink Name\n"
    "• remove Name\n"
    "• channel: the link that puts a tracker on our private channel\n"
    "• gps: where I am, and the satellites I can see\n"
    "• status";
const int64_t SELF_EVERY = 10 * MIN;  // the home base's own pin, from its GPS (skipped when unchanged)
const int64_t PENDING_EVERY = 8 * 1000;  // collect Locate, chirps and check-ins for trackers
const int64_t PLACES_EVERY = 10 * MIN;   // the circle's places, for arrived and left
const int64_t CHECKIN_FOR = 2 * 60 * MIN;  // how long an "ok" from the tracker answers a check-in
const int64_t TRACE_GAP = 1 * MIN;         // at most one traceroute a minute per tracker (airtime)
const int64_t PATH_FOR = 6 * 60 * MIN;     // a path older than this isn't shown
const int64_t STATUS_EVERY = 1 * MIN;      // its own status for the app's Trackers screen (it has mains or solar power)
const int64_t RECORD_REREAD = 10 * MIN;    // between full reads of its member record when writing the status
const int64_t OFF_RECHECK = 1 * MIN;       // while the plugin is off: how often to look whether it's back on

double metres(double lat1, double lng1, double lat2, double lng2) {
  const double r = 6371000.0, rad = M_PI / 180.0;
  double dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  double a = sin(dLat / 2) * sin(dLat / 2) + cos(lat1 * rad) * cos(lat2 * rad) * sin(dLng / 2) * sin(dLng / 2);
  return 2 * r * atan2(sqrt(a), sqrt(1 - a));
}

// Inside, outside, or too close to the edge to tell: the apps' rule (packages/core places.js).
const char* placeState(double distance, double accuracy, double radius) {
  double acc = accuracy > 0 ? accuracy : 50;
  if (acc > 250) {
    if (distance + acc < radius) return "inside";
    if (distance - acc > radius) return "outside";
    return nullptr;
  }
  if (distance <= radius) return "inside";
  double margin = std::max(30.0, std::min(acc, 100.0));
  if (distance >= radius + margin) return "outside";
  return nullptr;
}

std::string lower(std::string s) {
  for (auto& c : s) c = (char)tolower((unsigned char)c);
  return s;
}

std::string trim(const std::string& s) {
  size_t a = s.find_first_not_of(" \t\r\n");
  if (a == std::string::npos) return "";
  size_t b = s.find_last_not_of(" \t\r\n");
  return s.substr(a, b - a + 1);
}

/** Split "a to b" at " to " (case doesn't matter). */
bool splitTo(const std::string& s, std::string& a, std::string& b) {
  std::string l = lower(s);
  size_t at = l.find(" to ");
  if (at == std::string::npos) return false;
  a = trim(s.substr(0, at));
  b = trim(s.substr(at + 4));
  return !a.empty() && !b.empty();
}

std::string ago(int64_t ms) {
  if (ms <= 0) return "never";
  int64_t m = ms / MIN;
  char buf[32];
  if (m < 1) return "just now";
  if (m < 60) snprintf(buf, sizeof buf, "%d min ago", (int)m);
  else if (m < 48 * 60) snprintf(buf, sizeof buf, "%d h ago", (int)(m / 60));
  else snprintf(buf, sizeof buf, "%d days ago", (int)(m / 1440));
  return buf;
}

}  // namespace

std::string nodeId(uint32_t num) {
  char buf[12];
  snprintf(buf, sizeof buf, "!%08x", (unsigned)num);
  return buf;
}

bool parseNodeId(const std::string& raw, uint32_t& num) {
  std::string s = trim(raw);
  if (!s.empty() && s[0] == '!') s = s.substr(1);
  if (s.size() != 8) return false;
  for (char c : s)
    if (!isxdigit((unsigned char)c)) return false;
  num = (uint32_t)strtoul(s.c_str(), nullptr, 16);
  return true;
}

HomeBase::HomeBase(Http& http, Store& store, int64_t (*nowMs)(), Radio& radio)
    : http_(http), store_(store), now_(nowMs), radio_(radio), base_(http, store, nowMs) {}

// --- the saved list ---------------------------------------------------------------

HomeBase::Tracker& HomeBase::adopt(uint32_t node) {
  std::unique_ptr<Tracker> t(new Tracker());
  t->node = node;
  t->store.reset(new PrefixStore(store_, "t" + nodeId(node).substr(1) + "."));
  t->dev.reset(new Device(http_, *t->store, now_));
  trackers_.push_back(std::move(t));
  return *trackers_.back();
}

bool HomeBase::load() {
  trackers_.clear();
  if (!base_.load()) return false;
  std::string raw;
  JsonDocument d;
  if (store_.get("trackers", raw) && !deserializeJson(d, raw)) {
    for (JsonObjectConst o : d.as<JsonArrayConst>()) {
      uint32_t node;
      if (!parseNodeId(o["node"] | "", node)) continue;
      Tracker& t = adopt(node);
      t.name = o["name"] | "";
      t.kind = o["kind"] | "person";
      t.carriedBy = o["carriedBy"] | "";
      t.keeperSet = o["keeper"] | false;
      if (!t.dev->load()) trackers_.pop_back();  // its account is gone: drop it
    }
  }
  return true;
}

void HomeBase::saveTrackers() {
  JsonDocument d;
  JsonArray a = d.to<JsonArray>();
  for (auto& t : trackers_) {
    JsonObject o = a.add<JsonObject>();
    o["node"] = nodeId(t->node);
    o["name"] = t->name;
    o["kind"] = t->kind;
    if (!t->carriedBy.empty()) o["carriedBy"] = t->carriedBy;
    if (t->keeperSet) o["keeper"] = true;
  }
  std::string raw;
  serializeJson(d, raw);
  store_.put("trackers", raw);
}

Status HomeBase::setup(const std::string& invite, const std::string& name) {
  Status s = base_.join(invite, name);
  if (s == Status::Ok) {
    std::vector<Device::Direct> none;
    base_.fetchDirect(none);  // start reading messages from now
  }
  return s;
}

void HomeBase::forget() {
  for (auto& t : trackers_) t->dev->forget();
  trackers_.clear();
  store_.remove("trackers");
  base_.forget();
}

HomeBase::Tracker* HomeBase::byNode(uint32_t node) {
  for (auto& t : trackers_)
    if (t->node == node) return t.get();
  return nullptr;
}

bool HomeBase::isTracker(uint32_t node) const {
  for (auto& t : trackers_)
    if (t->node == node) return true;
  return false;
}

HomeBase::Tracker* HomeBase::find(const std::string& ref) {
  uint32_t node;
  if (parseNodeId(ref, node)) return byNode(node);
  std::string want = lower(trim(ref));
  for (auto& t : trackers_)
    if (lower(t->name) == want) return t.get();
  return nullptr;
}

// The tracker's member record: its mode, node id and who carries it, so the
// apps can show a person at their tracker when their phone is quiet.
void HomeBase::writeRecord(Tracker& t) {
  if (!base_.amAdmin()) return;
  JsonDocument p;
  JsonObject tr = p["tracker"].to<JsonObject>();
  tr["mode"] = t.kind == "car" ? "car" : "carried";
  tr["node"] = nodeId(t.node);
  if (!t.carriedBy.empty()) tr["carriedBy"] = t.carriedBy;
  base_.mergeMemberRecord(t.dev->memberId(), p.as<JsonVariantConst>());
}

// --- from the radio -----------------------------------------------------------------

void HomeBase::onPosition(uint32_t node, const Fix& fix, int64_t fixTimeMs) {
  Tracker* t = byNode(node);
  if (!t) return;
  if (!fixTimeMs) fixTimeMs = now_();
  if (fixTimeMs <= t->sentFixAt || (t->pending && fixTimeMs <= t->fixAt)) return;
  t->fix = fix;
  t->fixAt = fixTimeMs;
  t->pending = true;
}

void HomeBase::onText(uint32_t node, const std::string& text) {
  Tracker* t = byNode(node);
  if (!t) return;
  std::string l = lower(text);
  bool alert = l.find('\a') != std::string::npos;
  for (auto& w : sosWords_) alert = alert || l.find(w) != std::string::npos;
  bool safe = l == "safe" || l == "ok" || l == "i'm ok" || l == "im ok" || l.find("i'm safe") != std::string::npos;
  if (alert && !t->dev->sosActive()) {
    t->dev->sos(true, false);
    t->sosChanged = true;
  } else if (safe && t->dev->sosActive()) {
    t->dev->sos(false, false);
    t->sosChanged = true;
  } else if (safe && !t->checkins.empty()) {
    t->okPressed = true;  // answered in tick(): "I'm OK" to whoever asked
  }
}

void HomeBase::onMeshPacket(const Bytes& packet) {
  if (packet.size() < 20 || packet[0] != 0x68 || packet[1] != 0x63) return;
  std::string b = toB64(packet);
  if (std::find(meshQueue_.begin(), meshQueue_.end(), b) != meshQueue_.end()) return;
  meshQueue_.push_back(b);
  if (meshQueue_.size() > 40) meshQueue_.erase(meshQueue_.begin());
}

// --- the work -------------------------------------------------------------------------

void HomeBase::forwardMesh() {
  if (meshQueue_.empty()) return;
  JsonDocument req;
  JsonArray a = req["packets"].to<JsonArray>();
  size_t n = std::min<size_t>(meshQueue_.size(), 20);
  for (size_t i = 0; i < n; i++) a.add(meshQueue_[i]);
  std::string body;
  serializeJson(req, body);
  HttpResponse r = http_.request("POST", base_.server() + "/api/v1/mesh/packets", "", body);
  // Kept for later only if the server didn't answer; anything it answered is done.
  if (r.status > 0 && r.status != 429 && r.status < 500) meshQueue_.erase(meshQueue_.begin(), meshQueue_.begin() + n);
}

void HomeBase::upload(Tracker& t) {
  if (t.sosChanged) {
    if (t.dev->flushSos() == Status::Ok) t.sosChanged = false;
  }
  if (t.okPressed) {
    int64_t at = now_();
    for (auto& c : t.checkins)
      if (at - c.second < CHECKIN_FOR) t.dev->sendDirect(c.first, "\xE2\x9C\x85 I\xE2\x80\x99m OK", true);
    t.checkins.clear();
    t.okPressed = false;
    log = t.name + " checked in";
  }
  if (!t.pending && t.pathDirty && t.sentFixAt) {
    // A new path for the position already on the map: send it again with the path.
    JsonDocument extra;
    meshInfo(t, extra);
    if (t.dev->shareLocation(t.sentFix, "update", 15, 15, "meshtastic", true, t.sentFixAt, extra.as<JsonVariantConst>()) == Status::Ok) {
      t.pathDirty = false;
      log = "sent " + t.name + "'s radio path";
    }
  }
  if (!t.pending) return;
  int64_t now = now_();
  if (traceEveryMs_ > 0 && now - t.tracedAt >= traceEveryMs_) {
    radio_.traceroute(t.node);
    t.tracedAt = now;
  }
  bool asked = t.askedAt && t.askedAt > t.sentFixAt;
  if (!t.dev->sosActive() && !asked && now - t.sentAt < SEND_GAP) return;
  const char* trigger = t.dev->sosActive() ? "sos" : asked ? "requested" : "update";
  // Stock trackers broadcast their position on their own schedule (15 minutes by default).
  std::vector<std::pair<const Place*, std::string>> moves = checkPlaces(t, t.fix);
  JsonDocument extra;
  meshInfo(t, extra);
  Status s = t.dev->shareLocation(t.fix, trigger, 15, 15, "meshtastic", true, t.fixAt, extra.as<JsonVariantConst>());
  if (s == Status::Ok) {
    t.pending = false;
    t.pathDirty = false;
    t.sentFix = t.fix;
    t.sentFixAt = t.fixAt;
    t.sentAt = now;
    log = "sent " + t.name + "'s position";
    // Arrived and left, as a phone announces them (only where the circle has place alerts on).
    if (base_.feature("placeAlerts")) {
      for (auto& m : moves) {
        JsonDocument ev;
        ev["type"] = "place";
        ev["action"] = m.second;
        ev["placeId"] = m.first->id;
        ev["placeName"] = m.first->name;
        ev["at"] = t.fixAt;
        if (t.dev->postEvent(ev.as<JsonVariantConst>()) == Status::Ok) log = t.name + " " + m.second + " " + m.first->name;
      }
    }
  } else if (s == Status::Removed) {
    log = t.name + " was removed from the circle";
    t.dev->forget();
    t.pending = false;
  }
}

std::vector<std::pair<const Place*, std::string>> HomeBase::checkPlaces(Tracker& t, Fix& fix) {
  std::vector<std::pair<const Place*, std::string>> moves;
  fix.placeId.clear();
  for (auto& p : places_) {
    const char* state = placeState(metres(fix.lat, fix.lng, p.lat, p.lng), fix.accuracy, p.radius);
    if (!state) continue;  // too close to the edge: wait for the next position
    std::string action = strcmp(state, "inside") == 0 ? "arrived" : "left";
    if (action == "arrived" && fix.placeId.empty()) fix.placeId = p.id;
    auto prev = t.atPlaces.find(p.id);
    bool first = prev == t.atPlaces.end();
    if (!first && prev->second == action) continue;
    t.atPlaces[p.id] = action;
    if (!first) moves.push_back({&p, action});  // the first look only notes where it is
  }
  return moves;
}

void HomeBase::onRoute(uint32_t node, const std::vector<uint32_t>& back, const std::vector<int>& snrBack4) {
  Tracker* t = byNode(node);
  if (!t) return;
  std::vector<Tracker::Hop> path;
  Tracker::Hop first;
  first.num = node;
  first.name = t->name;
  path.push_back(first);
  for (size_t i = 0; i < back.size(); i++) {
    Tracker::Hop h;
    h.num = back[i];
    h.name = back[i] == 0xffffffff ? "" : radio_.nodeName(back[i]);  // 0xffffffff: a relay that didn't say who it is
    if (i < snrBack4.size() && snrBack4[i] != -128) h.snr = snrBack4[i] / 4.0f, h.hasSnr = true;
    path.push_back(h);
  }
  Tracker::Hop home;
  home.name = base_.name();
  if (snrBack4.size() > back.size() && snrBack4[back.size()] != -128) home.snr = snrBack4[back.size()] / 4.0f, home.hasSnr = true;
  path.push_back(home);
  t->path = path;
  t->pathAt = now_();
  t->pathDirty = true;
  log = t->name + "'s radio path: " + std::to_string(back.size()) + " relay(s)";
}

void HomeBase::meshInfo(Tracker& t, JsonDocument& out) {
  JsonObject m = out["mesh"].to<JsonObject>();
  bool fresh = !t.path.empty() && now_() - t.pathAt < PATH_FOR;
  int hops = fresh ? (int)t.path.size() - 2 : radio_.hopsAway(t.node);
  if (hops >= 0) m["hops"] = hops;
  if (!fresh) return;
  m["at"] = t.pathAt;
  JsonArray a = m["path"].to<JsonArray>();
  for (size_t i = 0; i < t.path.size(); i++) {
    const Tracker::Hop& h = t.path[i];
    JsonObject o = a.add<JsonObject>();
    if (i + 1 < t.path.size()) o["id"] = h.num == 0xffffffff ? std::string("?") : nodeId(h.num);  // the home base is the last
    if (!h.name.empty()) o["name"] = h.name;
    if (h.hasSnr) o["snr"] = h.snr;
  }
}

// A request for a tracker, passed on by the server: Locate, a chirp, or a direct message.
void HomeBase::handle(const Pending& p) {
  Tracker* t = nullptr;
  for (auto& x : trackers_)
    if (x->dev->memberId() == p.member) t = x.get();
  if (!t) return;
  int64_t now = now_();
  std::string who = base_.nameOf(p.from);
  if (who.empty()) who = "Someone";
  if (p.type == "locate") {
    radio_.requestPosition(t->node);
    t->askedAt = now;
    if (now - t->tracedAt >= TRACE_GAP) {
      radio_.traceroute(t->node);
      t->tracedAt = now;
    }
    log = who + " asked where " + t->name + " is";
  } else if (p.type == "chirp") {
    radio_.alert(t->node, "\a" + who + " chirped you");
    log = who + " chirped " + t->name;
  } else if (p.type == "message") {
    t->dev->startDirectAt(p.seq - 1);
    std::vector<Device::Direct> in;
    if (t->dev->fetchDirect(in) != Status::Ok) return;
    for (auto& d : in) {
      if (d.checkin != "request") continue;
      radio_.alert(t->node, "\aCheck in, please: " + d.fromName + " asked. Reply OK.");
      radio_.requestPosition(t->node);
      t->askedAt = now;
      t->checkins.push_back({d.from, now});
      log = d.fromName + " asked " + t->name + " to check in";
    }
  }
}

// When someone's phone has gone quiet, ask the tracker they carry where it is.
void HomeBase::watch() {
  bool any = false;
  for (auto& t : trackers_) any = any || !t->carriedBy.empty();
  if (!any) return;
  std::vector<Device::MemberLoc> locs;
  if (base_.memberLocations(locs) != Status::Ok) return;
  int64_t now = now_();
  for (auto& t : trackers_) {
    if (t->carriedBy.empty()) continue;
    const Device::MemberLoc* phone = nullptr;
    for (auto& l : locs)
      if (l.memberId == t->carriedBy) phone = &l;
    // Someone who paused sharing chose not to be found: leave their tracker alone.
    if (phone && phone->paused) continue;
    int64_t quietAfter = std::max(quietMs_, (int64_t)(phone && phone->stillMin ? phone->stillMin * 2 + 5 : 0) * MIN);
    bool quiet = !phone || now - phone->ts > quietAfter;
    bool trackerFresh = t->sentFixAt && now - t->sentFixAt < ASK_GAP;
    if (quiet && !trackerFresh && now - t->askedAt >= ASK_GAP) {
      radio_.requestPosition(t->node);
      t->askedAt = now;
      log = base_.nameOf(t->carriedBy) + "'s phone is quiet: asked " + t->name + " for a position";
    }
  }
}

void HomeBase::tick() {
  if (!ready()) return;
  int64_t now = now_();
  forwardMesh();
  if (now >= nextPlaces_) {
    bool wasOn = enabled_;
    base_.refresh();  // features (place alerts, the plugin) and new members
    readPlugin();
    // Off: look again every minute, so turning it on takes effect quickly.
    nextPlaces_ = now + (enabled_ ? PLACES_EVERY : OFF_RECHECK);
    if (enabled_) {
      base_.fetchPlaces(places_);
      if (!wasOn) nextKeeper_ = nextPending_ = nextStatus_ = now;  // just turned on: catch up now
    }
  }
  if (!enabled_) {
    // Meshtastic trackers are off in this circle: only answer admins, and
    // keep saying it's alive so the app doesn't show it as offline.
    if (now >= nextDirect_) {
      nextDirect_ = now + DIRECT_EVERY;
      std::vector<Device::Direct> in;
      if (base_.fetchDirect(in) == Status::Ok)
        for (auto& d : in)
          base_.sendDirect(d.from, "Meshtastic trackers are turned off in this circle. An admin can turn them on in Settings \xE2\x86\x92 Features \xE2\x86\x92 Plugins.");
    }
    if (now >= nextStatus_) {
      nextStatus_ = now + STATUS_EVERY;
      publishStatus();
    }
    return;
  }
  // Trackers added before keepers existed: tell the server who keeps them.
  // (A server from before keepers says no: try again in a while, not every tick.)
  if (now >= nextKeeper_) {
    nextKeeper_ = now + PLACES_EVERY;
    for (auto& t : trackers_) {
      if (t->keeperSet || !t->dev->joined()) continue;
      if (t->dev->registerKeeper(base_.memberId()) == Status::Ok) {
        t->keeperSet = true;
        std::vector<Device::Direct> none;
        t->dev->fetchDirect(none);  // read its direct messages from now on
        saveTrackers();
      }
    }
  }
  if (now >= nextPending_ && !trackers_.empty()) {
    nextPending_ = now + PENDING_EVERY;
    std::vector<Pending> items;
    if (base_.keeperPending(items) == Status::Ok) {
      for (auto& p : items) handle(p);
    } else {
      nextPending_ = now + PLACES_EVERY;  // a server without keepers yet: ask again later
    }
  }
  for (auto& t : trackers_)
    if (t->dev->joined()) upload(*t);
  // Trackers whose account is gone (removed) leave the list.
  size_t before = trackers_.size();
  trackers_.erase(std::remove_if(trackers_.begin(), trackers_.end(), [](const std::unique_ptr<Tracker>& t) { return !t->dev->joined(); }),
                  trackers_.end());
  if (trackers_.size() != before) saveTrackers();
  if (now >= nextDirect_) {
    nextDirect_ = now + DIRECT_EVERY;
    std::vector<Device::Direct> in;
    if (base_.fetchDirect(in) == Status::Ok)
      for (auto& d : in) command(d);
  }
  if (now >= nextWatch_) {
    nextWatch_ = now + WATCH_EVERY;
    watch();
  }
  if (now - selfSharedAt_ >= SELF_EVERY) shareSelf(false);
  if (now >= nextStatus_) {
    nextStatus_ = now + STATUS_EVERY;
    publishStatus();
  }
}

// The Meshtastic plugin (Settings → Features → Plugins): whether it's on, and
// the settings an admin chose. A server that doesn't know the plugin (older
// than 0.25) counts as on, with the defaults.
void HomeBase::readPlugin() {
  enabled_ = base_.featureOr("meshtastic", true);
  if (!enabled_ || !base_.amAdmin()) return;
  JsonDocument s;
  if (base_.pluginSettings("meshtastic", s) != Status::Ok) return;
  JsonObjectConst v = s["values"];
  int quiet = atoi(v["quietMinutes"] | "");
  quietMs_ = (quiet >= 10 && quiet <= 720 ? quiet : 30) * MIN;
  std::string trace = v["traceMinutes"] | "";
  int every = atoi(trace.c_str());
  traceEveryMs_ = trace == "0" ? 0 : (every >= 10 && every <= 720 ? every : 30) * MIN;
  std::string words = v["sosWords"] | "";
  std::vector<std::string> list;
  for (size_t at = 0; at <= words.size();) {
    size_t comma = words.find(',', at);
    std::string w = lower(trim(words.substr(at, comma == std::string::npos ? std::string::npos : comma - at)));
    if (w.size() >= 2) list.push_back(w);
    if (comma == std::string::npos) break;
    at = comma + 1;
  }
  sosWords_ = list.empty() ? std::vector<std::string>{"sos", "help"} : list;
}

// The app's Trackers screen reads this: that the home base is alive, the
// nodes it hears (to add as trackers), and when it last heard each tracker.
void HomeBase::publishStatus() {
  if (!base_.amAdmin()) return;  // only admins write member records
  JsonDocument p;
  JsonObject h = p["homeBase"].to<JsonObject>();
  h["at"] = now_();
  h["every"] = (int)(STATUS_EVERY / 1000);  // so the app knows when it's late
  h["quietMinutes"] = (int)(quietMs_ / MIN);  // the app shows people at their tracker after the same time
  auto tenth = [](float v) { return std::round(v * 10) / 10; };
  SelfInfo me;
  if (radio_.selfInfo(me)) {
    JsonObject s = h["self"].to<JsonObject>();
    if (me.battery >= 0 && me.battery <= 100) s["battery"] = me.battery;
    if (me.volts > 0) s["volts"] = tenth(me.volts);
    s["plugged"] = me.plugged || me.battery > 100;
    if (me.wifiRssi < 0) s["wifi"] = me.wifiRssi;
    if (me.uptimeS >= 0) s["up"] = me.uptimeS;
    if (me.heapKb >= 0) s["heap"] = me.heapKb;
    if (me.chUtil >= 0) s["ch"] = tenth(me.chUtil);
    if (me.airTx >= 0) s["tx"] = tenth(me.airTx);
  }
  SelfGnss g;
  if (radio_.selfGnss(g) && g.present) {
    JsonObject o = h["gps"].to<JsonObject>();
    o["fix"] = g.hasFix;
    o["sats"] = g.satsUsed;
    if (g.hdop >= 0) o["hdop"] = tenth(g.hdop);
  }
  std::vector<HeardNode> heard;
  radio_.nodes(heard);
  std::sort(heard.begin(), heard.end(), [](const HeardNode& a, const HeardNode& b) { return a.heardAtMs > b.heardAtMs; });
  // What the radio knows about a node: signal, hops and battery.
  auto radioFacts = [&](JsonObject o, const HeardNode& n) {
    o["at"] = n.heardAtMs;
    int hops = radio_.hopsAway(n.num);
    if (hops >= 0) o["hops"] = hops;
    if (n.snr > -100) o["snr"] = tenth(n.snr);
    if (n.battery >= 0 && n.battery <= 100) o["battery"] = n.battery;
    if (n.battery > 100) o["plugged"] = true;
    if (n.volts > 0) o["volts"] = tenth(n.volts);
  };
  JsonArray hn = h["heard"].to<JsonArray>();
  for (size_t i = 0; i < heard.size() && i < 20; i++) {
    JsonObject o = hn.add<JsonObject>();
    o["node"] = nodeId(heard[i].num);
    if (!heard[i].name.empty()) o["name"] = heard[i].name;
    radioFacts(o, heard[i]);
  }
  JsonArray tr = h["trackers"].to<JsonArray>();
  for (auto& t : trackers_) {
    JsonObject o = tr.add<JsonObject>();
    o["node"] = nodeId(t->node);
    o["member"] = t->dev->memberId();
    if (t->sentFixAt) o["at"] = t->sentFixAt;  // its last position on the map
    for (auto& n : heard)
      if (n.num == t->node) {
        JsonObject r = o["radio"].to<JsonObject>();
        radioFacts(r, n);
      }
  }
  // Every minute: reuse the rest of its record for a while instead of reading
  // every member's record each time (admins rarely change the home base's).
  base_.mergeMemberRecord(base_.memberId(), p.as<JsonVariantConst>(), RECORD_REREAD);
}

bool HomeBase::shareSelf(bool asked) {
  SelfGnss g;
  if (!radio_.selfGnss(g) || !g.present || !g.hasFix) return false;
  int64_t now = now_();
  // Unchanged since the last time: nothing new for the map (unless someone asked).
  if (!asked && g.fixAtMs && g.fixAtMs <= selfFixSent_) {
    selfSharedAt_ = now;
    return true;
  }
  Fix f;
  f.lat = g.lat;
  f.lng = g.lng;
  f.accuracy = g.accuracyM;
  if (base_.shareLocation(f, asked ? "requested" : "update", 60, 60, "homebase", false, g.fixAtMs) == Status::Ok) {
    selfSharedAt_ = now;
    selfFixSent_ = g.fixAtMs;
    log = "shared the home base's own position";
  }
  return true;
}

// --- admins' commands -------------------------------------------------------------

std::string HomeBase::listText() {
  int64_t now = now_();
  std::string out;
  if (trackers_.empty()) out = "No trackers yet.";
  else out = "Trackers:";
  for (auto& t : trackers_) {
    out += "\n• " + t->name + " (" + nodeId(t->node) + ")";
    if (t->kind == "car") out += ", a car";
    if (!t->carriedBy.empty()) out += ", carried by " + base_.nameOf(t->carriedBy);
    out += ", last position " + ago(t->sentFixAt ? now - t->sentFixAt : 0);
    if (t->dev->sosActive()) out += ", SOS ON";
  }
  std::vector<HeardNode> heard;
  radio_.nodes(heard);
  std::string others;
  for (auto& h : heard) {
    if (isTracker(h.num)) continue;
    others += "\n• " + nodeId(h.num) + (h.name.empty() ? "" : " " + h.name) + " (" + ago(now - h.heardAtMs) + ")";
  }
  if (!others.empty()) out += "\n\nNodes I can hear that aren't trackers yet:" + others + "\n\nAdd one with: add !id Name";
  return out;
}

void HomeBase::command(const Device::Direct& d) {
  std::string text = trim(d.text);
  std::string l = lower(text);
  size_t sp = l.find(' ');
  std::string verb = l.substr(0, sp);
  std::string rest = sp == std::string::npos ? "" : trim(text.substr(sp + 1));
  std::string reply;
  bool changes = verb == "add" || verb == "rename" || verb == "remove" || verb == "link" || verb == "unlink";
  // Roles and names change (someone made this home base an admin, someone joined): look first.
  if (changes || verb == "status") base_.refresh();

  if (changes && !d.fromAdmin) {
    reply = "Only the circle's admins can change trackers.";
  } else if (verb == "list" || verb == "trackers") {
    reply = listText();
  } else if (verb == "status") {
    reply = "Home base in " + base_.circleName() + ". " + std::to_string(trackers_.size()) + " tracker(s). " +
            (base_.amAdmin() ? "I'm an admin, so I can add trackers myself." : "I'm not an admin yet: make me one so I can add trackers.");
  } else if (verb == "gps" || verb == "where" || verb == "location" || verb == "satellites" || verb == "sats") {
    SelfGnss g;
    bool have = radio_.selfGnss(g);
    reply = describeGnss(have ? &g : nullptr, radio_.sky(), now_());
    if (have && g.hasFix && shareSelf(true)) reply += "\n\nHome base is on the map at this position.";
  } else if (verb == "channel") {
    reply = "Open this on a phone paired with the tracker in the Meshtastic app to put it on our private channel:\n" + radio_.channelLink();
  } else if (verb == "add") {
    // add !a1b2c3d4 Name [as car|as person] [invite link]
    size_t s2 = rest.find(' ');
    uint32_t node;
    std::string name = s2 == std::string::npos ? "" : trim(rest.substr(s2 + 1));
    std::string link, kind = "person";
    size_t h = name.find("http");
    if (h == std::string::npos) h = name.find("homecircle://");
    if (h != std::string::npos) {
      link = trim(name.substr(h));
      name = trim(name.substr(0, h));
    }
    std::string ln = lower(name);
    if (ln.size() > 7 && ln.compare(ln.size() - 7, 7, " as car") == 0) kind = "car", name = trim(name.substr(0, name.size() - 7));
    else if (ln.size() > 10 && ln.compare(ln.size() - 10, 10, " as person") == 0) name = trim(name.substr(0, name.size() - 10));
    if (!parseNodeId(rest.substr(0, s2), node) || name.empty()) {
      reply = "Use: add !a1b2c3d4 Name (the node id is in the Meshtastic app, or send \"list\").";
    } else if (byNode(node)) {
      reply = nodeId(node) + " is already " + byNode(node)->name + ".";
    } else {
      Status st = Status::Ok;
      if (link.empty()) {
        if (!base_.amAdmin()) st = Status::Failed;
        else st = base_.createInvite(link, 1);
      }
      if (link.empty()) {
        reply = base_.amAdmin() ? "Couldn't make an invite: " + base_.error()
                                : "I'm not an admin, so I can't invite the tracker myself. Make me an admin, or add an invite link to the message.";
      } else {
        Tracker& t = adopt(node);
        t.name = name;
        t.kind = kind;
        st = t.dev->join(link, name);
        if (st == Status::Ok) {
          if (t.dev->registerKeeper(base_.memberId()) == Status::Ok) {
            t.keeperSet = true;
            std::vector<Device::Direct> none;
            t.dev->fetchDirect(none);
          }
          saveTrackers();
          writeRecord(t);
          reply = "Added " + name + " (" + nodeId(node) + "). It shows on the map with its next position. Make sure it's on our channel: send \"channel\".";
        } else {
          reply = "Couldn't add it: " + t.dev->error();
          trackers_.pop_back();
        }
      }
    }
  } else if (verb == "rename") {
    std::string a, b;
    Tracker* t = splitTo(rest, a, b) ? find(a) : nullptr;
    if (!t) reply = "Use: rename Name to New name";
    else if (t->dev->rename(b) == Status::Ok) {
      reply = t->name + " is now " + b + ".";
      t->name = b;
      saveTrackers();
    } else reply = "Couldn't rename it: " + t->dev->error();
  } else if (verb == "link") {
    std::string a, b;
    Tracker* t = splitTo(rest, a, b) ? find(a) : nullptr;
    std::string who = t ? base_.memberByName(b) : "";
    if (!t) reply = "Use: link Tracker name to Person";
    else if (who.empty()) reply = "I don't know one person called " + b + " in the circle.";
    else {
      t->carriedBy = who;
      saveTrackers();
      writeRecord(*t);
      reply = t->name + " is carried by " + base_.nameOf(who) + ". When their phone goes quiet, I'll ask it where it is.";
    }
  } else if (verb == "unlink") {
    Tracker* t = find(rest);
    if (!t) reply = "Use: unlink Tracker name";
    else {
      t->carriedBy.clear();
      saveTrackers();
      writeRecord(*t);
      reply = t->name + " isn't linked to anyone now.";
    }
  } else if (verb == "remove") {
    Tracker* t = find(rest);
    if (!t) reply = "Use: remove Tracker name";
    else {
      std::string name = t->name;
      Status st = t->dev->leave();
      if (st == Status::Ok) {
        trackers_.erase(std::remove_if(trackers_.begin(), trackers_.end(), [&](const std::unique_ptr<Tracker>& x) { return x.get() == t; }),
                        trackers_.end());
        saveTrackers();
        reply = "Removed " + name + " from the circle.";
      } else reply = "Couldn't remove it: " + t->dev->error();
    }
  } else {
    reply = HELP;
  }
  base_.sendDirect(d.from, reply);
  log = "command from " + d.fromName + ": " + verb;
}

}  // namespace hc
