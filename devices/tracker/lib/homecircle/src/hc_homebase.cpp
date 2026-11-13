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
    "• add !a1b2c3d4 Name (add \"as car\", \"as pet\", \"as luggage\", \"as keys\" or \"as other\" if no one carries it)\n"
    "• add <the tracker's Share contact link> [Name] [as …]\n"
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
const int64_t STALE_FIX = 20 * MIN;        // a tracker's position older than this isn't where it is (the app's "Away")
const size_t LOG_KEEP = 30;               // positions heard per tracker, kept for the trip on the map
const int64_t LOCATE_WAIT = 3 * MIN;        // a Locate the tracker hasn't answered: say so in the chat
const int64_t INTRODUCE_EVERY = 12 * 60 * MIN;  // send each tracker this node's key again (it may have forgotten)
const int64_t CONFIG_RETRY = 10 * MIN;     // a tracker that didn't confirm its settings: try again
const int64_t CONFIG_NO_KEY = 60 * MIN;    // one that doesn't take the home base's key yet: try now and then

// What a tracker is for: the member record's tracker.mode.
const char* const KINDS[] = {"carried", "car", "pet", "luggage", "keys", "other"};
std::string kindOf(const std::string& s) {
  if (s == "person") return "carried";
  for (const char* k : KINDS)
    if (s == k) return k;
  return "";
}

// What 1 to 5 presses say unless the circle or the tracker chose its own (as the server's plugin).
const char* const PRESS_DEFAULTS[6] = {"", "\xE2\x9C\x85 I\xE2\x80\x99m OK", "\xF0\x9F\x93\x8D Here\xE2\x80\x99s where I am",
                                       "\xF0\x9F\x9A\x97 Please come pick me up", "\xF0\x9F\x8F\xA0 I\xE2\x80\x99m on my way home",
                                       "\xF0\x9F\x86\x98 I need help"};

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
  // The trackers load even if its own account doesn't: joining again keeps them.
  bool joined = base_.load();
  std::string raw;
  JsonDocument d;
  if (store_.get("trackers", raw) && !deserializeJson(d, raw)) {
    for (JsonObjectConst o : d.as<JsonArrayConst>()) {
      uint32_t node;
      if (!parseNodeId(o["node"] | "", node)) continue;
      Tracker& t = adopt(node);
      t.name = o["name"] | "";
      t.kind = kindOf(o["kind"] | "carried");
      if (t.kind.empty()) t.kind = "carried";
      t.carriedBy = o["carriedBy"] | "";
      t.keeperSet = o["keeper"] | false;
      t.configSet = o["config"] | "";
      if (!t.configSet.empty()) t.configState = "set";
      if (!t.dev->load()) trackers_.pop_back();  // its account is gone: drop it
    }
  }
  return joined;
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
    if (!t->configSet.empty()) o["config"] = t->configSet;
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
    // Joined again (a new member, say after its account was lost): the trackers it
    // kept name this new home base as their keeper, and get its settings again.
    for (auto& t : trackers_) {
      t->keeperSet = false;
      t->configSet.clear();
      t->configState.clear();
    }
    nextKeeper_ = 0;
    saveTrackers();
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
  readCustoms(false);  // keep the settings an admin gave it in the app
  JsonDocument p;
  JsonObject tr = p["tracker"].to<JsonObject>();
  tr["mode"] = t.kind;
  tr["node"] = nodeId(t.node);
  if (!t.carriedBy.empty()) tr["carriedBy"] = t.carriedBy;
  JsonDocument custom;
  if (!t.custom.empty() && !deserializeJson(custom, t.custom)) tr["custom"] = custom.as<JsonVariantConst>();
  base_.mergeMemberRecord(t.dev->memberId(), p.as<JsonVariantConst>());
}

// --- from the radio -----------------------------------------------------------------

const char* sourceName(Source s) {
  return s == Source::Internet ? "internet" : s == Source::Phone ? "phone" : s == Source::Beacon ? "beacon" : "radio";
}

