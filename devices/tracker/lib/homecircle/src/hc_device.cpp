#include "hc_device.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace hc {

static const char* const COLORS[] = {"#2f7d6d", "#d9644a", "#4a6fd9", "#b0479c", "#c79a1e", "#3c8fb5", "#7a5bd6", "#5d8a2e"};
static const char* ACCOUNT_KEY = "acct";

const char* statusName(Status s) {
  switch (s) {
    case Status::Ok: return "ok";
    case Status::Offline: return "offline";
    case Status::Removed: return "removed";
    default: return "failed";
  }
}

Device::Device(Http& http, Store& store, int64_t (*nowMs)()) : http_(http), store_(store), now_(nowMs) {}

// --- the saved account ------------------------------------------------------

bool Device::load() {
  std::string raw;
  if (!store_.get(ACCOUNT_KEY, raw) || raw.empty()) return false;
  JsonDocument d;
  if (deserializeJson(d, raw)) return false;
  Account a;
  a.server = d["server"] | "";
  a.token = d["token"] | "";
  a.memberId = d["memberId"] | "";
  a.circleId = d["circleId"] | "";
  a.circleName = d["circleName"] | "";
  a.name = d["name"] | "";
  a.color = d["color"] | COLORS[0];
  a.epoch = d["epoch"] | 0L;
  for (JsonPairConst kv : d["keyring"].as<JsonObjectConst>()) {
    Bytes k;
    if (fromB64(kv.value() | "", k) && k.size() == 32) a.keyring[atol(kv.key().c_str())] = k;
  }
  fromB64(d["boxPub"] | "", a.id.boxPub);
  fromB64(d["boxSecret"] | "", a.id.boxSecret);
  fromB64(d["signPub"] | "", a.id.signPub);
  fromB64(d["signSecret"] | "", a.id.signSecret);
  for (JsonPairConst kv : d["known"].as<JsonObjectConst>()) {
    Known k;
    fromB64(kv.value()["signPub"] | "", k.signPub);
    fromB64(kv.value()["boxPub"] | "", k.boxPub);
    k.name = kv.value()["name"] | "";
    if (k.signPub.size() == 32 && k.boxPub.size() == 32) a.known[kv.key().c_str()] = k;
  }
  a.lastSeq = d["lastSeq"] | -1L;
  a.sosStartId = d["sosStartId"] | "";
  a.sosId = d["sosId"] | "";
  a.sosState = d["sosState"] | "";
  a.sosOf = d["sosOf"] | "";
  a.sosSent = d["sosSent"] | true;
  fromB64(d["meshKey"] | "", a.meshKey);
  a.meshCounter = d["meshCounter"] | 0u;
  a.meshRegistered = d["meshRegistered"] | false;
  if (a.token.empty() || a.memberId.empty() || !a.keyring.count(a.epoch) || a.id.signSecret.size() != 64) return false;
  acct_ = a;
  return true;
}

bool Device::save() {
  JsonDocument d;
  d["server"] = acct_.server;
  d["token"] = acct_.token;
  d["memberId"] = acct_.memberId;
  d["circleId"] = acct_.circleId;
  d["circleName"] = acct_.circleName;
  d["name"] = acct_.name;
  d["color"] = acct_.color;
  d["epoch"] = acct_.epoch;
  JsonObject ring = d["keyring"].to<JsonObject>();
  for (auto& kv : acct_.keyring) ring[std::to_string(kv.first)] = toB64(kv.second);
  d["boxPub"] = toB64(acct_.id.boxPub);
  d["boxSecret"] = toB64(acct_.id.boxSecret);
  d["signPub"] = toB64(acct_.id.signPub);
  d["signSecret"] = toB64(acct_.id.signSecret);
  JsonObject known = d["known"].to<JsonObject>();
  for (auto& kv : acct_.known) {
    JsonObject k = known[kv.first].to<JsonObject>();
    k["signPub"] = toB64(kv.second.signPub);
    k["boxPub"] = toB64(kv.second.boxPub);
    if (!kv.second.name.empty()) k["name"] = kv.second.name;
  }
  d["lastSeq"] = acct_.lastSeq;
  d["sosStartId"] = acct_.sosStartId;
  d["sosId"] = acct_.sosId;
  d["sosState"] = acct_.sosState;
  d["sosOf"] = acct_.sosOf;
  d["sosSent"] = acct_.sosSent;
  d["meshKey"] = toB64(acct_.meshKey);
  d["meshCounter"] = acct_.meshCounter;
  d["meshRegistered"] = acct_.meshRegistered;
  std::string out;
  serializeJson(d, out);
  return store_.put(ACCOUNT_KEY, out);
}

void Device::forget() {
  store_.remove(ACCOUNT_KEY);
  acct_ = Account();
  roles_.clear();
  refreshed_ = false;
}

// --- requests ---------------------------------------------------------------

Status Device::fail(const std::string& why) {
  err_ = why;
  return Status::Failed;
}

std::string Device::errorCode(const HttpResponse& r) {
  JsonDocument d;
  if (deserializeJson(d, r.body)) return "";
  return d["error"] | "";
}

Status Device::fromResponse(const HttpResponse& r, JsonDocument* out) {
  if (r.status < 0) {
    err_ = "no connection to the server";
    return Status::Offline;
  }
  if (r.status == 401) {
    err_ = "the server no longer knows this device";
    return Status::Removed;
  }
  if (r.status >= 200 && r.status < 300) {
    if (out && deserializeJson(*out, r.body)) return fail("the server sent something this device can't read");
    return Status::Ok;
  }
  if (r.status >= 500 || r.status == 429) {
    err_ = "the server is busy (" + std::to_string(r.status) + ")";
    return Status::Offline;
  }
  JsonDocument d;
  std::string msg = r.body.substr(0, 160);
  if (!deserializeJson(d, r.body)) msg = std::string(d["error"] | "error") + ": " + std::string(d["message"] | "");
  return fail(std::to_string(r.status) + " " + msg);
}

