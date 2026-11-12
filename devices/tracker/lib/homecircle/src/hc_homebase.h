// A HomeCircle home base: a Meshtastic node at home (or anywhere with
// Wi-Fi) that is a member of the circle and acts for ordinary Meshtastic
// trackers (SenseCAP T1000-E, Heltec, LilyGO…) that run stock firmware.
//
// - Each tracker becomes its own member, with its own keys held here, named
//   by an admin ("Honda CR-V", "Leo's tracker"). Its positions, heard over
//   the private HomeCircle channel, are sealed here and sent to the server
//   as that member's location, marked "via radio".
// - Admins talk to the home base in direct messages in the app: add, list,
//   rename, link (who carries it), remove.
// - When a person's phone goes quiet, it asks the tracker they carry for a
//   fresh position over the mesh.
// - An alert from a tracker ("SOS", or the bell character) becomes an SOS
//   from that tracker in the circle.
// - Packets from HomeCircle-firmware trackers are passed to the server as
//   they are (sealed at the tracker; mesh.js).
//
// No Meshtastic code here: the node supplies a Radio. The same code runs on
// the board and in the host tests.
#pragma once
#include <memory>

#include "hc_device.h"

namespace hc {

struct HeardNode {
  uint32_t num = 0;
  std::string name;      // its long name, if it sent one
  int64_t heardAtMs = 0;
};

/** What the home base needs from the Meshtastic node. */
class Radio {
 public:
  virtual ~Radio() = default;
  /** Ask a node for a fresh position (Meshtastic position request). */
  virtual void requestPosition(uint32_t node) = 0;
  /** Nodes heard lately. */
  virtual void nodes(std::vector<HeardNode>& out) = 0;
  /** A link that puts a tracker on the private HomeCircle channel (meshtastic.org/e/#…). */
  virtual std::string channelLink() = 0;
};

/** Keys under a prefix, so each tracker's account has its own place in one store. */
class PrefixStore : public Store {
 public:
  PrefixStore(Store& inner, std::string prefix) : inner_(inner), prefix_(std::move(prefix)) {}
  bool get(const char* key, std::string& out) override { return inner_.get((prefix_ + key).c_str(), out); }
  bool put(const char* key, const std::string& v) override { return inner_.put((prefix_ + key).c_str(), v); }
  void remove(const char* key) override { inner_.remove((prefix_ + key).c_str()); }

 private:
  Store& inner_;
  std::string prefix_;
};

std::string nodeId(uint32_t num);                       // "!a1b2c3d4"
bool parseNodeId(const std::string& s, uint32_t& num);  // "!a1b2c3d4" or "a1b2c3d4"

class HomeBase {
 public:
  HomeBase(Http& http, Store& store, int64_t (*nowMs)(), Radio& radio);

  /** Load the saved home base and its trackers. False if it hasn't joined a circle. */
  bool load();
  bool ready() const { return base_.joined(); }
  Device& base() { return base_; }

  /** Join the circle with an invite link. */
  Status setup(const std::string& invite, const std::string& name = "Home base");
  /** Forget the circle and every tracker (they stay members until an admin removes them). */
  void forget();

  /** Call every few seconds: does whatever is due. */
  void tick();

  // From the radio.
  void onPosition(uint32_t node, const Fix& fix, int64_t fixTimeMs);
  void onText(uint32_t node, const std::string& text);
  void onMeshPacket(const Bytes& packet);
  bool isTracker(uint32_t node) const;
  size_t trackerCount() const { return trackers_.size(); }

  /** What it did last, for the node's log. */
  std::string log;

 private:
  struct Tracker {
    uint32_t node = 0;
    std::string name, kind = "person", carriedBy;
    std::unique_ptr<PrefixStore> store;
    std::unique_ptr<Device> dev;
    bool pending = false;
    Fix fix;
    int64_t fixAt = 0;      // when the pending fix was taken
    int64_t sentFixAt = 0;  // the newest fix sent to the server
    int64_t sentAt = 0;     // when it was sent
    int64_t askedAt = 0;    // last position request
    bool sosChanged = false;
  };

  Http& http_;
  Store& store_;
  int64_t (*now_)();
  Radio& radio_;
  Device base_;
  std::vector<std::unique_ptr<Tracker>> trackers_;
  std::vector<std::string> meshQueue_;
  int64_t nextDirect_ = 0, nextWatch_ = 0;

  Tracker* find(const std::string& ref);
  Tracker* byNode(uint32_t node);
  Tracker& adopt(uint32_t node);
  void saveTrackers();
  void writeRecord(Tracker& t);
  void command(const Device::Direct& d);
  std::string listText();
  void upload(Tracker& t);
  void watch();
  void forwardMesh();
};

}  // namespace hc