void HomeBase::onPosition(uint32_t node, const Fix& fix, int64_t fixTimeMs) {
  Tracker* t = byNode(node);
  if (!t) return;
  if (!fixTimeMs) fixTimeMs = now_();
  if (fixTimeMs <= t->sentFixAt || (t->pending && fixTimeMs <= t->fixAt)) return;
  t->fix = fix;
  t->fixAt = fixTimeMs;
  t->pending = true;
  // How it came: the packet heard just now (a position arrives as a packet, then in the node's list).
  bool recent = now_() - t->lastRx.at < MIN;
  t->fixSrc = recent ? t->lastRx.src : Source::Radio;
  t->fixGateway = recent ? t->lastRx.gateway : "";
}

void HomeBase::onText(uint32_t node, const std::string& text) {
  Tracker* t = byNode(node);
  if (!t) return;
  std::string l = lower(text);
  // The HomeCircle tracker firmware counts button presses and says "#press N".
  if (l.rfind("#press ", 0) == 0) {
    int n = atoi(l.c_str() + 7);
    if (n == 1) {
      if (!t->checkins.empty()) t->okPressed = true;  // otherwise a bump in a pocket: nothing to send
    } else if (n >= 2 && n <= 4) {
      t->presses.push_back(n);
      t->askedAt = now_();  // its next position goes out at once (the firmware sends one with the press)
    }
    return;  // 5 presses come as an SOS text
  }
  bool alert = l.find('\a') != std::string::npos;
  for (auto& w : sosWords_) alert = alert || l.find(w) != std::string::npos;
  bool safe = l == "safe" || l == "ok" || l == "i'm ok" || l == "im ok" || l.find("i'm safe") != std::string::npos;
  if (alert && !t->dev->sosActive()) {
    t->dev->sos(true, false);
    t->sosChanged = true;
    t->presses.push_back(5);  // and the SOS message in the chat
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
  if (!t.presses.empty()) {
    int n = t.presses.front();
    // 3 presses (come pick me up) and SOS alert even when the chat is muted.
    if (t.dev->sendGroup(pressText(t, n), n == 3 || n == 5) == Status::Ok) {
      t.presses.erase(t.presses.begin());
      log = t.name + ": " + std::to_string(n) + " presses";
    }
  }
  if (t.okPressed) {
    int64_t at = now_();
    for (auto& c : t.checkins)
      if (at - c.second < CHECKIN_FOR) t.dev->sendDirect(c.first, pressText(t, 1), true);
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
    Tracker::Heard h;
    h.at = t.fixAt;
    h.lat = t.fix.lat;
    h.lng = t.fix.lng;
    bool fresh = t.lastRx.at && now - t.lastRx.at < 2 * MIN;
    h.hops = fresh ? t.lastRx.hops : radio_.hopsAway(t.node);
    h.relay = fresh ? t.lastRx.relay : 0;
    h.snr = fresh ? t.lastRx.snr : 0;
    h.src = t.fixSrc;
    if (h.src != Source::Radio) h.hops = -1;
    t.log.push_back(h);
    if (t.log.size() > LOG_KEEP) t.log.erase(t.log.begin());
    if (asked && !t.locateFrom.empty()) {
      char where[160];
      snprintf(where, sizeof where, "https://www.openstreetmap.org/?mlat=%.6f&mlon=%.6f#map=17/%.6f/%.6f", t.fix.lat, t.fix.lng, t.fix.lat, t.fix.lng);
      std::string place;
      for (auto& pl : places_)
        if (pl.id == t.fix.placeId) place = pl.name;
      std::string text = "\xF0\x9F\x93\x8D Here now" + (place.empty() ? std::string() : " at " + place);
      if (t.fix.battery >= 0) text += " \xC2\xB7 battery " + std::to_string(t.fix.battery) + "%";
      text += "\n" + std::string(where);
      for (auto& l : t.locateFrom) t.dev->sendDirect(l.first, text);
      t.locateFrom.clear();
    }
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
  // The last mile: not this node's radio. Hops and the traced path don't apply then.
  if (t.fixSrc != Source::Radio) {
    m["src"] = sourceName(t.fixSrc);
    if (!t.fixGateway.empty()) m["gateway"] = t.fixGateway;
    return;
  }
  m["src"] = "radio";
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
    // A relay's position, rounded to about 100 m: the app draws the path through it.
    double lat, lng;
    if (i > 0 && i + 1 < t.path.size() && h.num != 0xffffffff && radio_.nodePosition(h.num, lat, lng)) {
      o["lat"] = std::round(lat * 1000) / 1000;
      o["lng"] = std::round(lng * 1000) / 1000;
    }
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
    bool waiting = false;
    for (auto& l : t->locateFrom) waiting = waiting || l.first == p.from;
    if (!waiting) t->locateFrom.push_back({p.from, now});
    radio_.requestPosition(t->node);
    t->askedAt = now;
    if (now - t->tracedAt >= TRACE_GAP) {
      radio_.traceroute(t->node);
      t->tracedAt = now;
    }
    log = who + " asked where " + t->name + " is";
  } else if (p.type == "chirp") {
    introduce(*t, now);
    radio_.alert(t->node, "\a" + who + " chirped you");
    log = who + " chirped " + t->name;
  } else if (p.type == "message") {
    t->dev->startDirectAt(p.seq - 1);
    std::vector<Device::Direct> in;
    if (t->dev->fetchDirect(in) != Status::Ok) return;
    for (auto& d : in) {
      if (d.checkin != "request") continue;
      introduce(*t, now);
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
      readCustoms();
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
    if (t->dev->joined()) {
      upload(*t);
      pushConfig(*t, now);
      introduce(*t, now);
      // A Locate it didn't answer: say so, with how old its last position is.
      if (!t->locateFrom.empty() && now - t->locateFrom.front().second >= LOCATE_WAIT) {
        std::string text = "\xF0\x9F\x93\xA1 No answer over the radio yet. ";
        text += t->sentFixAt ? "My last position is " + ago(now - t->sentFixAt) + "." : "No position from me yet.";
        for (auto& l : t->locateFrom) t->dev->sendDirect(l.first, text);
        t->locateFrom.clear();
      }
    }
  // Trackers whose account is gone (removed) leave the list.
  size_t before = trackers_.size();
  trackers_.erase(std::remove_if(trackers_.begin(), trackers_.end(), [](const std::unique_ptr<Tracker>& t) { return !t->dev->joined(); }),
                  trackers_.end());
  if (trackers_.size() != before) saveTrackers();
  if (now >= nextDirect_) {
    nextDirect_ = now + DIRECT_EVERY;
    std::vector<Device::Direct> in;
    if (base_.fetchDirect(in) == Status::Ok)
      for (auto& d : in) {
        if (!d.fixNode.empty()) onPhoneFix(d);
        else command(d);
      }
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
  auto mins = [&](const char* id, int lo, int hi, int dflt, bool zeroOk) {
    std::string raw = v[id] | "";
    int n = atoi(raw.c_str());
    if (zeroOk && raw == "0") return 0;
    return n >= lo && n <= hi ? n : dflt;
  };
  movingMin_ = mins("movingMinutes", 1, 60, 2, false);
  stillMin_ = mins("stillMinutes", 5, 720, 15, false);
  batteryMin_ = mins("batteryMinutes", 5, 720, 30, true);
  for (int n = 1; n <= 5; n++) press_[n] = v[("press" + std::to_string(n)).c_str()] | "";
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
// --- tracker settings ----------------------------------------------------------------

void HomeBase::readCustoms(bool alsoWhat) {
  if (trackers_.empty()) return;
  for (auto& t : trackers_) t->custom.clear();
  bool changed = false;
  base_.memberRecords([&](const std::string& subject, JsonObjectConst body) {
    for (auto& t : trackers_) {
      if (t->dev->memberId() != subject) continue;
      JsonObjectConst tr = body["tracker"];
      JsonObjectConst c = tr["custom"];
      if (!c.isNull()) serializeJson(c, t->custom);
      if (!alsoWhat || tr.isNull()) continue;
      std::string kind = kindOf(tr["mode"] | "");
      if (!kind.empty() && kind != t->kind) t->kind = kind, changed = true;
      std::string who = tr["carriedBy"] | "";
      if (kind.empty() || kind == "carried") {
        if (who != t->carriedBy) t->carriedBy = who, changed = true;
      } else if (!t->carriedBy.empty()) {
        t->carriedBy.clear(), changed = true;  // a car, a pet, keys…: no one's phone falls back to it
      }
    }
  });
  if (changed) saveTrackers();
}

void HomeBase::introduce(Tracker& t, int64_t now, bool force) {
  if (!force && t.introducedAt && now - t.introducedAt < INTRODUCE_EVERY) return;
  radio_.favorite(t.node);
  radio_.introduce(t.node);
  t.introducedAt = now;
}

TrackerConfig HomeBase::configFor(const Tracker& t) const {
  int moving = movingMin_, still = stillMin_, battery = batteryMin_;
  JsonDocument c;
  if (!t.custom.empty() && !deserializeJson(c, t.custom)) {
    int m = c["moving"] | -1, s = c["still"] | -1, b = c["battery"] | -1;
    if (m >= 1 && m <= 60) moving = m;
    if (s >= 5 && s <= 720) still = s;
    if (b == 0 || (b >= 5 && b <= 720)) battery = b;
  }
  TrackerConfig cfg;
  cfg.movingS = moving * 60;
  cfg.stillS = still * 60;
  cfg.batteryS = battery * 60;
  return cfg;
}

std::string HomeBase::pressText(const Tracker& t, int n) const {
  if (n < 1 || n > 5) return "";
  JsonDocument c;
  if (!t.custom.empty() && !deserializeJson(c, t.custom)) {
    std::string own = c["presses"][std::to_string(n)] | "";
    if (!trim(own).empty()) return own;
  }
  return trim(press_[n]).empty() ? PRESS_DEFAULTS[n] : press_[n];
}

// Settings go on a tracker when HomeCircle's change, not over and over: a
// change made on the tracker itself stays until the circle's settings change.
void HomeBase::pushConfig(Tracker& t, int64_t now) {
  TrackerConfig cfg = configFor(t);
  std::string want = cfg.key();
  if (want == t.configSet) {
    t.configState = "set";
    return;
  }
  int64_t wait = t.configState == "needs-key" ? CONFIG_NO_KEY : CONFIG_RETRY;
  if (t.configSending == want && now - t.configSentAt < wait) return;
  if (!radio_.configure(t.node, cfg)) return;
  t.configSending = want;
  t.configSentAt = now;
  if (t.configState != "needs-key") t.configState = "sending";
  log = "sending " + t.name + " its settings";
}

void HomeBase::onNoFix(uint32_t node) {
  Tracker* t = byNode(node);
  if (!t || t->locateFrom.empty()) return;
  std::string text =
      "\xF0\x9F\x93\xA1 I heard you, but I don't have a GPS fix right now. I need a view of the sky: after being indoors "
      "that can take a few minutes outside. ";
  text += t->sentFixAt ? "My last position is " + ago(now_() - t->sentFixAt) + "." : "No position from me yet.";
  for (auto& l : t->locateFrom) t->dev->sendDirect(l.first, text);
  t->locateFrom.clear();
  log = t->name + " has no GPS fix";
}

void HomeBase::onHeard(uint32_t node, int hops, uint32_t relay, float snr, bool position, Source src, const std::string& gateway) {
  Tracker* t = byNode(node);
  if (!t) return;
  int64_t now = now_();
  t->lastRx.at = now;
  t->lastRx.hops = src == Source::Radio ? hops : -1;
  t->lastRx.relay = src == Source::Radio && hops > 0 ? relay : 0;
  t->lastRx.snr = src == Source::Radio ? snr : 0;
  t->lastRx.src = src;
  t->lastRx.gateway = gateway;
  // Heard, but its position on the map is old (it's been away): ask where it is now, so the
  // map moves it there. At most every 10 minutes.
  if (!position && now - t->sentFixAt > STALE_FIX && now - t->askedAt > 10 * MIN) {
    radio_.requestPosition(node);
    t->askedAt = now;
    log = t->name + " is back in reach: asked where it is";
  }
}

void HomeBase::onConfigured(uint32_t node, ConfigResult r) {
  Tracker* t = byNode(node);
  if (!t) return;
  if (r == ConfigResult::Set) {
    t->configFails = 0;
    t->configSet = t->configSending;
    t->configState = "set";
    saveTrackers();
    log = t->name + " has its settings";
  } else if (r == ConfigResult::NeedsKey) {
    t->configState = "needs-key";
    log = t->name + " doesn't take the home base's key yet";
  } else {
    // No answer (out of range, asleep, or it didn't know our key yet): try again in CONFIG_RETRY.
    // A tracker that never answers, though the radio hears it, most likely doesn't take the home
    // base's key: say so, so the app shows how to add it (and try less often).
    if (++t->configFails >= 2) t->configState = "needs-key";
  }
}

void HomeBase::onPhoneFix(const Device::Direct& d) {
  uint32_t node;
  if (!parseNodeId(d.fixNode, node)) return;
  Tracker* t = byNode(node);
  if (!t) return;
  // Only the phone of whoever carries it (or an admin's) speaks for a tracker.
  if (d.from != t->carriedBy && !d.fromAdmin) return;
  if (std::fabs(d.fix.lat) > 90 || std::fabs(d.fix.lng) > 180 || (d.fix.lat == 0 && d.fix.lng == 0)) return;
  int64_t at = d.fixAt > 0 && d.fixAt <= now_() + MIN ? d.fixAt : now_();
  std::string first = d.fromName.substr(0, d.fromName.find(' '));
  onHeard(node, -1, 0, 0, true, Source::Phone, (first.empty() ? std::string("a") : first + "'s") + " phone");
  onPosition(node, d.fix, at);
  log = t->name + ": position from " + d.fromName + "'s phone";
}

bool HomeBase::takeUpdate(Update& out) {
  if (!updateAsked_) return false;
  updateAsked_ = false;
  out = update_;
  return true;
}

void HomeBase::updateNews(const std::string& to, const std::string& text) {
  if (!to.empty() && base_.sendDirect(to, text) == Status::Ok) return;
  log = "update: " + text;
}

void HomeBase::publishStatus() {
  if (!base_.amAdmin()) return;  // only admins write member records
  JsonDocument p;
  JsonObject h = p["homeBase"].to<JsonObject>();
  h["at"] = now_();
  h["fw"] = HC_FW_VERSION;  // the app offers an update when a newer one is out
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
    if (me.mqtt >= 0) s["mqtt"] = me.mqtt == 1;  // the internet bridge: connected or not (absent: off)
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
    if (!t->configState.empty()) o["settings"] = t->configState;
    // What the home base heard on its way: where, how many hops, through which relay.
    if (!t->log.empty()) {
      JsonArray lg = o["log"].to<JsonArray>();
      for (auto& h : t->log) {
        JsonObject e = lg.add<JsonObject>();
        e["at"] = h.at;
        e["lat"] = std::round(h.lat * 10000) / 10000;
        e["lng"] = std::round(h.lng * 10000) / 10000;
        if (h.hops >= 0) e["hops"] = h.hops;
        if (h.snr != 0) e["snr"] = tenth(h.snr);
        if (h.src != Source::Radio) e["src"] = sourceName(h.src);
        if (h.relay) {
          JsonObject r = e["relay"].to<JsonObject>();
          r["id"] = nodeId(h.relay);
          std::string rn = radio_.nodeName(h.relay);
          if (!rn.empty()) r["name"] = rn;
          double rlat, rlng;
          if (radio_.nodePosition(h.relay, rlat, rlng)) {
            r["lat"] = std::round(rlat * 1000) / 1000;
            r["lng"] = std::round(rlng * 1000) / 1000;
          }
        }
      }
    }
  }
  std::string key = radio_.publicKey();
  if (!key.empty()) h["key"] = key;
  if (radio_.selfNode()) h["node"] = nodeId(radio_.selfNode());  // phones address their messages over the mesh to it
  std::string channel = radio_.channelLink();
  if (!channel.empty()) h["channel"] = channel;  // sealed like the rest: only the circle reads it
  // Every minute: reuse the rest of its record for a while instead of reading
  // every member's record each time (admins rarely change the home base's).
  if (base_.mergeMemberRecord(base_.memberId(), p.as<JsonVariantConst>(), RECORD_REREAD) == Status::Ok) reportedAt_ = now_();
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

// --- Meshtastic contact links ---------------------------------------------------------
//
// meshtastic.org/v/#<base64url SharedContact>: node_num (1) and a User (2)
// with id (1), long_name (2), short_name (3), hw_model (5), public_key (8).
// A small protobuf reader: varints and length-delimited fields only.
namespace {
bool readVarint(const Bytes& b, size_t& at, uint64_t& v) {
  v = 0;
  for (int shift = 0; at < b.size() && shift < 64; shift += 7) {
    uint8_t c = b[at++];
    v |= (uint64_t)(c & 0x7f) << shift;
    if (!(c & 0x80)) return true;
  }
  return false;
}
// Calls fn(field, wireType, varint, start, length) for each field; false if malformed.
template <typename F>
bool eachField(const Bytes& b, size_t from, size_t to, F fn) {
  size_t at = from;
  while (at < to) {
    uint64_t key, v = 0;
    if (!readVarint(b, at, key)) return false;
    int field = (int)(key >> 3), wire = (int)(key & 7);
    size_t start = at, len = 0;
    if (wire == 0) {
      if (!readVarint(b, at, v)) return false;
    } else if (wire == 2) {
      uint64_t l;
      if (!readVarint(b, at, l) || at + l > to) return false;
      start = at, len = (size_t)l, at += len;
    } else if (wire == 5) {
      if (at + 4 > to) return false;
      at += 4;
    } else if (wire == 1) {
      if (at + 8 > to) return false;
      at += 8;
    } else {
      return false;
    }
    fn(field, wire, v, start, len);
  }
  return true;
}
}  // namespace

bool parseContactLink(const std::string& link, MeshContact& out) {
  size_t hash = link.find("/v/#");
  std::string b64 = trim(hash == std::string::npos ? link : link.substr(hash + 4));
  if (b64.empty() || !fromB64(b64, out.raw)) return false;
  const Bytes& b = out.raw;
  bool ok = eachField(b, 0, b.size(), [&](int f, int w, uint64_t v, size_t s, size_t len) {
    if (f == 1 && w == 0) out.node = (uint32_t)v;
    if (f == 2 && w == 2)
      eachField(b, s, s + len, [&](int uf, int uw, uint64_t uv, size_t us, size_t ul) {
        if (uf == 2 && uw == 2) out.longName.assign((const char*)&b[us], ul);
        if (uf == 3 && uw == 2) out.shortName.assign((const char*)&b[us], ul);
        if (uf == 5 && uw == 0) out.hwModel = (int)uv;
      });
  });
  return ok && out.node != 0;
}

std::string HomeBase::listText() {
  int64_t now = now_();
  std::string out;
  if (trackers_.empty()) out = "No trackers yet.";
  else out = "Trackers:";
  for (auto& t : trackers_) {
    out += "\n• " + t->name + " (" + nodeId(t->node) + ")";
    if (t->kind != "carried") out += ", " + (t->kind == "car" ? std::string("a car") : t->kind);
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
  bool changes = verb == "add" || verb == "rename" || verb == "remove" || verb == "link" || verb == "unlink" || verb == "update";
  // Roles and names change (someone made this home base an admin, someone joined): look first.
  if (changes || verb == "status") base_.refresh();

  if (changes && !d.fromAdmin) {
    reply = verb == "update" ? "Only the circle's admins can update the home base." : "Only the circle's admins can change trackers.";
  } else if (verb == "mqtt" || verb == "bridge") {
    // mqtt: how it is; mqtt off; mqtt <host[:port]> <user> <password> (admins).
    std::string host = radio_.mqttHost();
    if (rest.empty()) {
      SelfInfo me;
      radio_.selfInfo(me);
      reply = host.empty() ? "The internet bridge is off. Turn it on from the app: Trackers → Internet bridge."
                           : "The internet bridge is on, to " + host + (me.mqtt == 1 ? ", and connected." : ", but not connected right now.");
    } else if (!d.fromAdmin) {
      reply = "Only the circle's admins can change the internet bridge.";
    } else if (lower(rest) == "off") {
      MqttSettings m;
      reply = radio_.setMqtt(m) ? "Turning the internet bridge off. I'll restart (about 30 s)." : "I couldn't change the internet bridge.";
    } else {
      std::vector<std::string> w;
      size_t i = 0;
      while (i < rest.size()) {
        size_t j = rest.find(' ', i);
        if (j == std::string::npos) j = rest.size();
        if (j > i) w.push_back(rest.substr(i, j - i));
        i = j + 1;
      }
      MqttSettings m;
      m.on = true;
      if (w.size() >= 1) {
        size_t colon = w[0].rfind(':');
        m.host = colon == std::string::npos ? w[0] : w[0].substr(0, colon);
        if (colon != std::string::npos) m.port = atoi(w[0].c_str() + colon + 1);
      }
      if (w.size() >= 2) m.user = w[1];
      if (w.size() >= 3) m.pass = w[2];
      if (w.size() != 3 || m.host.empty() || m.port <= 0 || m.host.size() > 56 || m.user.size() > 63 || m.pass.size() > 31) {
        reply = "Set it with: mqtt <broker[:port]> <user> <password> (the password at most 31 characters). The app does this: Trackers → Internet bridge.";
      } else {
        reply = radio_.setMqtt(m) ? "Internet bridge set to " + m.host + ". I'll restart to connect (about 30 s); then trackers heard by any of your gateways show up here."
                                  : "I couldn't change the internet bridge.";
      }
    }
  } else if (verb == "version" || verb == "firmware") {
    reply = std::string("Home base firmware ") + HC_FW_VERSION + ".";
  } else if (verb == "update") {
    // update <https link to the firmware .bin> <its SHA-256>: the app sends it from Trackers → Update.
    size_t s2 = rest.find(' ');
    std::string url = rest.substr(0, s2);
    std::string sha = s2 == std::string::npos ? "" : lower(trim(rest.substr(s2 + 1)));
    bool hex = sha.size() == 64 && sha.find_first_not_of("0123456789abcdef") == std::string::npos;
    if (url.rfind("https://", 0) != 0 || !hex) {
      reply = "Update with: update <https link to the firmware> <its SHA-256>. The app does this for you: Trackers → the home base → Update.";
    } else {
      update_ = {url, sha, d.from};
      updateAsked_ = true;
      reply = std::string("⬇️ Updating from ") + HC_FW_VERSION + ". I'll download it (about a minute), check it, and restart. I'll tell you here when I'm back.";
    }
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
    // add !a1b2c3d4 Name [as car|pet|luggage|keys|other|person] [invite link]
    // add https://meshtastic.org/v/#… [Name] [as …]   (the tracker's "Share contact" link)
    size_t s2 = rest.find(' ');
    uint32_t node;
    std::string first = rest.substr(0, s2);
    MeshContact contact;
    bool fromContact = first.find("/v/#") != std::string::npos && parseContactLink(first, contact);
    std::string name = s2 == std::string::npos ? "" : trim(rest.substr(s2 + 1));
    std::string link, kind = "carried";
    size_t h = name.find("http");
    if (h == std::string::npos) h = name.find("homecircle://");
    if (h != std::string::npos) {
      link = trim(name.substr(h));
      name = trim(name.substr(0, h));
    }
    std::string ln = " " + lower(name);
    size_t as = ln.rfind(" as ");
    if (as != std::string::npos && !kindOf(trim(ln.substr(as + 4))).empty()) {
      kind = kindOf(trim(ln.substr(as + 4)));
      name = as == 0 ? "" : trim(name.substr(0, as - 1));
    }
    if (fromContact) {
      node = contact.node;
      if (name.empty()) name = contact.longName.empty() ? contact.shortName : contact.longName;
      radio_.addContact(contact.raw);  // its key, before it's heard: it can be sent settings right away
    }
    if ((!fromContact && !parseNodeId(first, node)) || name.empty()) {
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
          introduce(t, now_(), true);  // so it can open the home base's messages (chirps, check-ins, settings)
          reply = "Added " + name + " (" + nodeId(node) + "). It shows on the map with its next position. Make sure it's on our channel: send \"channel\".";
        } else {
          reply = "Couldn't add it: " + t.dev->error();
          trackers_.pop_back();
        }
      }
    }
  } else if (verb == "contact") {
    // contact <Share contact link>: the tracker's key for the node's list (the app sends it after "add").
    MeshContact c;
    if (!parseContactLink(rest, c)) reply = "Use: contact https://meshtastic.org/v/#… (the tracker's Share contact link)";
    else {
      radio_.addContact(c.raw);
      Tracker* t = byNode(c.node);
      if (t) introduce(*t, now_(), true);
      reply = "Got " + (c.longName.empty() ? nodeId(c.node) : c.longName) + "'s contact.";
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
