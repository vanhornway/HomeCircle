// One home base in up to 3 circles. Each circle gets its own HomeBase (its own
// account, trackers, places, chat and settings), kept under its own prefix in
// the store; the first keeps the keys it always had, so a home base from
// before upgrades in place. The radio is shared:
//
// - What the radio hears goes to every circle; each acts on its own trackers.
//   A tracker can be in several circles: each gets its positions, presses and
//   SOS. An SOS ended from the app in one ends in all.
// - A tracker's settings (how often it reports, beacon, public SOS) come from
//   the circle that added it first; the others see it but don't set it.
// - Requests that would go out once per circle (where are you, traceroutes,
//   SOS confirmations, this node's key) go out once.
// - An admin in any of its circles can update the home base or change its own
//   settings (the user's choice), and add it to another circle with "join".
#pragma once
#include <set>

#include "hc_homebase.h"

namespace hc {

class HomeBases {
 public:
  static const size_t MAX_CIRCLES = 3;

  HomeBases(Http& http, Store& store, int64_t (*nowMs)(), Radio& radio);
  ~HomeBases();

  /** Load the circles it's in. False if it hasn't joined any. */
  bool load();
  bool ready() const;
  /** The first circle's account (setup page, logs). */
  Device& base();
  /** Join the first circle (the setup page). */
  Status setup(const std::string& invite, const std::string& name = "Home base");
  void forget();
  void tick();

  void onPosition(uint32_t node, const Fix& fix, int64_t fixTimeMs);
  void onText(uint32_t node, const std::string& text);
  void onChannelText(uint32_t node, const std::string& name, const std::string& text);
  void onMeshPacket(const Bytes& packet);
  void onRoute(uint32_t node, const std::vector<uint32_t>& back, const std::vector<int>& snrBack4);
  void onConfigured(uint32_t node, ConfigResult r);
  void onNoFix(uint32_t node);
  void onHeard(uint32_t node, int hops, uint32_t relay, float snr, bool position = true, Source src = Source::Radio, const std::string& gateway = "");

  bool isTracker(uint32_t node) const;
  size_t trackerCount() const;
  size_t circleCount() const;
  bool takeUpdate(HomeBase::Update& out);
  void updateNews(const std::string& to, const std::string& text);
  int64_t reportedAt() const;

  std::string log;

  /** The circle whose settings a tracker takes (its slot), or -1 if it's in none. */
  int settingsSlot(uint32_t node) const;
  /** True the first time a request with this key goes out for the event at hand. */
  bool once(const std::string& key, int64_t unused = 0);

 private:
  struct Slot;
  Http& http_;
  Store& store_;
  int64_t (*now_)();
  Radio& radio_;
  std::vector<std::unique_ptr<Slot>> slots_;
  std::set<std::string> sent_;  // requests out for the event at hand
  std::vector<int> leaving_;  // slots that asked to leave (done after their tick)

  Slot& add(int id);
  void wire(Slot& s);
  void saveSlots();
  HomeBase* first();
  std::string circlesCommand(Slot& from, const std::string& verb, const std::string& rest, const Device::Direct& d);
  void collectLog();
};

}  // namespace hc
