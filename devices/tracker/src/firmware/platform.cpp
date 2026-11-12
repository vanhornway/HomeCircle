// The clock, saved settings and HTTPS: the same on every board.
#include "platform.h"

#include <ArduinoHttpClient.h>
#include <ESP_SSLClient.h>
#include <Preferences.h>
#include <sys/time.h>

#include <memory>

#include "roots.h"

// --- clock ----------------------------------------------------------------------

static const time_t CLOCK_FLOOR = 1767225600;  // 2026-01-01: anything earlier means "not set"

bool clockValid() { return time(nullptr) > CLOCK_FLOOR; }

int64_t nowMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm), so no time zone is involved.
static int64_t daysFromCivil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int64_t)doe - 719468;
}

void setClockUtc(int year, int month, int day, int hour, int minute, int second) {
  if (year < 2026 || month < 1 || month > 12 || day < 1 || day > 31) return;
  struct timeval tv = {(time_t)(daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second), 0};
  settimeofday(&tv, nullptr);
}

void setClockFromHttpDate(const char* date) {
  static const char* MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
  char mon[4] = {0};
  int d, y, h, mi, s;
  if (sscanf(date, "%*3s, %d %3s %d %d:%d:%d", &d, mon, &y, &h, &mi, &s) != 6) return;
  const char* at = strstr(MONTHS, mon);
  if (at) setClockUtc(y, (int)(at - MONTHS) / 3 + 1, d, h, mi, s);
}

// --- settings in flash ------------------------------------------------------------

bool NvsStore::get(const char* key, std::string& out) {
  Preferences p;
  if (!p.begin("hc", true)) return false;
  size_t n = p.getBytesLength(key);
  bool ok = n > 0;
  if (ok) {
    out.resize(n);
    ok = p.getBytes(key, &out[0], n) == n;
  }
  p.end();
  return ok;
}

bool NvsStore::put(const char* key, const std::string& value) {
  Preferences p;
  if (!p.begin("hc", false)) return false;
  bool ok = p.putBytes(key, value.data(), value.size()) == value.size();
  p.end();
  return ok;
}

void NvsStore::remove(const char* key) {
  Preferences p;
  if (!p.begin("hc", false)) return;
  p.remove(key);
  p.end();
}

bool NetConfig::load(hc::Store& s) {
  std::string raw;
  JsonDocument d;
  if (!s.get("net", raw) || deserializeJson(d, raw)) return false;
  for (int i = 0; i < 2; i++) {
    ssid[i] = d["ssid"][i] | "";
    pass[i] = d["pass"][i] | "";
  }
  apn = d["apn"] | "";
  return true;
}

bool NetConfig::save(hc::Store& s) const {
  JsonDocument d;
  for (int i = 0; i < 2; i++) {
    d["ssid"][i] = ssid[i];
    d["pass"][i] = pass[i];
  }
  d["apn"] = apn;
  std::string raw;
  serializeJson(d, raw);
  return s.put("net", raw);
}

// --- HTTPS --------------------------------------------------------------------------
// One connection per wake, kept open between requests to the same server:
// each TLS handshake costs seconds of radio time on LTE-M.

namespace {
struct Conn {
  std::string host;
  uint16_t port = 0;
  bool tls = false;
  ESP_SSLClient ssl;
  std::unique_ptr<HttpClient> http;
};
Conn conn;

bool splitUrl(const std::string& url, bool& tls, std::string& host, uint16_t& port, std::string& path) {
  size_t p = url.find("://");
  if (p == std::string::npos) return false;
  std::string scheme = url.substr(0, p);
  tls = scheme == "https";
  if (!tls && scheme != "http") return false;
  size_t slash = url.find('/', p + 3);
  std::string hostport = url.substr(p + 3, slash == std::string::npos ? std::string::npos : slash - p - 3);
  path = slash == std::string::npos ? "/" : url.substr(slash);
  size_t colon = hostport.rfind(':');
  if (colon != std::string::npos) {
    host = hostport.substr(0, colon);
    port = (uint16_t)atoi(hostport.c_str() + colon + 1);
  } else {
    host = hostport;
    port = tls ? 443 : 80;
  }
  return !host.empty();
}
}  // namespace

void ClientHttp::close() {
  if (conn.http) conn.http->stop();
  conn.http.reset();
  conn.host.clear();
}

hc::HttpResponse ClientHttp::request(const char* method, const std::string& url, const std::string& token, const std::string& body) {
  hc::HttpResponse res;
  bool tls;
  std::string host, path;
  uint16_t port;
  if (!plain_ || !splitUrl(url, tls, host, port, path)) return res;

  for (int attempt = 0; attempt < 2; attempt++) {
    if (!conn.http || conn.host != host || conn.port != port || conn.tls != tls) {
      close();
      conn.host = host;
      conn.port = port;
      conn.tls = tls;
      Client* c = plain_;
      if (tls) {
        conn.ssl.setClient(plain_);
        conn.ssl.setCACert(HC_ROOT_CAS);
        conn.ssl.setBufferSizes(4096, 1024);
        c = &conn.ssl;
      }
      conn.http.reset(new HttpClient(*c, conn.host.c_str(), port));
      conn.http->connectionKeepAlive();
      conn.http->setHttpResponseTimeout(20000);
    }
    HttpClient& h = *conn.http;
    h.beginRequest();
    int err = h.startRequest(path.c_str(), method);
    if (err != HTTP_SUCCESS) {
      close();
      continue;  // the kept connection had closed: open a new one once
    }
    h.sendHeader("User-Agent", "homecircle-tracker");
    if (!token.empty()) h.sendHeader("Authorization", ("Bearer " + token).c_str());
    if (!body.empty() || strcmp(method, "GET") != 0) {
      h.sendHeader("Content-Type", "application/json");
      h.sendHeader("Content-Length", (int)body.size());
      h.beginBody();
      h.write((const uint8_t*)body.data(), body.size());
    }
    h.endRequest();
    int status = h.responseStatusCode();
    if (status < 0) {
      close();
      if (attempt == 0) continue;
      return res;
    }
    while (h.headerAvailable()) {
      String name = h.readHeaderName();
      String value = h.readHeaderValue();
      if (!clockValid() && name.equalsIgnoreCase("Date")) setClockFromHttpDate(value.c_str());
    }
    String b = h.responseBody();
    res.status = status;
    res.body = std::string(b.c_str(), b.length());
    return res;
  }
  return res;
}
