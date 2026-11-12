#include "hc_gnss.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>

namespace hc {

namespace {

// NMEA talker ids to systems. GN means "several": GSA then names the system in its last field.
std::string systemOf(const std::string& talker) {
  if (talker == "GP") return "GPS";
  if (talker == "GL") return "GLONASS";
  if (talker == "GB" || talker == "BD") return "BeiDou";
  if (talker == "GA") return "Galileo";
  if (talker == "GQ" || talker == "QZ") return "QZSS";
  if (talker == "GI") return "NavIC";
  return "";
}

std::string systemOfId(int id) {
  switch (id) {
    case 1: return "GPS";
    case 2: return "GLONASS";
    case 3: return "Galileo";
    case 4: return "BeiDou";
    case 5: return "QZSS";
    case 6: return "NavIC";
    default: return "";
  }
}

std::vector<std::string> fields(const std::string& body) {
  std::vector<std::string> out;
  size_t start = 0;
  for (;;) {
    size_t comma = body.find(',', start);
    out.push_back(body.substr(start, comma == std::string::npos ? std::string::npos : comma - start));
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
  return out;
}

int num(const std::string& s, int fallback = -1) {
  return s.empty() ? fallback : atoi(s.c_str());
}

std::string ago(int64_t ms) {
  char buf[32];
  if (ms < 60 * 1000) snprintf(buf, sizeof buf, "%d s ago", (int)(ms / 1000));
  else if (ms < 3600 * 1000) snprintf(buf, sizeof buf, "%d min ago", (int)(ms / 60000));
  else snprintf(buf, sizeof buf, "%d h ago", (int)(ms / 3600000));
  return buf;
}

}  // namespace

void GnssSky::feed(char c, int64_t nowMs) {
  if (c == '$') line_.clear();
  if (c == '\r' || c == '\n') {
    if (line_.size() > 6) sentence(line_, nowMs);
    line_.clear();
    return;
  }
  if (line_.size() < 120) line_ += c;
}

void GnssSky::sentence(const std::string& s, int64_t nowMs) {
  if (s.size() < 10 || s[0] != '$') return;
  size_t star = s.rfind('*');
  if (star == std::string::npos || star + 3 > s.size()) return;
  uint8_t sum = 0;
  for (size_t i = 1; i < star; i++) sum ^= (uint8_t)s[i];
  if ((int)strtol(s.substr(star + 1, 2).c_str(), nullptr, 16) != sum) return;
  std::vector<std::string> f = fields(s.substr(1, star - 1));
  if (f.empty() || f[0].size() != 5) return;
  std::string talker = f[0].substr(0, 2), type = f[0].substr(2);

  if (type == "GSV" && f.size() >= 4) {
    // $xxGSV,total,number,inView,{prn,elevation,azimuth,snr}x1..4[,signalId]
    std::string system = systemOf(talker);
    if (system.empty()) return;
    // Groups of four; the last may lack its signal, and NMEA 4.10 adds a signal id after the groups.
    for (size_t i = 4; i + 2 < f.size(); i += 4) {
      int prn = num(f[i], 0);
      if (prn <= 0) continue;
      Satellite& sat = sats_[system + " " + std::to_string(prn)];
      sat.system = system;
      sat.prn = prn;
      sat.elevation = num(f[i + 1]);
      sat.azimuth = num(f[i + 2]);
      sat.snr = i + 3 < f.size() ? num(f[i + 3], 0) : 0;
      sat.seenAt = nowMs;
    }
    lastAt_ = nowMs;
  } else if (type == "GSA" && f.size() >= 15) {
    // $xxGSA,mode,fix,prn x12,PDOP,HDOP,VDOP[,systemId]
    std::string system = talker == "GN" && f.size() >= 19 ? systemOfId(num(f[18], 0)) : systemOf(talker);
    if (system.empty()) return;
    std::vector<int> prns;
    for (size_t i = 3; i < 15; i++)
      if (num(f[i], 0) > 0) prns.push_back(num(f[i], 0));
    used_[system] = prns;
    usedAt_[system] = nowMs;
    lastAt_ = nowMs;
  }
}

std::vector<Satellite> GnssSky::inView(int64_t nowMs, int64_t withinMs) const {
  std::vector<Satellite> out;
  for (auto& kv : sats_) {
    if (nowMs - kv.second.seenAt > withinMs) continue;
    Satellite s = kv.second;
    auto u = used_.find(s.system);
    auto at = usedAt_.find(s.system);
    s.used = u != used_.end() && at != usedAt_.end() && nowMs - at->second <= withinMs &&
             std::find(u->second.begin(), u->second.end(), s.prn) != u->second.end();
    out.push_back(s);
  }
  std::sort(out.begin(), out.end(), [](const Satellite& a, const Satellite& b) { return a.snr != b.snr ? a.snr > b.snr : a.prn < b.prn; });
  return out;
}

std::string describeGnss(const SelfGnss* self, const GnssSky* sky, int64_t nowMs) {
  std::string out;
  char buf[200];
  if (!self || !self->present) {
    out = "This home base has no GPS.";
  } else if (!self->hasFix) {
    out = "GPS: no fix yet. Indoors it can take a while, or not happen at all: a window or an outdoor antenna helps.";
  } else {
    snprintf(buf, sizeof buf, "GPS fix: %.6f, %.6f", self->lat, self->lng);
    out = buf;
    if (self->altitudeM != 0) {
      snprintf(buf, sizeof buf, ", %d m above sea level", (int)self->altitudeM);
      out += buf;
    }
    out += ".\n";
    snprintf(buf, sizeof buf, "%s fix from %d satellite%s", self->fixType == 2 ? "2D" : self->fixType == 3 ? "3D" : "A", self->satsUsed,
             self->satsUsed == 1 ? "" : "s");
    out += buf;
    if (self->hdop > 0) {
      snprintf(buf, sizeof buf, ", HDOP %.1f (%s)", self->hdop, self->hdop <= 1 ? "excellent" : self->hdop <= 2 ? "good" : self->hdop <= 5 ? "fair" : "poor");
      out += buf;
    }
    if (self->accuracyM > 0) {
      snprintf(buf, sizeof buf, ", about ±%d m", (int)(self->accuracyM + 0.5f));
      out += buf;
    }
    if (self->fixAtMs) out += ", " + ago(nowMs - self->fixAtMs);
    out += ".\n";
    snprintf(buf, sizeof buf, "Map: https://www.openstreetmap.org/?mlat=%.6f&mlon=%.6f#map=17/%.6f/%.6f", self->lat, self->lng, self->lat, self->lng);
    out += buf;
  }
  if (!self || !self->present) return out;

  std::vector<Satellite> sats = sky ? sky->inView(nowMs) : std::vector<Satellite>();
  if (sats.empty()) {
    out += "\n\nNo satellite details yet (the GPS may be asleep between fixes).";
    return out;
  }
  std::map<std::string, std::pair<int, int>> bySystem;  // system -> in view, heard
  int heard = 0, used = 0;
  for (auto& s : sats) {
    auto& c = bySystem[s.system];
    c.first++;
    if (s.snr > 0) c.second++, heard++;
    if (s.used) used++;
  }
  snprintf(buf, sizeof buf, "\n\nSatellites in view: %d, %d with a signal", (int)sats.size(), heard);
  out += buf;
  if (used) {
    snprintf(buf, sizeof buf, ", %d used", used);
    out += buf;
  }
  out += " (";
  bool first = true;
  for (auto& kv : bySystem) {
    snprintf(buf, sizeof buf, "%s%s %d", first ? "" : ", ", kv.first.c_str(), kv.second.first);
    out += buf;
    first = false;
  }
  out += "), as of " + ago(nowMs - sky->lastHeardAt()) + ".";
  int shown = 0;
  for (auto& s : sats) {
    if (s.snr <= 0 || shown >= 12) continue;
    if (!shown) out += "\nStrongest:";
    snprintf(buf, sizeof buf, "\n• %s %d: %d dB", s.system.c_str(), s.prn, s.snr);
    out += buf;
    if (s.elevation >= 0) {
      snprintf(buf, sizeof buf, ", %d° up", s.elevation);
      out += buf;
    }
    if (s.azimuth >= 0) {
      static const char* dirs[] = {"N", "NE", "E", "SE", "S", "SW", "W", "NW"};
      out += std::string(", ") + dirs[((s.azimuth + 22) % 360) / 45];
    }
    if (s.used) out += ", in the fix";
    shown++;
  }
  return out;
}

}  // namespace hc