Status Device::call(const char* method, const char* path, const std::string& body, JsonDocument* out, HttpResponse* raw) {
  HttpResponse r = http_.request(method, acct_.server + "/api/v1" + path, acct_.token, body);
  if (raw) *raw = r;
  return fromResponse(r, out);
}

// --- sealed envelopes -------------------------------------------------------

// Padding sizes (the app's PAD_TO), so a sealed location or chat's length
// doesn't tell the server more than the app's would.
static const size_t PAD_LOCATION[] = {256, 1024};
static const size_t PAD_CHAT[] = {256, 1024, 4096, 8192};
static const size_t PAD_FIELD = 9;  // ,"pad":""

// A direct message's key: KDF("homecircle/direct-v1", X25519(my box secret, their box public)).
Bytes Device::directKey(const std::string& peer) const {
  auto k = acct_.known.find(peer);
  if (k == acct_.known.end()) return Bytes();
  Bytes shared = boxBeforenm(k->second.boxPub, acct_.id.boxSecret);
  return kdf("homecircle/direct-v1", shared.data(), shared.size());
}

JsonDocument Device::seal(const char* kind, JsonVariantConst body, const std::string& id, const std::string& to, int64_t ts) {
  JsonDocument inner;
  inner["v"] = 1;
  inner["kind"] = kind;
  inner["from"] = acct_.memberId;
  inner["circle"] = acct_.circleId;
  inner["epoch"] = acct_.epoch;
  inner["ts"] = ts ? ts : now_();
  inner["body"] = body;
  if (!id.empty()) inner["id"] = id;
  if (!to.empty()) inner["to"] = to;
  std::string plain;
  serializeJson(inner, plain);
  const size_t* pads = nullptr;
  size_t count = 0;
  if (!strcmp(kind, "location")) pads = PAD_LOCATION, count = 2;
  if (!strcmp(kind, "chat")) pads = PAD_CHAT, count = 4;
  for (size_t i = 0; i < count; i++) {
    if (pads[i] >= plain.size() + PAD_FIELD) {
      inner["pad"] = std::string(pads[i] - plain.size() - PAD_FIELD, ' ');
      plain.clear();
      serializeJson(inner, plain);
      break;
    }
  }
  Bytes signedMsg = sign(bytesOf(plain), acct_.id.signSecret);
  Bytes nonce = randomBytes(24);
  Bytes ct = secretbox(signedMsg, nonce, to.empty() ? acct_.keyring[acct_.epoch] : directKey(to));
  JsonDocument env;
  env["epoch"] = acct_.epoch;
  env["nonce"] = toB64(nonce);
  env["ct"] = toB64(ct);
  return env;
}

bool Device::open(JsonVariantConst env, const Bytes& signPub, const char* kind, const std::string& from, JsonDocument& msg,
                  const std::string& to) {
  long e = env["epoch"] | -1L;
  Bytes key;
  if (to.empty()) {
    auto ring = acct_.keyring.find(e);
    if (ring == acct_.keyring.end()) return false;
    key = ring->second;
  } else {
    // A direct message: the key between the two of us.
    key = directKey(from == acct_.memberId ? to : from);
    if (key.empty()) return false;
  }
  Bytes nonce, ct, signedMsg, plain;
  if (!fromB64(env["nonce"] | "", nonce) || !fromB64(env["ct"] | "", ct)) return false;
  if (!secretboxOpen(ct, nonce, key, signedMsg)) return false;
  if (!signOpen(signedMsg, signPub, plain)) return false;
  if (deserializeJson(msg, (const char*)plain.data(), plain.size())) return false;
  if ((msg["v"] | 0) != 1) return false;
  if (strcmp(msg["kind"] | "", kind) != 0) return false;
  if (from != (msg["from"] | "")) return false;
  if (acct_.circleId != (msg["circle"] | "")) return false;
  // A direct message can't be passed off as a group one, or redirected.
  if (to.empty() ? !msg["to"].isNull() : to != (msg["to"] | "")) return false;
  if ((msg["epoch"] | -2L) != e) return false;
  return true;
}

JsonDocument Device::profileBody() {
  JsonDocument b;
  b["name"] = acct_.name;
  b["color"] = acct_.color;
  b["boxPub"] = toB64(acct_.id.boxPub);
  b["signPub"] = toB64(acct_.id.signPub);
  return b;
}

// --- invites ----------------------------------------------------------------

static std::string urlDecode(const std::string& s) {
  std::string out;
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == '%' && i + 2 < s.size()) {
      out += (char)strtol(s.substr(i + 1, 2).c_str(), nullptr, 16);
      i += 2;
    } else {
      out += s[i] == '+' ? ' ' : s[i];
    }
  }
  return out;
}

static std::string trim(const std::string& s) {
  size_t a = s.find_first_not_of(" \t\r\n");
  if (a == std::string::npos) return "";
  size_t b = s.find_last_not_of(" \t\r\n");
  return s.substr(a, b - a + 1);
}

static bool idChars(const std::string& s) {
  if (s.empty()) return false;
  for (char c : s)
    if (!isalnum((unsigned char)c) && c != '-' && c != '_') return false;
  return true;
}

static bool cleanServer(std::string& s) {
  if (s.rfind("https://", 0) != 0 && s.rfind("http://", 0) != 0) return false;
  size_t start = s.find("://") + 3;
  size_t end = s.find_first_of("/?#", start);
  if (end != std::string::npos) s = s.substr(0, end);
  for (size_t i = 0; i < s.size(); i++) s[i] = (char)tolower((unsigned char)s[i]);
  return s.size() > start;
}

