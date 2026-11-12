// LilyGO T-SIM7080G-S3: ESP32-S3, a SIM7080G modem (LTE-M / NB-IoT with
// GNSS on the same chip) and an AXP2101 power chip that switches the
// modem's and the GNSS antenna's power off between wakes.
//
// Pins follow LilyGO's published pin map for this board; check them against
// your board's revision (README.md, "Boards").
#ifdef HC_BOARD_T_SIM7080G_S3

#include <TinyGsmClient.h>
#include <Wire.h>
#include <XPowersLib.h>

#include "platform.h"

#ifndef HC_I2C_SDA
#define HC_I2C_SDA 15
#endif
#ifndef HC_I2C_SCL
#define HC_I2C_SCL 7
#endif
#ifndef HC_MODEM_PWR
#define HC_MODEM_PWR 41
#endif
#ifndef HC_MODEM_RX
#define HC_MODEM_RX 4
#endif
#ifndef HC_MODEM_TX
#define HC_MODEM_TX 5
#endif
// The BOOT button; wire your own SOS button to another RTC pin and set this.
#ifndef HC_SOS_PIN
#define HC_SOS_PIN 0
#endif

namespace {
XPowersAXP2101 pmu;
bool pmuOk = false;
HardwareSerial& at = Serial1;
TinyGsm modem(at);
TinyGsmClient gsm(modem, 0);
bool modemOn = false;

bool startModem() {
  if (modemOn) return true;
  if (pmuOk) {
    pmu.setDC3Voltage(3000);  // the modem
    pmu.enableDC3();
    pmu.setBLDO2Voltage(3300);  // the GNSS antenna
    pmu.enableBLDO2();
  }
  at.begin(115200, SERIAL_8N1, HC_MODEM_RX, HC_MODEM_TX);
  for (int tries = 0; tries < 4; tries++) {
    if (modem.testAT(1500)) {
      modemOn = true;
      return true;
    }
    // Press the modem's power key.
    pinMode(HC_MODEM_PWR, OUTPUT);
    digitalWrite(HC_MODEM_PWR, LOW);
    delay(100);
    digitalWrite(HC_MODEM_PWR, HIGH);
    delay(1000);
    digitalWrite(HC_MODEM_PWR, LOW);
    delay(2000);
  }
  return false;
}
}  // namespace

namespace board {

const char* name() { return "T-SIM7080G-S3"; }
bool hasCellular() { return true; }

void begin() {
  pinMode(HC_SOS_PIN, INPUT_PULLUP);
  pmuOk = pmu.begin(Wire, AXP2101_SLAVE_ADDRESS, HC_I2C_SDA, HC_I2C_SCL);
  if (pmuOk) {
    pmu.disableTSPinMeasure();
    pmu.enableBattDetection();
    pmu.enableBattVoltageMeasure();
  }
}

bool gnssFix(hc::Fix& fix, uint32_t timeoutMs) {
  if (!startModem()) return false;
  // The SIM7080G can't use GNSS and LTE at once: radio off while it looks.
  modem.sendAT("+CFUN=0");
  modem.waitResponse(5000);
  modem.enableGPS();
  uint32_t start = millis();
  bool got = false;
  while (millis() - start < timeoutMs) {
    float lat, lon, speedKmh, alt, hdop;
    int vsat, usat, y, mo, d, h, mi, s;
    if (modem.getGPS(&lat, &lon, &speedKmh, &alt, &vsat, &usat, &hdop, &y, &mo, &d, &h, &mi, &s) && lat != 0 && lon != 0) {
      fix.lat = lat;
      fix.lng = lon;
      fix.speed = speedKmh >= 0 ? speedKmh / 3.6f : -1;
      fix.accuracy = hdop > 0 ? hdop * 5.0f : -1;  // rough: HDOP times a typical 5 m
      setClockUtc(y, mo, d, h, mi, (int)s);
      got = true;
      break;
    }
    delay(2000);
  }
  modem.disableGPS();
  return got;
}

void readBattery(hc::Fix& fix) {
  if (!pmuOk || !pmu.isBatteryConnect()) return;
  fix.battery = pmu.getBatteryPercent();
  fix.charging = pmu.isCharging();
}

bool netUp(const NetConfig& cfg, uint32_t timeoutMs) {
  if (!startModem()) return false;
  modem.sendAT("+CFUN=1");
  modem.waitResponse(10000);
  modem.setNetworkMode(38);   // LTE only
  modem.setPreferredMode(3);  // LTE-M and NB-IoT
  if (!modem.waitForNetwork(timeoutMs)) return false;
  return modem.gprsConnect(cfg.apn.c_str()) && modem.isGprsConnected();
}

void netTime() {
  if (clockValid()) return;
  int y, mo, d, h, mi, s;
  float tz;
  if (modem.getNetworkTime(&y, &mo, &d, &h, &mi, &s, &tz)) {
    // The modem gives local time and its offset; the clock is kept in UTC.
    int64_t offsetSec = (int64_t)(tz * 3600);
    setClockUtc(y, mo, d, h, mi, s);
    struct timeval tv = {time(nullptr) - (time_t)offsetSec, 0};
    settimeofday(&tv, nullptr);
  }
}

Client* client() { return &gsm; }

void powerDown() {
  if (modemOn) {
    modem.gprsDisconnect();
    modem.poweroff();
    modemOn = false;
  }
  if (pmuOk) {
    pmu.disableDC3();
    pmu.disableBLDO2();
  }
}

bool buttonDown() { return digitalRead(HC_SOS_PIN) == LOW; }

void armButtonWake() { esp_sleep_enable_ext0_wakeup((gpio_num_t)HC_SOS_PIN, 0); }

bool wokeByButton() { return esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0; }

}  // namespace board

#endif
