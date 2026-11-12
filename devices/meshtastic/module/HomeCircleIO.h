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

namespace hcio
{

// One file per key under /prefs/hc (a Meshtastic factory reset deletes /prefs).
class FsStore : public hc::Store
{
  public:
    bool get(const char *key, std::string &out) override
    {
        concurrency::LockGuard g(spiLock);
        File f = FSCom.open(path(key).c_str(), FILE_O_READ);
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
    bool put(const char *key, const std::string &value) override
    {
        concurrency::LockGuard g(spiLock);
        FSCom.mkdir("/prefs");
        FSCom.mkdir("/prefs/hc");
        File f = FSCom.open(path(key).c_str(), FILE_O_WRITE);
        if (!f)
            return false;
        bool ok = f.write((const uint8_t *)value.data(), value.size()) == value.size();
        f.close();
        return ok;
    }
    void remove(const char *key) override
    {
        concurrency::LockGuard g(spiLock);
        FSCom.remove(path(key).c_str());
    }

  private:
    static std::string path(const char *key) { return std::string("/prefs/hc/") + key; }
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