bool parseInvite(const std::string& raw, std::string& server, std::string& inviteId, std::string& secret) {
  std::string link = trim(raw);
  if (link.rfind("homecircle://join?", 0) == 0) {
    std::string q = link.substr(strlen("homecircle://join?"));
    size_t pos = 0;
    while (pos <= q.size()) {
      size_t amp = q.find('&', pos);
      std::string kv = q.substr(pos, amp == std::string::npos ? std::string::npos : amp - pos);
      size_t eq = kv.find('=');
      if (eq != std::string::npos) {
        std::string k = kv.substr(0, eq), v = urlDecode(kv.substr(eq + 1));
        if (k == "server") server = v;
        if (k == "i") inviteId = v;
        if (k == "s") secret = v;
      }
      if (amp == std::string::npos) break;
      pos = amp + 1;
    }
  } else {
    size_t hash = link.find('#');
    if (hash == std::string::npos) return false;
    std::string before = link.substr(0, hash);
    if (before.size() >= 1 && before.back() == '/') before.pop_back();
    if (before.size() < 5 || before.compare(before.size() - 5, 5, "/join") != 0) return false;
    server = before.substr(0, before.size() - 5);
    std::string frag = link.substr(hash + 1);
    size_t dot = frag.find('.');
    if (dot == std::string::npos) return false;
    inviteId = frag.substr(0, dot);
    secret = frag.substr(dot + 1);
  }
  return cleanServer(server) && idChars(inviteId) && idChars(secret);
}

Status Device::join(const std::string& link, const std::string& rawName) {
  std::string server, inviteId, secret;
  if (!parseInvite(link, server, inviteId, secret)) return fail("that isn't a HomeCircle invite link");
  Bytes s;
  if (!fromB64(secret, s) || s.size() != 32) return fail("that invite link is incomplete");
  std::string name = trim(rawName).substr(0, 40);
  if (name.empty()) return fail("give the tracker a name");

  std::string inviteAuth = toB64(kdf("homecircle/invite-auth", s.data(), s.size()));
  Bytes wrapKey = kdf("homecircle/invite-wrap", s.data(), s.size());

  acct_ = Account();
  acct_.server = server;
  JsonDocument req;
  req["inviteId"] = inviteId;
  req["inviteAuth"] = inviteAuth;
  std::string body;
  serializeJson(req, body);
  JsonDocument preview;
  Status st = call("POST", "/join/preview", body, &preview);
  if (st != Status::Ok) {
    if (st == Status::Removed) return fail("the server didn't accept the invite");
    return st;
  }

  JsonDocument wrappedDoc;
  JsonVariantConst wrapped = preview["wrapped"];
  if (wrapped.is<const char*>()) {
    if (deserializeJson(wrappedDoc, wrapped.as<const char*>())) return fail("the invite couldn't be read");
    wrapped = wrappedDoc.as<JsonVariantConst>();
  }
  Bytes nonce, ct, plain;
  if (!fromB64(wrapped["nonce"] | "", nonce) || !fromB64(wrapped["ct"] | "", ct) || !secretboxOpen(ct, nonce, wrapKey, plain)) {
    return fail("the invite couldn't be opened (wrong link?)");
  }
  JsonDocument payload;
  if (deserializeJson(payload, (const char*)plain.data(), plain.size())) return fail("the invite couldn't be read");
  Bytes circleKey;
  if (!fromB64(payload["circleKey"] | "", circleKey) || circleKey.size() != 32) return fail("the invite has no circle key");

  acct_.circleId = payload["circle"] | "";
  acct_.circleName = payload["circleName"] | "";
  acct_.epoch = payload["epoch"] | 0L;
  acct_.keyring[acct_.epoch] = circleKey;
  acct_.id = newIdentity();
  acct_.memberId = randomId(16);
  acct_.name = name;
  acct_.color = COLORS[randomBytes(1)[0] % 8];

  JsonDocument j;
  j["inviteId"] = inviteId;
  j["inviteAuth"] = inviteAuth;
  JsonObject member = j["member"].to<JsonObject>();
  member["id"] = acct_.memberId;
  member["boxPub"] = toB64(acct_.id.boxPub);
  member["signPub"] = toB64(acct_.id.signPub);
  JsonDocument pb = profileBody();
  member["profile"] = seal("profile", pb.as<JsonVariantConst>());
  body.clear();
  serializeJson(j, body);
  JsonDocument res;
  st = call("POST", "/join", body, &res);
  if (st != Status::Ok) {
    Account none;
    none.server = acct_.server;
    acct_ = none;
    if (st == Status::Removed) return fail("the server didn't accept the invite");
    return st;
  }
  acct_.token = res["token"] | "";
  if (acct_.token.empty()) return fail("the server didn't return a token");
  if (!save()) return fail("couldn't save the account on this device");
  // Learn the admins' keys now, while this device holds the same key they used.
  Status r = refresh();
  if (r == Status::Ok) registerMesh();  // a server without mesh support just says no
  return r == Status::Offline ? Status::Ok : r;
}

// --- the circle ---------------------------------------------------------------

bool Device::isAdmin(const std::string& memberId) const {
  auto r = roles_.find(memberId);
  return r != roles_.end() && (r->second == "owner" || r->second == "admin");
}

// Verify every member's self-signed profile and remember their keys and name.
// Whether someone is an admin comes from the latest /state (roles_), each time.
void Device::trustMembers(JsonArrayConst members) {
  for (JsonObjectConst m : members) {
    if (m["removed"] | false) continue;
    std::string id = m["id"] | "";
    if (id == acct_.memberId) continue;
    JsonVariantConst profile = m["profile"];
    if (!profile["ct"].is<const char*>()) continue;
    Known k;
    if (!fromB64(m["signPub"] | "", k.signPub) || !fromB64(m["boxPub"] | "", k.boxPub)) continue;
    JsonDocument msg;
    if (!open(profile, k.signPub, "profile", id, msg)) continue;
    // A profile is self-signed and must carry the keys the server lists.
    if (std::string(msg["body"]["signPub"] | "") != std::string(m["signPub"] | "")) continue;
    if (std::string(msg["body"]["boxPub"] | "") != std::string(m["boxPub"] | "")) continue;
    auto had = acct_.known.find(id);
    // Keys never change for a member; different keys are not trusted.
    if (had != acct_.known.end() && (had->second.signPub != k.signPub || had->second.boxPub != k.boxPub)) continue;
    k.name = std::string(msg["body"]["name"] | "").substr(0, 40);
    acct_.known[id] = k;
  }
}

