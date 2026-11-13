// SPDX-License-Identifier: GPL-3.0-only
// What both HomeCircle modules need from the node: storage in its flash,
// HTTPS over its Wi-Fi, and the time. Header-only; included by
// HomeCircleModule.cpp (a tracker) and HomeBaseModule.cpp (a home base).
#pragma once
#include "configuration.h"
#if defined(HOMECIRCLE) || defined(HOMECIRCLE_HOMEBASE)
#include "FSCommon.h"
#include "RTC.h"
#include "SPILock.h"
#include "homecircle/hc_device.h"
#include "homecircle/roots.h"
#if HAS_WIFI
#include "mesh/wifi/WiFiAPClient.h"
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#endif
#ifdef ARCH_ESP32
#include "esp_task_wdt.h"
#endif

namespace hcio
{

// Meshtastic restarts the node if its loop is stuck for 90 s. A few HTTPS
// calls in a row (a server waking up, a slow network) can take that long, so
// anything that waits on the network calls this between steps.
inline void feedWatchdog()
{
#ifdef ARCH_ESP32
    esp_task_wdt_reset();
#endif
}

// One file per key under /prefs/hc (a Meshtastic factory reset deletes /prefs).
// The circle account and the trackers' accounts. A write never leaves a file
// half written: it goes to KEY.new first, the old file becomes KEY.bak, then
// KEY.new is renamed into place. A restart at any point leaves at least one
// whole copy, and reading falls back to KEY.new, then KEY.bak. (A plain write
// truncates first: a restart in between once left the home base's account
// empty, and it had to join its circle again.)
class FsStore : public hc::Store
{
  public:
    bool get(const char *key, std::string &out) override
    {
        concurrency::LockGuard g(spiLock);
        std::string p = path(key);
        return readAll(p, out) || readAll(p + ".new", out) || readAll(p + ".bak", out);
    }
    bool put(const char *key, const std::string &value) override
    {
        concurrency::LockGuard g(spiLock);
        FSCom.mkdir("/prefs");
        FSCom.mkdir("/prefs/hc");
        std::string p = path(key), fresh = p + ".new", old = p + ".bak";
        File f = FSCom.open(fresh.c_str(), FILE_O_WRITE);
        if (!f)
            return false;
        bool ok = f.write((const uint8_t *)value.data(), value.size()) == value.size();
        f.close();
        if (!ok) {
            FSCom.remove(fresh.c_str());
            return false;
        }
        std::string current;
        if (readAll(p, current)) {
            FSCom.remove(old.c_str());
            FSCom.rename(p.c_str(), old.c_str());
        } else {
            FSCom.remove(p.c_str()); // an empty one: nothing to keep
        }
        return FSCom.rename(fresh.c_str(), p.c_str());
    }
    void remove(const char *key) override
    {
        concurrency::LockGuard g(spiLock);
        std::string p = path(key);
        FSCom.remove(p.c_str());
        FSCom.remove((p + ".new").c_str());
        FSCom.remove((p + ".bak").c_str());
    }

  private:
    static std::string path(const char *key) { return std::string("/prefs/hc/") + key; }
    static bool readAll(const std::string &p, std::string &out)
    {
        File f = FSCom.open(p.c_str(), FILE_O_READ);
        if (!f)
            return false;
        out.clear();
        while (f.available()) {
            char buf[256];
            int n = f.read((uint8_t *)buf, sizeof buf);
            if (n <= 0)
                break;
            out.append(buf, n);
        }
        f.close();
        return !out.empty();
    }
};

#if HAS_WIFI
inline bool online()
{
    return isWifiAvailable() && WiFi.status() == WL_CONNECTED;
}

// HTTPS over the node's Wi-Fi, checked against HomeCircle's list of roots.
class WifiHttp : public hc::Http
{
  public:
    hc::HttpResponse request(const char *method, const std::string &url, const std::string &token, const std::string &body) override
    {
        hc::HttpResponse res;
        if (WiFi.status() != WL_CONNECTED)
            return res;
        feedWatchdog();
        struct Fed {
            ~Fed() { feedWatchdog(); }
        } fed;
        WiFiClientSecure tls;
        WiFiClient plain;
        bool https = url.rfind("https://", 0) == 0;
        if (https)
            tls.setCACert(HC_ROOT_CAS);
        HTTPClient h;
        if (!(https ? h.begin(tls, url.c_str()) : h.begin(plain, url.c_str())))
            return res;
        h.setTimeout(15000);
        h.addHeader("User-Agent", "homecircle-meshtastic");
        if (!token.empty())
            h.addHeader("Authorization", String("Bearer ") + token.c_str());
        if (!body.empty())
            h.addHeader("Content-Type", "application/json");
        int code = h.sendRequest(method, (uint8_t *)body.data(), body.size());
        if (code > 0) {
            res.status = code;
            String b = h.getString();
            res.body.assign(b.c_str(), b.length());
        }
        h.end();
        return res;
    }
};
#else
inline bool online()
{
    return false;
}
class WifiHttp : public hc::Http
{
  public:
    hc::HttpResponse request(const char *, const std::string &, const std::string &, const std::string &) override { return {}; }
};
#endif

inline int64_t nowMs()
{
    return (int64_t)getTime() * 1000;
}

} // namespace hcio
#endif
