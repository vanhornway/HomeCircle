// What the main cycle needs from the board and the chip: the clock, saved
// settings, the network, GNSS, the battery and the SOS button. One file per
// board implements `board::`; the rest is shared.
#pragma once
#include <Arduino.h>
#include <Client.h>
#include <hc_device.h>

#include <string>

// --- the clock (UTC) ----------------------------------------------------------
bool clockValid();
int64_t nowMs();
void setClockUtc(int year, int month, int day, int hour, int minute, int second);
/** From an HTTP Date header ("Wed, 11 Nov 2026 14:48:05 GMT"). */
void setClockFromHttpDate(const char* date);

// --- settings saved on the device (flash) -------------------------------------
class NvsStore : public hc::Store {
 public:
  bool get(const char* key, std::string& out) override;
  bool put(const char* key, const std::string& value) override;
  void remove(const char* key) override;
};

/** How the tracker reaches the internet, from the setup page. */
struct NetConfig {
  std::string ssid[2], pass[2];  // Wi-Fi networks it may use (home, school…)
  std::string apn;               // the SIM's APN, for cellular boards
  bool load(hc::Store& s);
  bool save(hc::Store& s) const;
};

// --- HTTPS over whatever Client the board provides ----------------------------
class ClientHttp : public hc::Http {
 public:
  void use(Client* plain) { plain_ = plain; }
  hc::HttpResponse request(const char* method, const std::string& url, const std::string& token, const std::string& body) override;
  void close();

 private:
  Client* plain_ = nullptr;
};

// --- the board ----------------------------------------------------------------
namespace board {
const char* name();
void begin();
/** A GNSS fix within `timeoutMs`; also sets the clock from satellite time. */
bool gnssFix(hc::Fix& fix, uint32_t timeoutMs);
void readBattery(hc::Fix& fix);
/** Connect to the internet. */
bool netUp(const NetConfig& cfg, uint32_t timeoutMs);
/** Set the clock from the network (cellular time or NTP), if it can. */
void netTime();
Client* client();
/** Everything off before deep sleep. */
void powerDown();
bool buttonDown();
/** Let the SOS button wake the chip from deep sleep. */
void armButtonWake();
bool wokeByButton();
/** Cellular boards keep their own Wi-Fi off; the setup page needs Wi-Fi either way. */
bool hasCellular();
}  // namespace board

/** The setup page: a Wi-Fi network named "HomeCircle Tracker …" with a form for the invite. */
void runSetupPortal(hc::Device& device, ClientHttp& http, hc::Store& store);