Status Device::syncKeys(JsonArrayConst members) {
  JsonDocument res;
  std::string path = "/keys/envelopes?since=" + std::to_string(acct_.epoch);
  Status st = call("GET", path.c_str(), "", &res);
  if (st != Status::Ok) return st;
  for (JsonObjectConst env : res["envelopes"].as<JsonArrayConst>()) {
    long e = env["epoch"] | 0L;
    if (acct_.keyring.count(e)) continue;
    std::string from = env["from"] | "";
    // Only from an admin whose keys this device verified before.
    auto k = acct_.known.find(from);
    if (!isAdmin(from) || k == acct_.known.end()) continue;
    Bytes nonce, ct, plain;
    if (!fromB64(env["nonce"] | "", nonce) || !fromB64(env["ct"] | "", ct)) continue;
    if (!boxOpen(ct, nonce, k->second.boxPub, acct_.id.boxSecret, plain)) continue;
    JsonDocument msg;
    if (deserializeJson(msg, (const char*)plain.data(), plain.size())) continue;
    Bytes key;
    if ((msg["epoch"] | -1L) != e || acct_.circleId != (msg["circle"] | "")) continue;
    if (!fromB64(msg["key"] | "", key) || key.size() != 32) continue;
    acct_.keyring[e] = key;
    if (e > acct_.epoch) acct_.epoch = e;
  }
  (void)members;
  return Status::Ok;
}

Status Device::refresh() {
  JsonDocument st;
  Status s = call("GET", "/state", "", &st);
  if (s != Status::Ok) return s;
  JsonArrayConst members = st["members"].as<JsonArrayConst>();
  roles_.clear();
  long myProfileEpoch = -1;
  bool here = false;
  for (JsonObjectConst m : members) {
    std::string id = m["id"] | "";
    if (m["removed"] | false) continue;
    roles_[id] = m["role"] | "";
    if (id == acct_.memberId) {
      here = true;
      myProfileEpoch = m["profile"]["epoch"] | -1L;
    }
  }
  if (!here) {
    err_ = "this device was removed from the circle";
    return Status::Removed;
  }
  features_.clear();
  for (JsonPairConst kv : st["features"].as<JsonObjectConst>()) features_[kv.key().c_str()] = kv.value() | false;
  trustMembers(members);
  long epoch = st["epoch"] | 0L;
  if (!acct_.keyring.count(epoch)) {
    s = syncKeys(members);
    if (s != Status::Ok) return s;
    trustMembers(members);
    if (!acct_.keyring.count(epoch)) {
      save();
      return fail("the circle has a new key and no admin has sent it to this device yet");
    }
  }
  acct_.epoch = epoch;
  if (myProfileEpoch < epoch) {
    JsonDocument p;
    JsonDocument pb = profileBody();
    p["profile"] = seal("profile", pb.as<JsonVariantConst>());
    std::string body;
    serializeJson(p, body);
    s = call("PUT", "/members/me/profile", body, nullptr);
    if (s != Status::Ok) return s;
  }
  // Keep the current key and the one before it (for anything sealed during a rotation).
  for (auto it = acct_.keyring.begin(); it != acct_.keyring.end();) it = it->first < epoch - 1 ? acct_.keyring.erase(it) : std::next(it);
  save();
  refreshed_ = true;
  return Status::Ok;
}

// --- what the tracker sends ---------------------------------------------------

Status Device::shareLocation(const Fix& fix, const char* trigger, int movingMin, int stillMin, const char* app, bool viaRadio,
                             int64_t fixTimeMs, JsonVariantConst extra) {
  JsonDocument b;
  b["lat"] = fix.lat;
  b["lng"] = fix.lng;
  if (fix.accuracy >= 0) b["accuracy"] = fix.accuracy; else b["accuracy"] = nullptr;
  if (fix.battery >= 0) b["battery"] = fix.battery / 100.0; else b["battery"] = nullptr;
  b["charging"] = fix.charging;
  if (fix.speed >= 0) b["speed"] = fix.speed; else b["speed"] = nullptr;
  b["trigger"] = trigger;
  if (fix.placeId.empty()) b["placeId"] = nullptr; else b["placeId"] = fix.placeId;
  b["app"] = app;
  b["skin"] = "tracker";
  if (viaRadio) b["via"] = "radio";
  for (JsonPairConst kv : extra.as<JsonObjectConst>()) b[kv.key()] = kv.value();
  JsonObject c = b["cadence"].to<JsonObject>();
  c["stop"] = "custom";
  c["moving"] = movingMin;
  c["still"] = stillMin;
  c["charging"] = fix.charging;
  c["limited"] = false;
  for (int attempt = 0; attempt < 2; attempt++) {
    std::string body;
    // A fix heard over the radio is stamped with when it was taken, not when it was passed on.
    serializeJson(seal("location", b.as<JsonVariantConst>(), "", "", fixTimeMs), body);
    HttpResponse raw;
    Status s = call("PUT", "/locations/me", body, nullptr, &raw);
    if (s == Status::Ok) return s;
    if (raw.status == 409 && errorCode(raw) == "stale_epoch" && attempt == 0) {
      Status r = refresh();
      if (r != Status::Ok) return r;
      continue;
    }
    return s;
  }
  return Status::Failed;
}

