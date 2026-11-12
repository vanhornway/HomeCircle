// The setup page. A tracker with no circle opens its own Wi-Fi network,
// "HomeCircle Tracker XXXX", whose password is printed on the serial
// console when it is flashed (write it on the device). Join that network
// from a phone, and the page asks for the tracker's name, the invite link,
// Wi-Fi networks it may use and, on a cellular board, the SIM's APN.
//
// The page is served over the device's own WPA2 network, never the
// internet. The invite link is used once and then never stored.
#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_mac.h>
#include <sodium.h>

#include "platform.h"

namespace {

const uint32_t PORTAL_MS = 15 * 60 * 1000;

String deviceSuffix() {
  uint8_t mac[6];
  esp_efuse_mac_get_default(mac);
  char s[5];
  snprintf(s, sizeof s, "%02X%02X", mac[4], mac[5]);
  return s;
}

// A password only this chip has: from its MAC, so it is the same every time.
String apPassword() {
  uint8_t mac[6], h[32];
  esp_efuse_mac_get_default(mac);
  uint8_t in[16] = {'h', 'c', '-', 'a', 'p', '-', 'v', '1'};
  memcpy(in + 8, mac, 6);
  crypto_hash_sha256(h, in, 14);
  static const char* A = "23456789abcdefghjkmnpqrstuvwxyz";
  String p;
  for (int i = 0; i < 10; i++) p += A[h[i] % 31];
  return p;
}

String esc(const std::string& s) {
  String o;
  for (char c : s) {
    if (c == '<') o += "&lt;";
    else if (c == '>') o += "&gt;";
    else if (c == '&') o += "&amp;";
    else if (c == '"') o += "&quot;";
    else o += c;
  }
  return o;
}

const char* STYLE =
    "<meta name=viewport content='width=device-width,initial-scale=1'><style>"
    "body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:20px 16px;max-width:520px;color:#1c2321;background:#f6f7f5}"
    "h1{font-size:1.4rem;margin:0 0 4px}p{margin:0 0 16px;color:#5d6965}label{display:block;font-weight:600;margin:14px 0 4px}"
    "input,textarea{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #c9d1cd;border-radius:8px;background:#fff}"
    "button{margin-top:20px;width:100%;padding:12px;font:inherit;font-weight:600;color:#fff;background:#1f7a5c;border:0;border-radius:8px}"
    ".hint{font-weight:400;color:#5d6965;font-size:.9rem}.err{color:#a3341f}</style>";

enum class Job { None, Joining, Joined, Failed };
Job job = Job::None;
std::string jobError, pendingName, pendingInvite;

}  // namespace

