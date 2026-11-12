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
#include <map>
#include <memory>

#include "hc_device.h"
#include "hc_gnss.h"

namespace hc {

struct HeardNode {
  uint32_t num = 0;
  std::string name;      // its long name, if it sent one
  int64_t heardAtMs = 0;
  float snr = -999;      // dB when last heard; -999 unknown
  int battery = -1;      // percent from its telemetry (101: on external power); below 0 unknown
  float volts = -1;      // battery voltage; below 0 unknown
};

/** How the home base itself is doing: it's on mains or solar, so it reports this often. */
struct SelfInfo {
  int battery = -1;      // percent (101: on external power with no battery); below 0 unknown
  float volts = -1;      // battery voltage; below 0 unknown
  bool plugged = false;  // USB or external power present
  int wifiRssi = 0;      // dBm; 0 unknown
  int64_t uptimeS = -1;
  int heapKb = -1;       // free memory
  float chUtil = -1;     // LoRa channel busy, percent of the last minute
  float airTx = -1;      // its own transmitting, percent of the last hour
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
  /** This node's own GPS: false if it has none. */
  virtual bool selfGnss(SelfGnss& out) { return false; }
  /** The satellites this node's GPS can see, if it tracks them. */
  virtual const GnssSky* sky() { return nullptr; }
  /** A text to the node itself; the bell character (\a) makes a tracker beep if it's set to. */
  virtual void alert(uint32_t node, const std::string& text) {}
  /** Start a traceroute to a node; the answer comes back through HomeBase::onRoute. */
  virtual void traceroute(uint32_t node) {}
  /** A node's name as the mesh knows it ("" if unknown). */
  virtual std::string nodeName(uint32_t num) { return ""; }
  /** How many hops away the node was when last heard (-1: unknown). */
  virtual int hopsAway(uint32_t node) { return -1; }
  /** Its own power, Wi-Fi and radio load: false if it can't tell. */
  virtual bool selfInfo(SelfInfo& out) { return false; }
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
  /**
   * A traceroute's answer: the relays the reply passed through on its way
   * back from the tracker (in order), and the signal each heard it with
   * (dB × 4); the last signal is this node's.
   */
  void onRoute(uint32_t node, const std::vector<uint32_t>& back, const std::vector<int>& snrBack4);
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
    bool keeperSet = false;                       // the server knows this home base keeps it
    std::map<std::string, std::string> atPlaces;  // place id -> "arrived" or "left"
    std::vector<std::pair<std::string, int64_t>> checkins;  // who asked it to check in, and when
    bool okPressed = false;                       // it sent "ok": answer the check-ins
    struct Hop {
      uint32_t num = 0;
      std::string name;
      float snr = 0;      // dB, as the next node heard it; 0: unknown
      bool hasSnr = false;
    };
    std::vector<Hop> path;  // tracker, relays, home base
    int64_t pathAt = 0, tracedAt = 0;
    bool pathDirty = false;  // a new path for the map: send the last position again with it
    Fix sentFix;             // the last position sent
  };

  Http& http_;
  Store& store_;
  int64_t (*now_)();
  Radio& radio_;
  Device base_;
  std::vector<std::unique_ptr<Tracker>> trackers_;
  std::vector<std::string> meshQueue_;
  int64_t nextDirect_ = 0, nextWatch_ = 0;
  int64_t selfSharedAt_ = 0, selfFixSent_ = 0;
  int64_t nextPending_ = 0, nextPlaces_ = 0, nextKeeper_ = 0, nextStatus_ = 0;
  // The Meshtastic plugin: on or off for the circle, and its settings.
  bool enabled_ = true;
  int64_t quietMs_ = 30 * 60 * 1000;
  int64_t traceEveryMs_ = 30 * 60 * 1000;  // 0: only when someone taps Locate
  std::vector<std::string> sosWords_ = {"sos", "help"};
  void readPlugin();
  std::vector<Place> places_;

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
  void handle(const Pending& p);
  /** Its own status in the record about itself, for the app's Trackers screen. */
  void publishStatus();
  /** The radio path for the location body: { mesh: { hops, at, path: [{ id, name, snr }] } }. */
  void meshInfo(Tracker& t, JsonDocument& out);
  /** Arrived and left, for a tracker's new fix: sets fix.placeId, returns the changes to announce. */
  std::vector<std::pair<const Place*, std::string>> checkPlaces(Tracker& t, Fix& fix);
  /** Put the home base itself on the map, from its own GPS. True if it had a fix to send. */
  bool shareSelf(bool asked);
};

}  // namespace hc