Status Device::sos(bool start, bool sendNow) {
  if (start) {
    if (sosActive()) return sendNow ? flushSos() : Status::Ok;
    acct_.sosStartId = acct_.sosId = randomId(12);
    acct_.sosState = "start";
    acct_.sosSent = false;
  } else {
    if (!sosActive()) return Status::Ok;
    // Always say "safe", even if the start never reached the server: it may
    // have gone out over the mesh.
    acct_.sosOf = acct_.sosStartId;
    acct_.sosId = randomId(12);
    acct_.sosState = "safe";
    acct_.sosSent = false;
    // Ended now: the button and the mesh treat it as over, even before the server hears.
    acct_.sosStartId.clear();
  }
  if (!save()) return fail("couldn't save the SOS");
  return sendNow ? flushSos() : Status::Ok;
}

Status Device::flushSos() {
  if (!sosPending()) return Status::Ok;
  JsonDocument b;
  JsonObject s = b["sos"].to<JsonObject>();
  if (acct_.sosState == "start") {
    b["text"] = "\xF0\x9F\x86\x98 " + acct_.name + " sent an SOS. Open HomeCircle to see where they are.";
    s["state"] = "start";
  } else {
    b["text"] = "\xE2\x9C\x85 " + acct_.name + " is safe now.";
    s["state"] = "safe";
    s["of"] = acct_.sosOf;
  }
  for (int attempt = 0; attempt < 2; attempt++) {
    JsonDocument req = seal("chat", b.as<JsonVariantConst>(), acct_.sosId);
    req["id"] = acct_.sosId;
    req["silent"] = false;
    req["urgent"] = true;
    std::string body;
    serializeJson(req, body);
    HttpResponse raw;
    Status st = call("POST", "/messages", body, nullptr, &raw);
    std::string code = st == Status::Ok ? "" : errorCode(raw);
    if (st == Status::Ok || (raw.status == 409 && code == "conflict")) {
      acct_.sosSent = true;
      if (acct_.sosState == "safe") acct_.sosStartId.clear();
      save();
      return Status::Ok;
    }
    if (raw.status == 409 && code == "stale_epoch" && attempt == 0) {
      Status r = refresh();
      if (r != Status::Ok) return r;
      continue;
    }
    return st;
  }
  return Status::Failed;
}

// --- the mesh ----------------------------------------------------------------

static const uint8_t MESH_LOCATION = 1, MESH_SOS_START = 2, MESH_SOS_SAFE = 3;

static void putU16(Bytes& b, uint16_t v) {
  b.push_back(v & 0xff);
  b.push_back(v >> 8);
}
static void putU32(Bytes& b, uint32_t v) {
  for (int i = 0; i < 4; i++) b.push_back((v >> (8 * i)) & 0xff);
}
static Bytes labelled(const char* label, const Bytes& data) {
  Bytes in(label, label + strlen(label));
  in.insert(in.end(), data.begin(), data.end());
  return in;
}

Status Device::registerMesh() {
  if (acct_.meshKey.size() != 32) {
    acct_.meshKey = randomBytes(32);
    acct_.meshRegistered = false;
    save();
  }
  JsonDocument req;
  req["key"] = toB64(acct_.meshKey);
  std::string body;
  serializeJson(req, body);
  Status s = call("PUT", "/members/me/mesh", body, nullptr);
  if (s == Status::Ok) {
    // The server starts counting again for a newly registered key.
    acct_.meshRegistered = true;
    acct_.meshCounter = 0;
    save();
  }
  return s;
}

Bytes Device::meshPacket(uint8_t type, const Bytes& id, const Bytes& content) {
  // The counter only goes up, and is saved before anything is sent, so a
  // nonce is never used twice and the server can refuse replays.
  acct_.meshCounter++;
  save();
  Bytes header = {0x68, 0x63, 1, type};
  Bytes ref = sha512(labelled("homecircle/mesh-ref", bytesOf(acct_.memberId)));
  header.insert(header.end(), ref.begin(), ref.begin() + 8);
  putU32(header, acct_.meshCounter);
  putU16(header, (uint16_t)acct_.epoch);
  header.insert(header.end(), id.begin(), id.end());

  Bytes signedPart = bytesOf("homecircle/mesh-v1");
  signedPart.push_back(0);
  signedPart.insert(signedPart.end(), acct_.circleId.begin(), acct_.circleId.end());
  signedPart.push_back(0);
  signedPart.insert(signedPart.end(), acct_.memberId.begin(), acct_.memberId.end());
  signedPart.push_back(0);
  signedPart.insert(signedPart.end(), header.begin(), header.end());
  signedPart.insert(signedPart.end(), content.begin(), content.end());
  Bytes inner = content;
  Bytes sig = signDetached(signedPart, acct_.id.signSecret);
  inner.insert(inner.end(), sig.begin(), sig.end());

  Bytes nonce = sha512(labelled("homecircle/mesh-nonce", header));
  nonce.resize(24);
  Bytes box = secretbox(inner, nonce, acct_.keyring[acct_.epoch]);
  Bytes packet = header;
  packet.insert(packet.end(), box.begin(), box.end());
  Bytes tag = hmacSha512(acct_.meshKey, packet.data(), packet.size());
  packet.insert(packet.end(), tag.begin(), tag.begin() + 8);
  return packet;
}

Bytes Device::meshLocation(const Fix& fix) {
  Bytes c;
  putU32(c, (uint32_t)(now_() / 1000));
  putU32(c, (uint32_t)(int32_t)lround(fix.lat * 1e7));
  putU32(c, (uint32_t)(int32_t)lround(fix.lng * 1e7));
  putU16(c, fix.accuracy < 0 ? 0xffff : (uint16_t)std::min(65534.0f, fix.accuracy + 0.5f));
  putU16(c, fix.speed < 0 ? 0xffff : (uint16_t)std::min(65534.0f, fix.speed * 100 + 0.5f));
  c.push_back(fix.battery < 0 ? 0xff : (uint8_t)std::min(100, fix.battery));
  c.push_back((fix.charging ? 1 : 0) | (sosActive() ? 2 : 0));
  return meshPacket(MESH_LOCATION, Bytes(), c);
}

