#include "hc_homebases.h"

#include <algorithm>

namespace hc {

namespace {
// The same request from several circles, for the same thing heard or the same
// round of ticks, goes out once. Each circle keeps its own pace otherwise (a
// Locate, then a check-in a little later: both ask).
}  // namespace

// The radio as one circle's home base sees it: what reaches the trackers goes
// out once for all its circles, and only the circle that sets a tracker's
// settings sends them.
class SlotRadio : public Radio {
 public:
  SlotRadio(Radio& r, HomeBases& all, int slot) : r_(r), all_(all), slot_(slot) {}
  void requestPosition(uint32_t node) override {
    if (all_.once("pos" + nodeId(node), 0)) r_.requestPosition(node);
  }
  void nodes(std::vector<HeardNode>& out) override { r_.nodes(out); }
  std::string channelLink() override { return r_.channelLink(); }
  bool selfGnss(SelfGnss& out) override { return r_.selfGnss(out); }
  const GnssSky* sky() override { return r_.sky(); }
  void alert(uint32_t node, const std::string& text) override { r_.alert(node, text); }
  void traceroute(uint32_t node) override {
    if (all_.once("trace" + nodeId(node), 0)) r_.traceroute(node);
  }
  std::string nodeName(uint32_t num) override { return r_.nodeName(num); }
  int hopsAway(uint32_t node) override { return r_.hopsAway(node); }
  bool selfInfo(SelfInfo& out) override { return r_.selfInfo(out); }
  bool configure(uint32_t node, const TrackerConfig& c) override { return all_.settingsSlot(node) == slot_ && r_.configure(node, c); }
  std::string publicKey() override { return r_.publicKey(); }
  void introduce(uint32_t node) override {
    if (all_.once("intro" + nodeId(node), 0)) r_.introduce(node);
  }
  void addContact(const Bytes& contact) override { r_.addContact(contact); }
  bool nodePosition(uint32_t node, double& lat, double& lng) override { return r_.nodePosition(node, lat, lng); }
  uint32_t selfNode() override { return r_.selfNode(); }
  void favorite(uint32_t node) override { r_.favorite(node); }
  void sosAck(uint32_t node) override {
    if (all_.once("ack" + nodeId(node), 0)) r_.sosAck(node);
  }
  void trackerNote(uint32_t node, const std::string& what) override {
    if (all_.once(what + nodeId(node), 0)) r_.trackerNote(node, what);
  }
  void trackerCfg(uint32_t node, const std::string& cfg) override {
    if (all_.settingsSlot(node) == slot_) r_.trackerCfg(node, cfg);
  }
  bool setMqtt(const MqttSettings& m) override { return r_.setMqtt(m); }
  std::string mqttHost() override { return r_.mqttHost(); }

