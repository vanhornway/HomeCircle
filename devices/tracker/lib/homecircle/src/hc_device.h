// A tracker device as a member of a HomeCircle circle (docs/PROTOCOL.md).
//
// It joins with an ordinary invite link, makes its own keys, and from then
// on only sends: its location (sealed with the circle key, signed with its
// own key) and SOS messages. It reads two things back: the admins' profiles,
// to know whose new circle keys and settings to trust, and the admin's
// `member` record about itself, for how often to report.
//
// No Arduino code in here: the same files build for the ESP32 firmware and
// for the host tests. The board supplies HTTP, storage and the clock.
#pragma once
#include <ArduinoJson.h>

#include <map>
#include <vector>
#include <string>

#include "hc_crypto.h"

namespace hc {

struct HttpResponse {
  int status = -1;  // below 0: no connection
  std::string body;
};

class Http {
 public:
  virtual ~Http() = default;
  /** A JSON request; `token` empty for public calls, `body` empty for none. */
  virtual HttpResponse request(const char* method, const std::string& url, const std::string& token, const std::string& body) = 0;
};

class Store {
 public:
  virtual ~Store() = default;
  virtual bool get(const char* key, std::string& out) = 0;
  virtual bool put(const char* key, const std::string& value) = 0;
  virtual void remove(const char* key) = 0;
};

struct Fix {
  double lat = 0, lng = 0;
  float accuracy = -1;  // metres; below 0 unknown
  float speed = -1;     // metres a second; below 0 unknown
  int battery = -1;     // percent; below 0 unknown
  bool charging = false;
};

/** How to report, from the admin's member record (defaults until one exists). */
struct TrackerSettings {
  bool fromAdmin = false;
  std::string mode = "car";
  int moving = 2;   // minutes between reports while moving
  int still = 60;   // minutes between reports while still
  bool quiet = false;
  std::string quietFrom, quietTo;  // "HH:MM"
  bool sos = true;
};

enum class Status {
  Ok,
  Offline,  // no connection, or the server didn't answer
  Removed,  // the server no longer knows this device (removed from the circle)
  Failed,   // anything else; error() says what
};

const char* statusName(Status s);

class Device {
 public:
  Device(Http& http, Store& store, int64_t (*nowMs)());

  /** Load the saved account. False if this device hasn't joined a circle. */
  bool load();
  bool joined() const { return !acct_.token.empty(); }

  /** Join with an invite link (https://server/join#id.secret or homecircle://join?…). */
  Status join(const std::string& link, const std::string& name);

  /** Fetch the circle: trust its admins' keys, pick up a new circle key, re-seal the profile. */
  Status refresh();

  /**
   * Send a location. `movingMin`/`stillMin` tell the circle how often to
   * expect one; `app` names what sent it; `viaRadio` marks one that came over
   * the mesh (a home base sending for a Meshtastic tracker).
   */
  Status shareLocation(const Fix& fix, const char* trigger, int movingMin, int stillMin, const char* app = "tracker", bool viaRadio = false,
                       int64_t fixTimeMs = 0);

  /** Start (true) or end (false) an SOS. It is saved first and sent until the server has it. */
  Status sos(bool start, bool sendNow = true);
  /** Send a saved SOS start or end that hasn't reached the server yet. */
  Status flushSos();
  bool sosActive() const { return acct_.sosStartId.size() > 0; }
  bool sosPending() const { return !acct_.sosId.empty() && !acct_.sosSent; }

  /** Read the admin's settings for this device. */
  Status fetchSettings(TrackerSettings& out);

  // --- the mesh (Meshtastic) ---------------------------------------------
  // Compact packets for one LoRa packet (packages/core/src/mesh.js has the
  // layout). Sealed and signed like everything else; a home base hands
  // them to the server, which can't read them.

  /** Tell the server the key this device's mesh packets are tagged with (needs the internet once). */
  Status registerMesh();
  bool meshRegistered() const { return acct_.meshRegistered; }
  /** A location as a mesh packet (about 124 bytes). */
  Bytes meshLocation(const Fix& fix);
  /** The open SOS (or the "safe" that ended it) as a mesh packet; empty if there's none to send. */
  Bytes meshSos();