Bytes Device::meshSos() {
  if (acct_.sosId.empty()) return Bytes();
  Bytes id, c;
  if (!fromB64(acct_.sosId, id) || id.size() != 12) return Bytes();
  putU32(c, (uint32_t)(now_() / 1000));
  if (acct_.sosState == "start") return meshPacket(MESH_SOS_START, id, c);
  Bytes of;
  if (!fromB64(acct_.sosOf, of) || of.size() != 12) return Bytes();
  c.insert(c.end(), of.begin(), of.end());
  return meshPacket(MESH_SOS_SAFE, id, c);
}

static bool hhmm(const char* s) {
  return s && strlen(s) == 5 && isdigit((unsigned char)s[0]) && isdigit((unsigned char)s[1]) && s[2] == ':' && isdigit((unsigned char)s[3]) && isdigit((unsigned char)s[4]);
}

Status Device::fetchSettings(TrackerSettings& out) {
  out = TrackerSettings();
  if (!refreshed_) {
    Status r = refresh();
    if (r != Status::Ok) return r;
  }
  JsonDocument res;
  Status st = call("GET", "/records?kind=member", "", &res);
  if (st != Status::Ok) return st;
  for (JsonObjectConst r : res["records"].as<JsonArrayConst>()) {
    if (acct_.memberId != (r["subject"] | "") || std::string(r["kind"] | "") != "member") continue;
    std::string by = r["by"] | "";
    auto k = acct_.known.find(by);
    if (!isAdmin(by) || k == acct_.known.end()) continue;
    JsonDocument msg;
    if (!open(r["env"], k->second.signPub, "member", by, msg)) continue;
    JsonObjectConst body = msg["body"];
    if (acct_.memberId != (body["member"] | "")) continue;
    JsonObjectConst t = body["tracker"];
    if (t.isNull()) continue;
    out.fromAdmin = true;
    out.mode = std::string(t["mode"] | "car") == "carried" ? "carried" : "car";
    int moving = t["moving"] | 2, still = t["still"] | 60;
    out.moving = std::min(60, std::max(1, moving));
    out.still = std::min(1440, std::max(5, still));
    const char* from = t["quiet"]["from"] | "";
    const char* to = t["quiet"]["to"] | "";
    out.quiet = hhmm(from) && hhmm(to);
    if (out.quiet) out.quietFrom = from, out.quietTo = to;
    out.sos = t["sos"] | true;
  }
  return Status::Ok;
}

// --- for a home base ------------------------------------------------------------

std::string Device::nameOf(const std::string& memberId) const {
  if (memberId == acct_.memberId) return acct_.name;
  auto k = acct_.known.find(memberId);
  return k == acct_.known.end() ? "" : k->second.name;
}

static std::string lower(std::string s) {
  for (auto& c : s) c = (char)tolower((unsigned char)c);
  return s;
}

std::string Device::memberByName(const std::string& name) const {
  std::string want = lower(trim(name)), found;
  for (auto& kv : acct_.known) {
    if (!roles_.count(kv.first) || lower(kv.second.name) != want) continue;
    if (!found.empty()) return "";  // two people with that name
    found = kv.first;
  }
  return found;
}

Status Device::fetchDirect(std::vector<Direct>& out) {
  out.clear();
  if (!refreshed_) {
    Status r = refresh();
    if (r != Status::Ok) return r;
  }
  JsonDocument res;
  if (acct_.lastSeq < 0) {
    // First time: start from the newest message, not the circle's history.
    Status s = call("GET", "/messages?tail=1&limit=1", "", &res);
    if (s != Status::Ok) return s;
    JsonArrayConst m = res["messages"].as<JsonArrayConst>();
    acct_.lastSeq = m.size() ? (long)(m[m.size() - 1]["seq"] | 0L) : 0;
    save();
    return Status::Ok;
  }
  std::string path = "/messages?after=" + std::to_string(acct_.lastSeq) + "&limit=50";
  Status s = call("GET", path.c_str(), "", &res);
  if (s != Status::Ok) return s;
  bool learned = false;
  for (JsonObjectConst m : res["messages"].as<JsonArrayConst>()) {
    acct_.lastSeq = std::max(acct_.lastSeq, (long)(m["seq"] | 0L));
    std::string from = m["from"] | "", to = m["to"] | "";
    if (to != acct_.memberId || from == acct_.memberId) continue;
    if (!acct_.known.count(from) && !learned) {
      refresh();  // someone who joined since: learn their keys once
      learned = true;
    }
    auto k = acct_.known.find(from);
    if (k == acct_.known.end()) continue;
    JsonDocument msg;
    if (!open(m["env"], k->second.signPub, "chat", from, msg, to)) continue;
    Direct d;
    d.from = from;
    d.fromName = k->second.name;
    d.text = msg["body"]["text"] | "";
    d.checkin = msg["body"]["checkin"] | "";
    d.fromAdmin = isAdmin(from);
    JsonObjectConst tf = msg["body"]["trackerFix"];
    if (!tf.isNull()) {
      d.fixNode = tf["node"] | "";
      d.fix.lat = tf["lat"] | 0.0;
      d.fix.lng = tf["lng"] | 0.0;
      d.fix.battery = tf["battery"] | -1;
      d.fixAt = tf["at"] | (int64_t)0;
    }
    if (!d.text.empty() || !d.fixNode.empty()) out.push_back(d);
  }
  save();
  return Status::Ok;
}

