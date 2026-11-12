// What a node's GPS can see: satellites in view and used, from the NMEA
// sentences its GPS module sends (GSV and GSA), and a plain-language
// description of its own fix. Used by the home base's "gps" command.
#pragma once
#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace hc {

struct Satellite {
  std::string system;  // GPS, GLONASS, BeiDou, Galileo, QZSS, NavIC
  int prn = 0;
  int elevation = -1;  // degrees above the horizon; -1 unknown
  int azimuth = -1;    // degrees from north; -1 unknown
  int snr = 0;         // signal, dB-Hz; 0: in view but not heard
  bool used = false;   // part of the current fix
  int64_t seenAt = 0;
};

/** The node's own fix, as the node reports it. */
struct SelfGnss {
  bool present = false;  // the node has a GPS at all
  bool hasFix = false;
  double lat = 0, lng = 0;
  float altitudeM = 0;
  float accuracyM = -1;
  int64_t fixAtMs = 0;
  int fixType = 0;    // 2: 2D, 3: 3D, 0: unknown
  int satsUsed = 0;
  float hdop = -1;
};

class GnssSky {
 public:
  /** Feed the GPS module's output one character at a time. */
  void feed(char c, int64_t nowMs);
  /** One NMEA sentence ("$GPGSV,…*7A"); bad checksums are ignored. */
  void sentence(const std::string& s, int64_t nowMs);
  /** Satellites heard from in the last `withinMs`, strongest first. */
  std::vector<Satellite> inView(int64_t nowMs, int64_t withinMs = 5 * 60 * 1000) const;
  int64_t lastHeardAt() const { return lastAt_; }

 private:
  std::string line_;
  std::map<std::string, Satellite> sats_;             // "GPS 12" -> satellite
  std::map<std::string, std::vector<int>> used_;      // system -> PRNs in the fix
  std::map<std::string, int64_t> usedAt_;
  int64_t lastAt_ = 0;
};

/** The answer to "gps": the fix, a map link, and the satellites by system. */
std::string describeGnss(const SelfGnss* self, const GnssSky* sky, int64_t nowMs);

}  // namespace hc