  /** Delete the account from storage (the device goes back to setup). */
  void forget();

  // --- for a home base -----------------------------------------------------
  // A home base is a member that talks with admins in direct messages and
  // acts for Meshtastic trackers that can't reach HomeCircle themselves.

  struct Direct {
    std::string from, fromName, text;
    bool fromAdmin = false;
  };
  struct MemberLoc {
    std::string memberId, name;
    int64_t ts = 0;      // when it was taken (0: none)
    int stillMin = 0;    // how often it said to expect one while still (0: unknown)
    bool paused = false;
  };

  /** Direct messages to this device since the last call (the first call only marks where to start). */
  Status fetchDirect(std::vector<Direct>& out);
  Status sendDirect(const std::string& to, const std::string& text);
  /** Every other member's latest location, opened and verified. */
  Status memberLocations(std::vector<MemberLoc>& out);
  /** The id of the member with this name (case doesn't matter); empty if none or several. */
  std::string memberByName(const std::string& name) const;
  std::string nameOf(const std::string& memberId) const;
  bool amAdmin() const { return isAdmin(acct_.memberId); }
  /** Admins: a one-time invite link for this circle. */
  Status createInvite(std::string& link, int hours = 1);
  /** Admins: save fields into the member record about someone (merged with what's there). */
  Status mergeMemberRecord(const std::string& subject, JsonVariantConst patch);
  /** Change this member's name in the circle. */
  Status rename(const std::string& name);
  /** Leave the circle, then forget it. */
  Status leave();

  const std::string& error() const { return err_; }
  const std::string& name() const { return acct_.name; }
  const std::string& memberId() const { return acct_.memberId; }
  const std::string& server() const { return acct_.server; }
  const std::string& circleName() const { return acct_.circleName; }
  long epoch() const { return acct_.epoch; }

 private:
  struct Known {
    Bytes signPub, boxPub;
    std::string name;
  };
  struct Account {
    std::string server, token, memberId, circleId, circleName, name, color;
    long epoch = 0;
    std::map<long, Bytes> keyring;
    Identity id;
    std::map<std::string, Known> known;  // members whose keys this device verified
    long lastSeq = -1;                   // messages read up to here (-1: not started)
    std::string sosStartId;              // the open SOS, if any
    std::string sosId, sosState;         // the newest SOS message (start or safe)
    std::string sosOf;                   // the SOS a "safe" ends
    bool sosSent = true;
    Bytes meshKey;           // tags mesh packets so the server knows they're ours
    uint32_t meshCounter = 0;
    bool meshRegistered = false;
  };

  Http& http_;
  Store& store_;
  int64_t (*now_)();
  Account acct_;
  std::string err_;
  bool refreshed_ = false;
  std::map<std::string, std::string> roles_;  // from the last /state

  bool save();
  Status fail(const std::string& why);
  Status fromResponse(const HttpResponse& r, JsonDocument* out);
  Status call(const char* method, const char* path, const std::string& body, JsonDocument* out, HttpResponse* raw = nullptr);
  static std::string errorCode(const HttpResponse& r);

  JsonDocument seal(const char* kind, JsonVariantConst body, const std::string& id = "", const std::string& to = "", int64_t ts = 0);
  bool open(JsonVariantConst env, const Bytes& signPub, const char* kind, const std::string& from, JsonDocument& msg,
            const std::string& to = "");
  Bytes directKey(const std::string& peer) const;
  JsonDocument profileBody();

  Bytes meshPacket(uint8_t type, const Bytes& id, const Bytes& content);

  void trustMembers(JsonArrayConst members);
  Status syncKeys(JsonArrayConst members);
  bool isAdmin(const std::string& memberId) const;
};

/** Split an invite link. False if it isn't one. */
bool parseInvite(const std::string& link, std::string& server, std::string& inviteId, std::string& secret);

}  // namespace hc
