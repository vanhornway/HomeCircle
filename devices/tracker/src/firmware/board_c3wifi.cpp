// Any ESP32-C3 board with a UART GPS module (ATGM336H, L76K, NEO-6M…), a
// LiPo cell and a button. Wi-Fi only: it reports from saved networks (home,
// school, a phone's hotspot) and keeps an SOS until it can send it.
//
// Wiring (change with build flags, README.md "Boards"):
//   GPS TX → GPIO 4, GPS RX ← GPIO 5, GPS power switch (P-MOSFET or the
//   module's EN pin) ← GPIO 6, SOS button GPIO 3 → GND (with a 100 kΩ
//   pull-up to 3.3 V), battery through a 1:2 divider → GPIO 2.
#ifdef HC_BOARD_C3_WIFI

#include <TinyGPSPlus.h>
#include <WiFi.h>

#include "platform.h"

#ifndef HC_GPS_RX
#define HC_GPS_RX 4
#endif
#ifndef HC_GPS_TX
#define HC_GPS_TX 5
#endif
#ifndef HC_GPS_EN
#define HC_GPS_EN 6  // -1 if the GPS is always powered
#endif
#ifndef HC_GPS_EN_ACTIVE
#define HC_GPS_EN_ACTIVE HIGH
#endif
#ifndef HC_SOS_PIN
#define HC_SOS_PIN 3  // must be GPIO 0–5 to wake the C3 from deep sleep
#endif
#ifndef HC_BATT_ADC
#define HC_BATT_ADC 2  // -1 if not wired
#endif

namespace {
TinyGPSPlus gps;
HardwareSerial gpsSerial(1);
WiFiClient wifi;

void gpsPower(bool on) {
  if (HC_GPS_EN < 0) return;
  pinMode(HC_GPS_EN, OUTPUT);
  digitalWrite(HC_GPS_EN, on ? HC_GPS_EN_ACTIVE : !HC_GPS_EN_ACTIVE);
}
}  // namespace

namespace board {

const char* name() { return "ESP32-C3 + GPS (Wi-Fi)"; }
bool hasCellular() { return false; }

void begin() { pinMode(HC_SOS_PIN, INPUT_PULLUP); }

bool gnssFix(hc::Fix& fix, uint32_t timeoutMs) {
  gpsPower(true);
  gpsSerial.begin(9600, SERIAL_8N1, HC_GPS_RX, HC_GPS_TX);
  uint32_t start = millis();
  bool got = false;
  while (millis() - start < timeoutMs && !got) {
    while (gpsSerial.available()) gps.encode(gpsSerial.read());
    if (gps.location.isValid() && gps.location.isUpdated() && gps.location.age() < 2000 && gps.satellites.value() >= 4) {
      fix.lat = gps.location.lat();
      fix.lng = gps.location.lng();
      fix.speed = gps.speed.isValid() ? (float)gps.speed.mps() : -1;
      fix.accuracy = gps.hdop.isValid() ? (float)gps.hdop.hdop() * 5.0f : -1;
      if (gps.date.isValid() && gps.time.isValid()) setClockUtc(gps.date.year(), gps.date.month(), gps.date.day(), gps.time.hour(), gps.time.minute(), gps.time.second());
      got = true;
    }
    delay(50);
  }
  gpsSerial.end();
  gpsPower(false);
  return got;
}

void readBattery(hc::Fix& fix) {
  if (HC_BATT_ADC < 0) return;
  uint32_t mv = analogReadMilliVolts(HC_BATT_ADC) * 2;
  if (mv < 2500) return;  // not wired
  // A LiPo cell: about 3.3 V empty to 4.2 V full, close enough to straight.
  int pct = (int)((mv - 3300) * 100 / 900);
  fix.battery = pct < 0 ? 0 : pct > 100 ? 100 : pct;
  fix.charging = mv > 4250;
}

bool netUp(const NetConfig& cfg, uint32_t timeoutMs) {
  WiFi.mode(WIFI_STA);
  for (int i = 0; i < 2; i++) {
    if (cfg.ssid[i].empty()) continue;
    WiFi.begin(cfg.ssid[i].c_str(), cfg.pass[i].c_str());
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs / 2) delay(100);
    if (WiFi.status() == WL_CONNECTED) return true;
    WiFi.disconnect();
  }
  return false;
}

void netTime() {
  if (clockValid()) return;
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  for (int i = 0; i < 50 && !clockValid(); i++) delay(100);
}

Client* client() { return &wifi; }

void powerDown() {
  gpsPower(false);
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
}

bool buttonDown() { return digitalRead(HC_SOS_PIN) == LOW; }

void armButtonWake() { esp_deep_sleep_enable_gpio_wakeup(1ULL << HC_SOS_PIN, ESP_GPIO_WAKEUP_GPIO_LOW); }

bool wokeByButton() { return esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_GPIO; }

}  // namespace board

#endif