Status Device::sendDirect(const std::string& to, const std::string& text, bool checkinOk) {
  if (!acct_.known.count(to)) return fail("that member's keys aren't known yet");
  JsonDocument b;
  b["text"] = text.substr(0, 4000);
  if (checkinOk) b["checkin"] = "ok";
  std::string id = randomId(12);
  for (int attempt = 0; attempt < 2; attempt++) {
    JsonDocument req = seal("chat", b.as<JsonVariantConst>(), id, to);
    req["id"] = id;
    req["to"] = to;
    req["silent"] = false;
    std::string body;
    serializeJson(req, body);
    HttpResponse raw;
    Status s = call("POST", "/messages", body, nullptr, &raw);
    if (s == Status::Ok) return s;
    if (raw.status == 409 && errorCode(raw) == "stale_epoch" && attempt == 0) {
      Status r = refresh();
      if (r != Status::Ok) return r;
      continue;
    }
    return s;
  }
  return Status::Failed;
}

Status Device::sendGroup(const std::string& text, bool urgent) {
  JsonDocument b;
  b["text"] = text.substr(0, 4000);
  std::string id = randomId(12);
  for (int attempt = 0; attempt < 2; attempt++) {
    JsonDocument req = seal("chat", b.as<JsonVariantConst>(), id);
    req["id"] = id;
    req["silent"] = false;
    if (urgent) req["urgent"] = true;
    std::string body;
    serializeJson(req, body);
    HttpResponse raw;
    Status s = call("POST", "/messages", body, nullptr, &raw);
    if (s == Status::Ok) return s;
    if (raw.status == 409 && errorCode(raw) == "stale_epoch" && attempt == 0) {
      Status r = refresh();
      if (r != Status::Ok) return r;
      continue;
    }
    return s;
  }
  return Status::Failed;
}

Status Device::memberRecords(const std::function<void(const std::string&, JsonObjectConst)>& fn) {
  JsonDocument res;
  Status s = call("GET", "/records?kind=member", "", &res);
  if (s != Status::Ok) return s;
  for (JsonObjectConst r : res["records"].as<JsonArrayConst>()) {
    std::string subject = r["subject"] | "";
    std::string by = r["by"] | "";
    // Only records an admin signed count (the server checks too).
    auto role = roles_.find(by);
    if (role == roles_.end() || (role->second != "admin" && role->second != "owner")) continue;
    auto k = acct_.known.find(by);
    Bytes signPub = by == acct_.memberId ? acct_.id.signPub : k == acct_.known.end() ? Bytes() : k->second.signPub;
    JsonDocument msg;
    if (signPub.size() && open(r["env"], signPub, "member", by, msg)) fn(subject, msg["body"].as<JsonObjectConst>());
  }
  return Status::Ok;
}

Status Device::memberLocations(std::vector<MemberLoc>& out) {
  out.clear();
  JsonDocument res;
  Status s = call("GET", "/locations", "", &res);
  if (s != Status::Ok) return s;
  for (JsonObjectConst l : res["locations"].as<JsonArrayConst>()) {
    std::string id = l["memberId"] | "";
    auto k = acct_.known.find(id);
    if (id == acct_.memberId || k == acct_.known.end()) continue;
    JsonVariantConst env = l["env"];
    if (!env["ct"].is<const char*>()) continue;  // a tracker's mesh packet: not a phone
    JsonDocument msg;
    if (!open(env, k->second.signPub, "location", id, msg)) continue;
    MemberLoc m;
    m.memberId = id;
    m.name = k->second.name;
    m.ts = msg["ts"] | (int64_t)0;
    m.paused = msg["body"]["paused"] | false;
    m.stillMin = msg["body"]["cadence"]["still"] | 0;
    out.push_back(m);
  }
  return Status::Ok;
}

Status Device::createInvite(std::string& link, int hours) {
  Bytes s = randomBytes(32);
  std::string secret = toB64(s);
  Bytes auth = kdf("homecircle/invite-auth", s.data(), s.size());
  Bytes wrapKey = kdf("homecircle/invite-wrap", s.data(), s.size());
  Bytes authHash = sha512(auth);
  authHash.resize(32);
  for (int attempt = 0; attempt < 2; attempt++) {
    JsonDocument payload;
    payload["circleKey"] = toB64(acct_.keyring[acct_.epoch]);
    payload["epoch"] = acct_.epoch;
    payload["circle"] = acct_.circleId;
    payload["circleName"] = acct_.circleName;
    payload["invitedByName"] = acct_.name;
    std::string plain;
    serializeJson(payload, plain);
    Bytes nonce = randomBytes(24);
    JsonDocument req;
    std::string id = randomId(9);
    req["id"] = id;
    req["authHash"] = toB64(authHash);
    req["wrapped"]["nonce"] = toB64(nonce);
    req["wrapped"]["ct"] = toB64(secretbox(bytesOf(plain), nonce, wrapKey));
    req["epoch"] = acct_.epoch;
    req["hours"] = hours;
    std::string body;
    serializeJson(req, body);
    HttpResponse raw;
    Status st = call("POST", "/invites", body, nullptr, &raw);
    if (st == Status::Ok) {
      link = acct_.server + "/join#" + id + "." + secret;
      return st;
    }
    if (raw.status == 409 && errorCode(raw) == "stale_epoch" && attempt == 0) {
      Status r = refresh();
      if (r != Status::Ok) return r;
      continue;
    }
    return st;
  }
  return Status::Failed;
}