 private:
  Radio& r_;
  HomeBases& all_;
  int slot_;
};

struct HomeBases::Slot {
  int id = 0;
  std::unique_ptr<PrefixStore> store;  // none for the first: it keeps the keys it always had
  std::unique_ptr<SlotRadio> radio;
  std::unique_ptr<HomeBase> hb;
};

HomeBases::HomeBases(Http& http, Store& store, int64_t (*nowMs)(), Radio& radio) : http_(http), store_(store), now_(nowMs), radio_(radio) {}
HomeBases::~HomeBases() = default;

HomeBases::Slot& HomeBases::add(int id) {
  std::unique_ptr<Slot> s(new Slot());
  s->id = id;
  s->radio.reset(new SlotRadio(radio_, *this, id));
  Store* st = &store_;
  if (id != 0) {
    s->store.reset(new PrefixStore(store_, "c" + std::to_string(id) + "."));
    st = s->store.get();
  }
  s->hb.reset(new HomeBase(http_, *st, now_, *s->radio));
  slots_.push_back(std::move(s));
  wire(*slots_.back());
  return *slots_.back();
}

void HomeBases::wire(Slot& s) {
  int id = s.id;
  Slot* self = &s;
  s.hb->phoneFixShared = [this, id](uint32_t node, const Fix& fix, int64_t at, const std::string& gateway) {
    for (auto& o : slots_)
      if (o->id != id) o->hb->sharedFix(node, fix, at, gateway);
  };
  s.hb->sosEnded = [this, id](uint32_t node) {
    for (auto& o : slots_)
      if (o->id != id) o->hb->sosEndedElsewhere(node);
  };
  s.hb->settingsHere = [this, id](uint32_t node) { return settingsSlot(node) == id; };
  s.hb->circlesCommand = [this, self](const std::string& verb, const std::string& rest, const Device::Direct& d) {
    return circlesCommand(*self, verb, rest, d);
  };
}

void HomeBases::saveSlots() {
  JsonDocument d;
  JsonArray a = d.to<JsonArray>();
  for (auto& s : slots_) a.add(s->id);
  std::string raw;
  serializeJson(d, raw);
  store_.put("circles", raw);
}

bool HomeBases::load() {
  slots_.clear();
  std::vector<int> ids;
  std::string raw;
  JsonDocument d;
  if (store_.get("circles", raw) && !deserializeJson(d, raw))
    for (JsonVariantConst v : d.as<JsonArrayConst>()) {
      int id = v | -1;
      if (id >= 0 && id < 100 && std::find(ids.begin(), ids.end(), id) == ids.end() && ids.size() < MAX_CIRCLES) ids.push_back(id);
    }
  if (ids.empty()) ids.push_back(0);  // a home base from before: its one circle
  for (int id : ids) add(id).hb->load();
  return ready();
}

bool HomeBases::ready() const {
  for (auto& s : slots_)
    if (s->hb->ready()) return true;
  return false;
}

HomeBase* HomeBases::first() {
  for (auto& s : slots_)
    if (s->hb->ready()) return s->hb.get();
  if (slots_.empty()) add(0);
  return slots_.front()->hb.get();
}

Device& HomeBases::base() { return first()->base(); }

Status HomeBases::setup(const std::string& invite, const std::string& name) {
  if (slots_.empty()) add(0);
  Status s = slots_.front()->hb->setup(invite, name);
  if (s == Status::Ok) saveSlots();
  return s;
}

void HomeBases::forget() {
  for (auto& s : slots_) s->hb->forget();
  slots_.clear();
  store_.remove("circles");
  add(0);
}

bool HomeBases::once(const std::string& key, int64_t) {
  return sent_.insert(key).second;
}

int HomeBases::settingsSlot(uint32_t node) const {
  int best = -1;
  int64_t bestAdded = 0;
  for (auto& s : slots_) {
    int64_t added = s->hb->addedAt(node);
    if (added < 0) continue;
    if (best < 0 || added < bestAdded) best = s->id, bestAdded = added;  // a tie: the circle it was set up in first
  }
  return best;
}

void HomeBases::collectLog() {
  bool several = circleCount() > 1;
  for (auto& s : slots_) {
    if (s->hb->log.empty()) continue;
    if (!log.empty()) log += " | ";
    log += several ? "[" + s->hb->base().circleName() + "] " + s->hb->log : s->hb->log;
    s->hb->log.clear();
  }
}

void HomeBases::tick() {
  sent_.clear();  // a new round: requests from it go out once
  // By index: "join" (a command handled in a circle's tick) adds a slot, which starts next tick.
  for (size_t i = 0, n = slots_.size(); i < n; i++) slots_[i]->hb->tick();
  collectLog();
  // Circles it was asked to leave (from their own chat): after their tick, which sent the answer.
  for (int id : leaving_) {
    for (size_t i = 0; i < slots_.size(); i++) {
      if (slots_[i]->id != id) continue;
      std::string name = slots_[i]->hb->base().circleName();
      slots_[i]->hb->leaveCircle();
      slots_.erase(slots_.begin() + i);
      if (!log.empty()) log += " | ";
      log += "left " + name;
      break;
    }
  }
  if (!leaving_.empty()) saveSlots();
  leaving_.clear();
}

std::string HomeBases::circlesCommand(Slot& from, const std::string& verb, const std::string& rest, const Device::Direct& d) {
  std::string here = from.hb->base().circleName();
  if (verb == "circles") {
    std::string out = "I'm the home base in:";
    for (auto& s : slots_)
      if (s->hb->ready()) out += "\n• " + s->hb->base().circleName() + (s.get() == &from ? " (here)" : "") + ", " + std::to_string(s->hb->trackerCount()) + " tracker(s)";
    return out + "\n\nAdd me to another circle with: join <invite link from that circle> (up to 3).";
  }
  if (verb == "leave") {
    if (circleCount() <= 1) return "This is the only circle I'm in, so I'm staying. To move me, set me up again.";
    if (std::find(leaving_.begin(), leaving_.end(), from.id) == leaving_.end()) leaving_.push_back(from.id);
    return "Leaving " + here + " now, with the trackers I keep here. I stay the home base in my other circles.";
  }
  // join <invite link>
  if (rest.rfind("http", 0) != 0 && rest.rfind("homecircle://", 0) != 0)
    return "Use: join <invite link> (in the other circle: Settings \xE2\x86\x92 Invite, then copy the link).";
  if (circleCount() >= MAX_CIRCLES) return "I'm already in " + std::to_string(MAX_CIRCLES) + " circles. Send \"leave\" in one of them first.";
  int id = 0;
  for (auto& s : slots_) id = std::max(id, s->id + 1);
  Slot& s = add(id);
  Status st = s.hb->setup(rest, "Home base");
  std::string why = s.hb->base().error();
  if (st == Status::Ok) {
    for (auto& o : slots_)
      if (o.get() != &s && o->hb->ready() && o->hb->base().circleId() == s.hb->base().circleId()) {
        s.hb->leaveCircle();
        slots_.pop_back();
        return "I'm already the home base in " + o->hb->base().circleName() + ".";
      }
    saveSlots();
    std::string name = s.hb->base().circleName();
    return "Joined " + name + " as its home base. There: make me an admin (Settings \xE2\x86\x92 People) and turn on Meshtastic trackers, "
           "then add trackers with \"add !id Name\". Trackers I keep here can be added there too: the circle that added one first "
           "sets how it reports. The person who invited me: " + d.fromName + ".";
  }
  s.hb->forget();
  slots_.pop_back();
  return "I couldn't join that circle: " + (why.empty() ? std::string(statusName(st)) : why) + ".";
}

void HomeBases::onPosition(uint32_t node, const Fix& fix, int64_t fixTimeMs) {
  sent_.clear();
  for (auto& s : slots_) s->hb->onPosition(node, fix, fixTimeMs);
  collectLog();
}

void HomeBases::onText(uint32_t node, const std::string& text) {
  sent_.clear();
  for (auto& s : slots_) s->hb->onText(node, text);
  collectLog();
}

// Someone else's text on the private channel: the first circle's chat (the channel is the home base's own).
void HomeBases::onChannelText(uint32_t node, const std::string& name, const std::string& text) {
  if (isTracker(node)) return;
  first()->onChannelText(node, name, text);
}

// A sealed packet from a HomeCircle tracker: the server knows whose it is; passed on once.
void HomeBases::onMeshPacket(const Bytes& packet) { first()->onMeshPacket(packet); }

void HomeBases::onRoute(uint32_t node, const std::vector<uint32_t>& back, const std::vector<int>& snrBack4) {
  sent_.clear();
  for (auto& s : slots_) s->hb->onRoute(node, back, snrBack4);
  collectLog();
}

// Settings went on the tracker: only the circle that sent them asked.
void HomeBases::onConfigured(uint32_t node, ConfigResult r) {
  sent_.clear();
  int owner = settingsSlot(node);
  for (auto& s : slots_)
    if (s->id == owner) s->hb->onConfigured(node, r);
  collectLog();
}

void HomeBases::onNoFix(uint32_t node) {
  sent_.clear();
  for (auto& s : slots_) s->hb->onNoFix(node);
  collectLog();
}

void HomeBases::onHeard(uint32_t node, int hops, uint32_t relay, float snr, bool position, Source src, const std::string& gateway) {
  sent_.clear();
  for (auto& s : slots_) s->hb->onHeard(node, hops, relay, snr, position, src, gateway);
  collectLog();
}

bool HomeBases::isTracker(uint32_t node) const {
  for (auto& s : slots_)
    if (s->hb->isTracker(node)) return true;
  return false;
}

size_t HomeBases::trackerCount() const {
  size_t n = 0;
  for (auto& s : slots_) n += s->hb->trackerCount();
  return n;
}

size_t HomeBases::circleCount() const {
  size_t n = 0;
  for (auto& s : slots_) n += s->hb->ready() ? 1 : 0;
  return n;
}

bool HomeBases::takeUpdate(HomeBase::Update& out) {
  for (auto& s : slots_)
    if (s->hb->takeUpdate(out)) return true;
  return false;
}

// After an update: tell whoever asked, in whichever circle they are.
void HomeBases::updateNews(const std::string& to, const std::string& text) {
  for (auto& s : slots_)
    if (s->hb->ready() && s->hb->tell(to, text)) return;
  if (!log.empty()) log += " | ";
  log += "update: " + text;
}

int64_t HomeBases::reportedAt() const {
  int64_t at = 0;
  for (auto& s : slots_) at = std::max(at, s->hb->reportedAt());
  return at;
}

}  // namespace hc