void runSetupPortal(hc::Device& device, ClientHttp& http, hc::Store& store) {
  String ssid = "HomeCircle Tracker " + deviceSuffix();
  String pass = apPassword();
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(ssid.c_str(), pass.c_str());
  DNSServer dns;
  dns.start(53, "*", WiFi.softAPIP());
  WebServer web(80);
  NetConfig cfg;
  cfg.load(store);

  web.on("/", HTTP_GET, [&]() {
    String page = String("<!doctype html><title>HomeCircle Tracker</title>") + STYLE +
                  "<h1>Set up this tracker</h1><p>An admin of your circle makes an invite in the HomeCircle app "
                  "(Settings → Your circle → Invite) and pastes the link here.</p>"
                  "<form method=post action=/join>"
                  "<label for=n>Name in the circle</label><input id=n name=n maxlength=40 required placeholder='Car, Leo’s tracker…'>"
                  "<label for=i>Invite link</label><textarea id=i name=i rows=3 required></textarea>"
                  "<label for=s0>Wi-Fi network <span class=hint>(home)</span></label><input id=s0 name=s0 value=\"" + esc(cfg.ssid[0]) + "\">"
                  "<label for=p0>Password</label><input id=p0 name=p0 type=password>"
                  "<label for=s1>Second Wi-Fi network <span class=hint>(optional: school, a phone’s hotspot)</span></label><input id=s1 name=s1 value=\"" + esc(cfg.ssid[1]) + "\">"
                  "<label for=p1>Password</label><input id=p1 name=p1 type=password>";
    if (board::hasCellular()) page += "<label for=a>SIM APN <span class=hint>(from your SIM provider)</span></label><input id=a name=a value=\"" + esc(cfg.apn) + "\">";
    page += "<button>Join the circle</button></form>";
    web.send(200, "text/html; charset=utf-8", page);
  });

  web.on("/join", HTTP_POST, [&]() {
    NetConfig next = cfg;
    next.ssid[0] = web.arg("s0").c_str();
    next.ssid[1] = web.arg("s1").c_str();
    // Keep a saved password when the field is left empty for the same network.
    if (web.arg("p0").length() || next.ssid[0] != cfg.ssid[0]) next.pass[0] = web.arg("p0").c_str();
    if (web.arg("p1").length() || next.ssid[1] != cfg.ssid[1]) next.pass[1] = web.arg("p1").c_str();
    if (web.hasArg("a")) next.apn = web.arg("a").c_str();
    cfg = next;
    cfg.save(store);
    pendingName = web.arg("n").c_str();
    pendingInvite = web.arg("i").c_str();
    job = Job::Joining;
    web.sendHeader("Location", "/status");
    web.send(303);
  });

  web.on("/status", HTTP_GET, [&]() {
    String body;
    if (job == Job::Joining) body = "<meta http-equiv=refresh content=3><h1>Joining…</h1><p>Connecting to the internet and to your circle. This can take a minute on a cellular network.</p>";
    else if (job == Job::Joined) body = "<h1>Done</h1><p>This tracker is now in <b>" + esc(device.circleName()) + "</b> as <b>" + esc(device.name()) + "</b>. Its setup network turns off now; it sends its first location in a moment.</p>";
    else if (job == Job::Failed) body = "<h1 class=err>That didn’t work</h1><p>" + esc(jobError) + "</p><p><a href=/>Try again</a></p>";
    else body = "<meta http-equiv=refresh content=0;url=/>";
    web.send(200, "text/html; charset=utf-8", String("<!doctype html><title>HomeCircle Tracker</title>") + STYLE + body);
  });

  web.onNotFound([&]() {
    web.sendHeader("Location", "http://" + WiFi.softAPIP().toString() + "/");
    web.send(302);
  });
  web.begin();

  uint32_t start = millis(), lastPrint = 0, joinedAt = 0;
  while (millis() - start < PORTAL_MS) {
    if (millis() - lastPrint > 10000) {
      Serial.printf("Setup: join the Wi-Fi network \"%s\" (password %s) and open http://%s\n", ssid.c_str(), pass.c_str(), WiFi.softAPIP().toString().c_str());
      lastPrint = millis();
    }
    dns.processNextRequest();
    web.handleClient();
    if (job == Job::Joining) {
      bool online;
      if (board::hasCellular()) {
        online = board::netUp(cfg, 120000);
      } else {
        // Keep the setup network up while joining the home network.
        WiFi.begin(cfg.ssid[0].c_str(), cfg.pass[0].c_str());
        uint32_t t = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - t < 20000) {
          web.handleClient();
          delay(50);
        }
        online = WiFi.status() == WL_CONNECTED;
      }
      if (!online) {
        job = Job::Failed;
        jobError = board::hasCellular() ? "The tracker couldn’t reach the cellular network. Check the SIM, its APN and the antenna." : "The tracker couldn’t join that Wi-Fi network. Check its name and password.";
        continue;
      }
      http.use(board::client());
      board::netTime();
      hc::Status s = device.join(pendingInvite, pendingName);
      pendingInvite.clear();
      if (s == hc::Status::Ok) {
        job = Job::Joined;
        joinedAt = millis();
      } else {
        job = Job::Failed;
        jobError = device.error();
      }
    }
    if (job == Job::Joined && millis() - joinedAt > 20000) break;
    delay(5);
  }
  web.stop();
  dns.stop();
  WiFi.softAPdisconnect(true);
}