Status Device::mergeMemberRecord(const std::string& subject, JsonVariantConst patch, int64_t reuseMs) {
  JsonDocument body;
  Status s;
  int64_t now = now_();
  bool reuse = reuseMs > 0 && recordFor_ == subject && now - recordReadAt_ < reuseMs &&
               deserializeJson(body, recordBody_) == DeserializationError::Ok;
  if (!reuse) {
    // Start from what an admin saved before, so other settings stay.
    body.clear();
    JsonDocument res;
    s = call("GET", "/records?kind=member", "", &res);
    if (s != Status::Ok) return s;
    for (JsonObjectConst r : res["records"].as<JsonArrayConst>()) {
      if (subject != (r["subject"] | "")) continue;
      std::string by = r["by"] | "";
      auto k = acct_.known.find(by);
      Bytes signPub = by == acct_.memberId ? acct_.id.signPub : k == acct_.known.end() ? Bytes() : k->second.signPub;
      JsonDocument msg;
      if (signPub.size() && open(r["env"], signPub, "member", by, msg)) body.set(msg["body"]);
    }
    recordReadAt_ = now;
  }
  if (!body.is<JsonObject>()) body.to<JsonObject>();
  for (JsonPairConst kv : patch.as<JsonObjectConst>()) body[kv.key()] = kv.value();
  body["member"] = subject;
  if (!body["skin"].is<const char*>()) body["skin"] = "full";
  std::string path = "/records/member/" + subject;
  for (int attempt = 0; attempt < 2; attempt++) {
    std::string req;
    serializeJson(seal("member", body.as<JsonVariantConst>()), req);
    HttpResponse raw;
    s = call("PUT", path.c_str(), req, nullptr, &raw);
    if (s == Status::Ok) {
      recordFor_ = subject;
      recordBody_.clear();
      serializeJson(body, recordBody_);
      return s;
    }
    recordFor_.clear();  // read it afresh next time
    if (raw.status == 409 && errorCode(raw) == "stale_epoch" && attempt == 0) {
      Status r = refresh();
      if (r != Status::Ok) return r;
      continue;
    }
    return s;
  }
  return Status::Failed;
}

Status Device::rename(const std::string& name) {
  std::string n = trim(name).substr(0, 40);
  if (n.empty()) return fail("a name is needed");
  acct_.name = n;
  save();
  JsonDocument p;
  JsonDocument pb = profileBody();
  p["profile"] = seal("profile", pb.as<JsonVariantConst>());
  std::string body;
  serializeJson(p, body);
  return call("PUT", "/members/me/profile", body, nullptr);
}

Status Device::fetchPlaces(std::vector<Place>& out) {
  out.clear();
  JsonDocument res;
  Status s = call("GET", "/places", "", &res);
  if (s != Status::Ok) return s;
  for (JsonObjectConst p : res["places"].as<JsonArrayConst>()) {
    std::string id = p["id"] | "", by = p["updatedBy"] | "";
    auto k = acct_.known.find(by);
    Bytes signPub = by == acct_.memberId ? acct_.id.signPub : k == acct_.known.end() ? Bytes() : k->second.signPub;
    JsonDocument msg;
    if (signPub.empty() || !open(p["env"], signPub, "place", by, msg)) continue;
    JsonObjectConst b = msg["body"];
    if (id != (b["id"] | "") || !b["lat"].is<double>() || !b["lng"].is<double>()) continue;
    Place pl;
    pl.id = id;
    pl.name = std::string(b["name"] | "a place").substr(0, 40);
    pl.lat = b["lat"].as<double>();
    pl.lng = b["lng"].as<double>();
    double r = b["radius"] | 150.0;
    pl.radius = r < 50 ? 50 : r > 5000 ? 5000 : r;  // as the apps read it
    out.push_back(pl);
  }
  return Status::Ok;
}

Status Device::postEvent(JsonVariantConst body) {
  std::string id = randomId(12);
  for (int attempt = 0; attempt < 2; attempt++) {
    JsonDocument req = seal("event", body, id);
    req["id"] = id;
    req["silent"] = false;
    std::string out;
    serializeJson(req, out);
    HttpResponse raw;
    Status s = call("POST", "/messages", out, nullptr, &raw);
    if (s == Status::Ok || (raw.status == 409 && errorCode(raw) == "conflict")) return Status::Ok;
    if (raw.status == 409 && errorCode(raw) == "stale_epoch" && attempt == 0) {
      Status r = refresh();
      if (r != Status::Ok) return r;
      continue;
    }
    return s;
  }
  return Status::Failed;
}

Status Device::pluginSettings(const char* id, JsonDocument& out) {
  std::string path = std::string("/plugins/") + id + "/settings";
  return call("GET", path.c_str(), "", &out);
}

Status Device::registerKeeper(const std::string& keeper) {
  JsonDocument req;
  req["keeper"] = keeper;
  std::string body;
  serializeJson(req, body);
  return call("PUT", "/members/me/keeper", body, nullptr);
}

Status Device::registerBeacons(const std::vector<std::pair<std::string, std::string>>& nodes) {
  JsonDocument req;
  JsonArray a = req["nodes"].to<JsonArray>();
  for (auto& n : nodes) {
    JsonObject o = a.add<JsonObject>();
    o["node"] = n.first;
    o["member"] = n.second;
  }
  std::string body;
  serializeJson(req, body);
  return call("PUT", "/keeper/beacons", body, nullptr);
}

Status Device::keeperPending(std::vector<Pending>& out) {
  out.clear();
  JsonDocument res;
  Status s = call("GET", "/keeper/pending", "", &res);
  if (s != Status::Ok) return s;
  for (JsonObjectConst i : res["pending"].as<JsonArrayConst>()) {
    Pending p;
    p.type = i["type"] | "";
    p.member = i["member"] | "";
    p.from = i["from"] | "";
    p.seq = i["seq"] | 0L;
    p.lat = i["lat"] | 0.0;
    p.lng = i["lng"] | 0.0;
    p.at = i["at"] | (int64_t)0;
    p.gateway = i["gateway"] | "";
    out.push_back(p);
  }
  return Status::Ok;
}

Status Device::leave() {
  std::string path = "/members/" + acct_.memberId;
  Status s = call("DELETE", path.c_str(), "", nullptr);
  if (s == Status::Ok || s == Status::Removed) {
    forget();
    return Status::Ok;
  }
  return s;
}

}  // namespace hc
