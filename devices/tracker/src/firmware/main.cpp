// HomeCircle Tracker firmware. Each wake is one short run, then deep sleep:
//
//   1. take a GNSS fix (radio off while it looks, on the SIM7080G)
//   2. connect (LTE-M or Wi-Fi), set the clock if it isn't
//   3. send a waiting SOS, now and then read the admin's settings
//   4. send the location
//   5. everything off; sleep until the next report or the SOS button
//
// It sleeps for the admin's "moving" minutes after a report where it moved,
// and their "still" minutes otherwise; every minute during an SOS.
//
// The button: hold 2 s for an SOS, hold 5 s during one to say you're safe,
// a short press sends a location now. Held for 10 s while powering on, the
// tracker forgets its circle and opens the setup page again.
#include <math.h>

#include "platform.h"

namespace {

// Kept in RTC memory across deep sleep (lost when the power is cut).
RTC_DATA_ATTR uint32_t wakes = 0;
RTC_DATA_ATTR uint32_t settingsAt = 0;
RTC_DATA_ATTR bool haveLast = false;
RTC_DATA_ATTR double lastLat = 0, lastLng = 0;
RTC_DATA_ATTR int movingMin = 2, stillMin = 60;
RTC_DATA_ATTR bool sosEnabled = true;

const uint32_t SETTINGS_EVERY = 6;  // wakes between reading the admin's settings
const uint32_t SOS_SECONDS = 60;
const uint32_t OFFLINE_RETRY_SECONDS = 15 * 60;
const uint32_t MOVED_METRES = 150;

NvsStore store;
ClientHttp http;
hc::Device device(http, store, nowMs);

[[noreturn]] void sleepFor(uint32_t seconds) {
  http.close();
  board::powerDown();
  board::armButtonWake();
  if (seconds) esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
  Serial.printf("Sleeping %u s\n", (unsigned)seconds);
  Serial.flush();
  esp_deep_sleep_start();
  for (;;) {
  }
}

uint32_t heldMs(uint32_t limit) {
  uint32_t t = millis();
  while (board::buttonDown() && millis() - t < limit) delay(20);
  return millis() - t;
}

double metres(double lat1, double lng1, double lat2, double lng2) {
  const double r = 6371000.0, rad = M_PI / 180.0;
  double dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  double a = sin(dLat / 2) * sin(dLat / 2) + cos(lat1 * rad) * cos(lat2 * rad) * sin(dLng / 2) * sin(dLng / 2);
  return 2 * r * atan2(sqrt(a), sqrt(1 - a));
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(50);
  board::begin();
  Serial.printf("HomeCircle Tracker on %s, wake %u\n", board::name(), (unsigned)wakes);
  if (!hc::cryptoInit()) sleepFor(3600);

  bool powerOn = esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_UNDEFINED;
  bool button = board::wokeByButton();
  uint32_t held = (powerOn || button) && board::buttonDown() ? heldMs(10000) : 0;

  if (powerOn && held >= 10000) {
    Serial.println("Forgetting the circle; back to setup");
    device.forget();
    haveLast = false;
    settingsAt = 0;
  }
  if (!device.load()) {
    runSetupPortal(device, http, store);
    // Joined: start reporting in a few seconds. Not joined: wait for the button.
    sleepFor(device.load() ? 5 : 0);
  }

  wakes++;
  bool sosStart = button && !device.sosActive() && sosEnabled && held >= 2000;
  bool sosEnd = button && device.sosActive() && held >= 5000;
  bool manual = button && held < 2000;
  bool sos = sosStart || device.sosActive();

  hc::Fix fix;
  bool haveFix = board::gnssFix(fix, sos ? 45000 : haveLast ? 60000 : 120000);
  board::readBattery(fix);
  bool moved = haveFix && (!haveLast || metres(lastLat, lastLng, fix.lat, fix.lng) > MOVED_METRES || fix.speed > 2.0f);
  Serial.printf("Fix: %s %.6f,%.6f battery %d%%\n", haveFix ? "yes" : "no", fix.lat, fix.lng, fix.battery);

  NetConfig cfg;
  cfg.load(store);
  if (!board::netUp(cfg, 90000)) {
    Serial.println("No connection");
    // An SOS waits in flash and goes out on the next wake that connects.
    if (sosStart) device.sos(true);
    sleepFor(sos ? SOS_SECONDS : OFFLINE_RETRY_SECONDS);
  }
  http.use(board::client());
  board::netTime();
  if (!clockValid()) device.refresh();  // the server's Date header sets the clock

  hc::Status st = hc::Status::Ok;
  if (sosStart) st = device.sos(true);
  else if (sosEnd) st = device.sos(false);
  else st = device.flushSos();
  if (st != hc::Status::Ok) Serial.printf("SOS: %s (%s)\n", hc::statusName(st), device.error().c_str());

  if (settingsAt == 0 || wakes - settingsAt >= SETTINGS_EVERY) {
    hc::TrackerSettings t;
    if (device.fetchSettings(t) == hc::Status::Ok) {
      movingMin = t.moving;
      stillMin = t.still;
      sosEnabled = t.sos;
      settingsAt = wakes;
    }
  }

  if (haveFix) {
    const char* trigger = device.sosActive() ? "sos" : manual ? "manual" : "update";
    st = device.shareLocation(fix, trigger, movingMin, stillMin);
    Serial.printf("Location: %s %s\n", hc::statusName(st), st == hc::Status::Ok ? "" : device.error().c_str());
    if (st == hc::Status::Removed) {
      // Removed from the circle: forget it and wait for setup.
      device.forget();
      sleepFor(0);
    }
    lastLat = fix.lat;
    lastLng = fix.lng;
    haveLast = true;
  }

  sleepFor(device.sosActive() ? SOS_SECONDS : (uint32_t)(moved ? movingMin : stillMin) * 60);
}

void loop() {}
