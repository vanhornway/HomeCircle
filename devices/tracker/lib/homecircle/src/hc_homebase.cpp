#include "hc_homebase.h"

#include <algorithm>
#include <cstdio>
#include <cstring>

namespace hc {

namespace {

const int64_t MIN = 60 * 1000;
const int64_t DIRECT_EVERY = 20 * 1000;      // read admins' messages
const int64_t WATCH_EVERY = 5 * MIN;         // look for quiet phones
const int64_t SEND_GAP = 1 * MIN;            // at most one location a minute per tracker (unless SOS or asked)
const int64_t ASK_GAP = 10 * MIN;            // at most one position request per tracker every 10 minutes
const int64_t QUIET_FLOOR = 30 * MIN;        // a phone is quiet after at least this long
const char* const HELP =
    "Home base commands:\n"
    "• list: trackers, and nodes I can hear\n"
    "• add !a1b2c3d4 Name (add \"as car\" for a car)\n"
    "• rename Name to New name\n"
    "• link Name to Person: who carries it; I ask it for a position when their phone goes quiet\n"
    "• unlink Name\n"
    "• remove Name\n"
    "• channel: the link that puts a tracker on our private channel\n"
    "• status";

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
  bool alert = l.find("sos") != std::string::npos || l.find('\a') != std::string::npos || l.find("help") != std::string::npos;
  bool safe = l == "safe" || l == "ok" || l == "i'm ok" || l == "im ok" || l.find("i'm safe") != std::string::npos;
  if (alert && !t->dev->sosActive()) {
    t->dev->sos(true, false);
    t->sosChanged = true;
  } else if (safe && t->dev->sosActive()) {
    t->dev->sos(false, false);
    t->sosChanged = true;
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
  if (!t.pending) return;
  int64_t now = now_();
  bool asked = t.askedAt && t.askedAt > t.sentFixAt;
  if (!t.dev->sosActive() && !asked && now - t.sentAt < SEND_GAP) return;
  const char* trigger = t.dev->sosActive() ? "sos" : asked ? "requested" : "update";
  // Stock trackers broadcast their position on their own schedule (15 minutes by default).
  Status s = t.dev->shareLocation(t.fix, trigger, 15, 15, "meshtastic", true, t.fixAt);
  if (s == Status::Ok) {
    t.pending = false;
    t.sentFixAt = t.fixAt;
    t.sentAt = now;
    log = "sent " + t.name + "'s position";
  } else if (s == Status::Removed) {
    log = t.name + " was removed from the circle";
    t.dev->forget();
    t.pending = false;
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
    int64_t quietAfter = std::max(QUIET_FLOOR, (int64_t)(phone && phone->stillMin ? phone->stillMin * 2 + 5 : 45) * MIN);
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
