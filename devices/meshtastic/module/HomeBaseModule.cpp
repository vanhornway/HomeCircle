// SPDX-License-Identifier: GPL-3.0-only
// HomeCircle home base for Meshtastic. The home base's logic (trackers,
// admins' commands, quiet phones, SOS) is hc::HomeBase in the tracker
// library, copied in by build.sh; this file connects it to the node:
//
// - a setup page on the node's own Wi-Fi the first time: home Wi-Fi, the
//   invite link (which also names the server) and the LoRa region;
// - the private HomeCircle channel, and the link that puts trackers on it,
//   on this node's frequency so other people's nodes still relay;
// - trackers' positions and battery from the node database, their texts,
//   and position requests over the mesh.
#include "HomeBaseModule.h"
#ifdef HOMECIRCLE_HOMEBASE

// Meshtastic's headers first: ArduinoJson (in the HomeCircle headers) brings
// its own Allocator into the global namespace, which clashes with Meshtastic's.
#include "Channels.h"
#include "MeshRadio.h"
#include "MeshService.h"
#include "NodeDB.h"
#include "PowerStatus.h"
#include "airtime.h"
#include "main.h"
#include "mesh/generated/meshtastic/apponly.pb.h"
#include "mesh/mesh-pb-constants.h"
#if !MESHTASTIC_EXCLUDE_GPS
#include "gps/GPS.h"
#endif
// clang-format off
#include "HomeCircleIO.h"
#include "homecircle/hc_homebase.h"
// clang-format on
#include <Arduino.h>
#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_mac.h>
#include <map>
#include <math.h>
#include <sodium.h>

extern uint32_t hash(const char *str); // RadioInterface.cpp: how Meshtastic picks a frequency slot from a name

HomeBaseModule *homeBaseModule;

// Meshtastic runs everything, this module included, in Arduino's loop task,
// which gets 8 KB of stack by default. An HTTPS handshake (mbedTLS) inside a
// home base command doesn't fit in that: it overflowed while adding a tracker.
SET_LOOP_TASK_STACK_SIZE(24 * 1024);

namespace
{

const char *CHANNEL = "HomeCircle";
const uint32_t PORTAL_MS = 30 * 60 * 1000;

struct MeshRadio : hc::Radio {
    void requestPosition(uint32_t node) override
    {
        if (homeBaseModule)
            homeBaseModule->askPosition(node);
    }
    void nodes(std::vector<hc::HeardNode> &out) override
    {
        uint32_t now = getTime();
        for (size_t i = 0; i < nodeDB->getNumMeshNodes(); i++) {
            meshtastic_NodeInfoLite *n = nodeDB->getMeshNodeByIndex(i);
            if (!n || n->num == nodeDB->getNodeNum() || !n->last_heard || now - n->last_heard > 2 * 3600)
                continue;
            hc::HeardNode h;
            h.num = n->num;
            if (n->has_user)
                h.name = n->user.long_name;
            h.heardAtMs = (int64_t)n->last_heard * 1000;
            h.snr = n->snr;
            if (n->has_device_metrics) {
                if (n->device_metrics.has_battery_level)
                    h.battery = (int)n->device_metrics.battery_level;
                if (n->device_metrics.has_voltage && n->device_metrics.voltage > 0)
                    h.volts = n->device_metrics.voltage;
            }
            out.push_back(h);
        }
    }
    bool selfInfo(hc::SelfInfo &out) override
    {
        if (powerStatus) {
            if (powerStatus->getHasBattery()) {
                out.battery = powerStatus->getBatteryChargePercent();
                if (powerStatus->getBatteryVoltageMv() > 0)
                    out.volts = powerStatus->getBatteryVoltageMv() / 1000.0f;
            }
            out.plugged = powerStatus->getHasUSB() || !powerStatus->getHasBattery();
        }
        if (WiFi.status() == WL_CONNECTED)
            out.wifiRssi = WiFi.RSSI();
        out.uptimeS = millis() / 1000;
        out.heapKb = (int)(ESP.getFreeHeap() / 1024);
        if (airTime) {
            out.chUtil = airTime->channelUtilizationPercent();
            out.airTx = airTime->utilizationTXPercent();
        }
        return true;
    }
    std::string channelLink() override { return homeBaseModule ? homeBaseModule->channelLink() : ""; }
    void alert(uint32_t node, const std::string &text) override
    {
        if (homeBaseModule)
            homeBaseModule->textNode(node, text);
    }
    void traceroute(uint32_t node) override
    {
        if (homeBaseModule)
            homeBaseModule->traceNode(node);
    }
    std::string nodeName(uint32_t num) override
    {
        meshtastic_NodeInfoLite *n = nodeDB->getMeshNode(num);
        return n && n->has_user ? n->user.long_name : "";
    }
    int hopsAway(uint32_t node) override
    {
        meshtastic_NodeInfoLite *n = nodeDB->getMeshNode(node);
        return n && n->has_hops_away ? n->hops_away : -1;
    }

    // This node's own GPS (the Heltec V4 takes a GNSS module), from Meshtastic's latest local position.
    hc::GnssSky skyView;
    bool selfGnss(hc::SelfGnss &out) override
    {
#if !MESHTASTIC_EXCLUDE_GPS
        out.present = gps != nullptr || config.position.fixed_position;
#else
        out.present = config.position.fixed_position;
#endif
        const meshtastic_Position &p = localPosition;
        out.hasFix = p.latitude_i || p.longitude_i;
        if (!out.present || !out.hasFix)
            return out.present;
        out.lat = p.latitude_i * 1e-7;
        out.lng = p.longitude_i * 1e-7;
        out.altitudeM = (float)p.altitude;
        out.fixAtMs = (int64_t)(p.time ? p.time : p.timestamp) * 1000;
        out.fixType = (int)p.fix_type;
        out.satsUsed = (int)p.sats_in_view;
        out.hdop = p.HDOP ? p.HDOP / 100.0f : (p.PDOP ? p.PDOP / 100.0f : -1);
        if (p.gps_accuracy && out.hdop > 0)
            out.accuracyM = p.gps_accuracy * out.hdop / 1000.0f;
        return true;
    }
    const hc::GnssSky *sky() override { return &skyView; }
};

hcio::FsStore store;
hcio::WifiHttp http;
MeshRadio radio;
hc::HomeBase hb(http, store, hcio::nowMs, radio);

bool started = false;
bool configured = false; // in a circle, with home Wi-Fi: doing its job
bool needInvite = true;  // the setup page asks for an invite (not yet in a circle), or only for Wi-Fi
uint32_t lastTick = 0, lastPoll = 0;
std::map<uint32_t, uint32_t> seenFix; // node -> the position time last passed on

// --- the setup page ---
DNSServer *dns = nullptr;
WebServer *web = nullptr;
uint32_t portalStarted = 0;
enum class Job { None, Joining, Joined, Failed };
Job job = Job::None;
std::string jobError, wifiSsid, wifiPass, invite;
int region = 0;
uint32_t joinedAt = 0;
String apSsid, apPass;

String deviceSuffix()
{
    uint8_t mac[6];
    esp_efuse_mac_get_default(mac);
    char s[5];
    snprintf(s, sizeof s, "%02X%02X", mac[4], mac[5]);
    return s;
}

// The setup network's password: from the chip, so it's the same every time. Shown on the screen.
String apPassword()
{
    uint8_t mac[6], h[32];
    esp_efuse_mac_get_default(mac);
    uint8_t in[14] = {'h', 'c', '-', 'h', 'b', '-', 'v', '1'};
    memcpy(in + 8, mac, 6);
    crypto_hash_sha256(h, in, sizeof in);
    static const char *A = "23456789abcdefghjkmnpqrstuvwxyz";
    String p;
    for (int i = 0; i < 10; i++)
        p += A[h[i] % 31];
    return p;
}

String esc(const std::string &s)
{
    String o;
    for (char c : s) {
        if (c == '<')
            o += "&lt;";
        else if (c == '>')
            o += "&gt;";
        else if (c == '&')
            o += "&amp;";
        else if (c == '"')
            o += "&quot;";
        else
            o += c;
    }
    return o;
}

const char *STYLE = "<meta name=viewport content='width=device-width,initial-scale=1'><style>"
                    "body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:20px 16px;max-width:560px;color:#1c2321;background:#f6f7f5}"
                    "h1{font-size:1.4rem;margin:0 0 4px}p,ol{color:#3d4945}label{display:block;font-weight:600;margin:14px 0 4px}"
                    "input,textarea,select{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #c9d1cd;border-radius:8px;background:#fff}"
                    "button{margin-top:20px;width:100%;padding:12px;font:inherit;font-weight:600;color:#fff;background:#1f7a5c;border:0;border-radius:8px}"
                    ".hint{font-weight:400;color:#5d6965;font-size:.9rem}.err{color:#a3341f}code{word-break:break-all;background:#e2f1eb;padding:2px 4px;border-radius:4px}</style>";

struct RegionChoice {
    int code;
    const char *name;
};
const RegionChoice REGIONS[] = {{1, "United States (US 915)"},
                                {3, "Europe (EU 868)"},
                                {2, "Europe (EU 433)"},
                                {6, "Australia / NZ (ANZ 915)"},
                                {11, "New Zealand (NZ 865)"},
                                {10, "India (IN 865)"},
                                {5, "Japan (JP 920)"},
                                {7, "Korea (KR 920)"},
                                {8, "Taiwan (TW 923)"},
                                {4, "China (CN 470)"},
                                {9, "Russia (RU 868)"},
                                {12, "Thailand (TH 920)"},
                                {18, "Singapore (SG 923)"},
                                {17, "Malaysia (MY 919)"},
                                {21, "Philippines (PH 915)"},
                                {26, "Brazil (BR 902)"},
                                {15, "Ukraine (UA 868)"},
                                {24, "Kazakhstan (KZ 863)"},
                                {25, "Nepal (NP 865)"}};

} // namespace

// Each character from the GPS module, handed over by the hook register.py
// adds to GPS.cpp: the satellites in view, which Meshtastic doesn't keep.
void hcGpsChar(char c)
{
    radio.skyView.feed(c, hcio::nowMs());
}

HomeBaseModule::HomeBaseModule()
    : SinglePortModule("homebase", meshtastic_PortNum_TEXT_MESSAGE_APP), concurrency::OSThread("HomeBase")
{
    isPromiscuous = true; // trackers' texts and HomeCircle packets come as broadcasts
    homeBaseModule = this;
    setIntervalFromNow(5000);
}

// --- the private channel ---------------------------------------------------------

int HomeBaseModule::channelIndex()
{
    for (int i = 0; i < MAX_NUM_CHANNELS; i++) {
        meshtastic_Channel &c = channels.getByIndex(i);
        if (c.role != meshtastic_Channel_Role_DISABLED && strcmp(c.settings.name, CHANNEL) == 0)
            return i;
    }
    return -1;
}

// A secondary channel named HomeCircle with a random key. This node's own
// primary channel stays as it was, so it keeps its frequency and the public mesh.
int HomeBaseModule::ensureChannel()
{
    int idx = channelIndex();
    if (idx >= 0)
        return idx;
    for (int i = 1; i < MAX_NUM_CHANNELS; i++) {
        meshtastic_Channel ch = channels.getByIndex(i);
        if (ch.role != meshtastic_Channel_Role_DISABLED)
            continue;
        ch.index = i;
        ch.role = meshtastic_Channel_Role_SECONDARY;
        ch.has_settings = true;
        memset(&ch.settings, 0, sizeof ch.settings);
        strncpy(ch.settings.name, CHANNEL, sizeof ch.settings.name - 1);
        ch.settings.psk.size = 32;
        randombytes_buf(ch.settings.psk.bytes, 32);
        ch.settings.has_module_settings = true;
        ch.settings.module_settings.position_precision = 32; // full precision: it's private
        channels.setChannel(ch);
        channels.onConfigChanged();
        return i;
    }
    return -1;
}

// For a tracker: our channel as its primary (positions go out on the primary),
// with a LoRa setting that keeps it on this node's frequency slot. Without the
// slot, a primary channel named HomeCircle would hash to another frequency
// and other people's nodes couldn't relay for it.
std::string HomeBaseModule::channelLink()
{
    int idx = channelIndex();
    if (idx < 0 || !myRegion)
        return "";
    meshtastic_ChannelSet cs = meshtastic_ChannelSet_init_zero;
    cs.settings_count = 1;
    cs.settings[0] = channels.getByIndex(idx).settings;
    cs.has_lora_config = true;
    cs.lora_config = config.lora;
    float bw;
    uint8_t sf, cr;
    modemPresetToParams(config.lora.modem_preset, myRegion->wideLora, bw, sf, cr);
    uint32_t n = (uint32_t)floor((myRegion->freqEnd - myRegion->freqStart) / (myRegion->spacing + (bw / 1000)));
    if (n) {
        uint32_t slot = config.lora.channel_num ? config.lora.channel_num - 1 : hash(channels.getName(channels.getPrimaryIndex())) % n;
        cs.lora_config.channel_num = slot + 1;
    }
    uint8_t buf[320];
    size_t len = pb_encode_to_bytes(buf, sizeof buf, &meshtastic_ChannelSet_msg, &cs);
    return "https://meshtastic.org/e/#" + hc::toB64(buf, len);
}

// --- the radio -----------------------------------------------------------------------

void HomeBaseModule::askPosition(uint32_t node)
{
    meshtastic_MeshPacket *p = allocDataPacket();
    p->decoded.portnum = meshtastic_PortNum_POSITION_APP;
    p->to = node;
    meshtastic_NodeInfoLite *n = nodeDB->getMeshNode(node);
    int idx = channelIndex();
    p->channel = n && n->channel ? n->channel : (idx >= 0 ? idx : channels.getPrimaryIndex());
    p->decoded.want_response = true; // its position module answers with where it is
    p->decoded.payload.size = 0;
    p->want_ack = false;
    p->priority = meshtastic_MeshPacket_Priority_RELIABLE;
    service->sendToMesh(p);
    LOG_INFO("HomeCircle home base: asked %08x for a position", (unsigned)node);
}

// A direct text to a node. One starting with the bell character makes a
// tracker beep when its External Notification is set to sound for alert bells.
void HomeBaseModule::textNode(uint32_t node, const std::string &text)
{
    meshtastic_MeshPacket *p = allocDataPacket();
    p->decoded.portnum = meshtastic_PortNum_TEXT_MESSAGE_APP;
    p->to = node;
    meshtastic_NodeInfoLite *n = nodeDB->getMeshNode(node);
    int idx = channelIndex();
    p->channel = n && n->channel ? n->channel : (idx >= 0 ? idx : channels.getPrimaryIndex());
    size_t len = std::min(text.size(), sizeof(p->decoded.payload.bytes));
    memcpy(p->decoded.payload.bytes, text.data(), len);
    p->decoded.payload.size = len;
    p->want_ack = true;
    p->priority = meshtastic_MeshPacket_Priority_RELIABLE;
    service->sendToMesh(p);
    LOG_INFO("HomeCircle home base: sent %08x a text (%u bytes)", (unsigned)node, (unsigned)len);
}

// A traceroute to a node: each relay adds itself on the way there and back
// (Meshtastic's TraceRouteModule); the answer comes to handleReceived.
void HomeBaseModule::traceNode(uint32_t node)
{
    meshtastic_MeshPacket *p = allocDataPacket();
    p->decoded.portnum = meshtastic_PortNum_TRACEROUTE_APP;
    p->to = node;
    meshtastic_NodeInfoLite *n = nodeDB->getMeshNode(node);
    int idx = channelIndex();
    p->channel = n && n->channel ? n->channel : (idx >= 0 ? idx : channels.getPrimaryIndex());
    p->decoded.want_response = true;
    p->decoded.payload.size = 0; // an empty RouteDiscovery
    p->want_ack = false;
    p->priority = meshtastic_MeshPacket_Priority_RELIABLE;
    service->sendToMesh(p);
    LOG_INFO("HomeCircle home base: traceroute to %08x", (unsigned)node);
}

bool HomeBaseModule::wantPacket(const meshtastic_MeshPacket *p)
{
    if (!p || p->which_payload_variant != meshtastic_MeshPacket_decoded_tag)
        return false;
    meshtastic_PortNum port = p->decoded.portnum;
    return port == meshtastic_PortNum_TEXT_MESSAGE_APP || port == meshtastic_PortNum_PRIVATE_APP || port == meshtastic_PortNum_POSITION_APP ||
           port == meshtastic_PortNum_TRACEROUTE_APP;
}

ProcessMessage HomeBaseModule::handleReceived(const meshtastic_MeshPacket &mp)
{
    if (!configured || mp.from == nodeDB->getNodeNum())
        return ProcessMessage::CONTINUE;
    const auto &pl = mp.decoded.payload;
    switch (mp.decoded.portnum) {
    case meshtastic_PortNum_TEXT_MESSAGE_APP:
        hb.onText(mp.from, std::string((const char *)pl.bytes, pl.size));
        break;
    case meshtastic_PortNum_PRIVATE_APP:
        hb.onMeshPacket(hc::Bytes(pl.bytes, pl.bytes + pl.size));
        break;
    case meshtastic_PortNum_POSITION_APP:
        lastPoll = 0; // the node database has it now: pass it on soon
        break;
    case meshtastic_PortNum_TRACEROUTE_APP: {
        // The answer to our traceroute: route_back lists the relays the answer
        // passed through, in order, from the tracker towards us.
        if (!mp.decoded.request_id || mp.to != nodeDB->getNodeNum() || !hb.isTracker(mp.from))
            break;
        meshtastic_RouteDiscovery r = meshtastic_RouteDiscovery_init_zero;
        if (!pb_decode_from_bytes(pl.bytes, pl.size, &meshtastic_RouteDiscovery_msg, &r))
            break;
        std::vector<uint32_t> back(r.route_back, r.route_back + r.route_back_count);
        std::vector<int> snr(r.snr_back, r.snr_back + r.snr_back_count);
        if (snr.size() <= back.size())
            snr.resize(back.size() + 1, -128), snr[back.size()] = (int)(mp.rx_snr * 4); // how we heard the last hop
        hb.onRoute(mp.from, back, snr);
        LOG_INFO("HomeCircle home base: path from %08x has %u relay(s)", (unsigned)mp.from, (unsigned)back.size());
        break;
    }
    default:
        break;
    }
    return ProcessMessage::CONTINUE;
}

// Trackers' latest positions and battery, from what this node has heard.
void HomeBaseModule::pollPositions()
{
    for (size_t i = 0; i < nodeDB->getNumMeshNodes(); i++) {
        meshtastic_NodeInfoLite *n = nodeDB->getMeshNodeByIndex(i);
        if (!n || !n->has_position || !hb.isTracker(n->num))
            continue;
        const meshtastic_PositionLite &p = n->position;
        if ((!p.latitude_i && !p.longitude_i) || !p.time || seenFix[n->num] >= p.time)
            continue;
        seenFix[n->num] = p.time;
        hc::Fix fix;
        fix.lat = p.latitude_i * 1e-7;
        fix.lng = p.longitude_i * 1e-7;
        if (n->has_device_metrics && n->device_metrics.has_battery_level) {
            uint32_t b = n->device_metrics.battery_level;
            fix.battery = b > 100 ? 100 : (int)b; // 101: on external power
            fix.charging = b > 100;
        }
        hb.onPosition(n->num, fix, (int64_t)p.time * 1000);
    }
}

// --- setup ------------------------------------------------------------------------------

void HomeBaseModule::startPortal()
{
    apSsid = "HomeCircle Home Base " + deviceSuffix();
    apPass = apPassword();
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP(apSsid.c_str(), apPass.c_str());
    dns = new DNSServer();
    dns->start(53, "*", WiFi.softAPIP());
    web = new WebServer(80);
    portalStarted = millis();
    region = config.lora.region;
    needInvite = !hb.ready();

    web->on("/", HTTP_GET, []() {
        String page = String("<!doctype html><title>HomeCircle home base</title>") + STYLE;
        if (needInvite)
            page += "<h1>Set up this home base</h1><p>It joins your HomeCircle circle over your home Wi-Fi and passes on what "
                    "Meshtastic trackers send. An admin makes an invite in the HomeCircle app (Settings → your circle → Invite someone).</p>";
        else
            page += "<h1>Wi-Fi for this home base</h1><p>It's already in <b>" + esc(hb.base().circleName()) +
                    "</b>, but it has no home Wi-Fi to reach your server.</p>";
        page += "<form method=post action=/setup>"
                "<label for=s>Home Wi-Fi network <span class=hint>(2.4 GHz)</span></label><input id=s name=s required>"
                "<label for=p>Wi-Fi password</label><input id=p name=p type=password>";
        if (needInvite)
            page += "<label for=i>Invite link <span class=hint>(it names your HomeCircle server too)</span></label>"
                    "<textarea id=i name=i rows=3 required></textarea>";
        page += "<label for=r>Where you are <span class=hint>(LoRa radios must use their country's band)</span></label><select id=r name=r>";
        for (auto &r : REGIONS)
            page += String("<option value=") + r.code + (r.code == region ? " selected" : "") + ">" + r.name + "</option>";
        page += "</select><button>Set up</button></form>";
        web->send(200, "text/html; charset=utf-8", page);
    });
    web->on("/setup", HTTP_POST, []() {
        wifiSsid = web->arg("s").c_str();
        wifiPass = web->arg("p").c_str();
        invite = web->arg("i").c_str();
        region = web->arg("r").toInt();
        job = Job::Joining;
        web->sendHeader("Location", "/status");
        web->send(303);
    });
    web->on("/status", HTTP_GET, []() {
        String body;
        if (job == Job::Joining) {
            body = needInvite ? "<meta http-equiv=refresh content=3><h1>Setting up…</h1><p>Joining your Wi-Fi and your circle. This can take a minute.</p>"
                              : "<meta http-equiv=refresh content=3><h1>Setting up…</h1><p>Joining your Wi-Fi.</p>";
        } else if (job == Job::Joined) {
            std::string link = homeBaseModule->channelLink();
            body = "<h1>Done</h1><p>This home base is in <b>" + esc(hb.base().circleName()) +
                   "</b>. It restarts in a minute and then runs on your Wi-Fi.</p><ol>"
                   "<li>In HomeCircle, make <b>Home base</b> an admin, so it can add trackers.</li>"
                   "<li>Put each tracker on the private channel: on a phone connected to the tracker in the Meshtastic app, open<br><code>" +
                   esc(link) +
                   "</code><br>(You can get this link again by sending <b>channel</b> to Home base in the HomeCircle chat.)</li>"
                   "<li>In the HomeCircle chat, send <b>list</b> to Home base, then <b>add !id Name</b> for each tracker.</li></ol>";
        } else if (job == Job::Failed) {
            body = "<h1 class=err>That didn’t work</h1><p>" + esc(jobError) + "</p><p><a href=/>Try again</a></p>";
        } else {
            body = "<meta http-equiv=refresh content=0;url=/>";
        }
        web->send(200, "text/html; charset=utf-8", String("<!doctype html><title>HomeCircle home base</title>") + STYLE + body);
    });
    web->onNotFound([]() {
        web->sendHeader("Location", "http://" + WiFi.softAPIP().toString() + "/");
        web->send(302);
    });
    web->begin();
    LOG_INFO("HomeCircle home base: setup on Wi-Fi \"%s\", password %s, http://%s", apSsid.c_str(), apPass.c_str(),
             WiFi.softAPIP().toString().c_str());
#if HAS_SCREEN
    if (screen) {
        static char banner[96];
        snprintf(banner, sizeof banner, "Setup: join Wi-Fi\n%s\nPassword %s", apSsid.c_str(), apPass.c_str());
        screen->showSimpleBanner(banner, PORTAL_MS);
    }
#endif
}

void HomeBaseModule::portalLoop()
{
    dns->processNextRequest();
    web->handleClient();
    if (job == Job::Joining) {
        WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
        uint32_t t = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - t < 20000) {
            web->handleClient();
            hcio::feedWatchdog();
            delay(50);
        }
        if (WiFi.status() != WL_CONNECTED) {
            job = Job::Failed;
            jobError = "It couldn't join that Wi-Fi network. Check the name and password (2.4 GHz networks only).";
            return;
        }
        // Meshtastic's own settings first, so they're kept whatever happens
        // next: the region, home Wi-Fi from now on, and the private channel.
        if (region > 0)
            config.lora.region = (meshtastic_Config_LoRaConfig_RegionCode)region;
        config.network.wifi_enabled = true;
        memset(config.network.wifi_ssid, 0, sizeof config.network.wifi_ssid);
        memset(config.network.wifi_psk, 0, sizeof config.network.wifi_psk);
        strncpy(config.network.wifi_ssid, wifiSsid.c_str(), sizeof config.network.wifi_ssid - 1);
        strncpy(config.network.wifi_psk, wifiPass.c_str(), sizeof config.network.wifi_psk - 1);
        ensureChannel();
        bool saved = nodeDB->saveToDisk(SEGMENT_CONFIG | SEGMENT_CHANNELS);
        LOG_INFO("HomeCircle home base: settings %s", saved ? "saved" : "NOT saved");
        hcio::feedWatchdog();
        if (needInvite) {
            hc::Status s = hb.setup(invite);
            invite.clear();
            hcio::feedWatchdog();
            if (s != hc::Status::Ok) {
                job = Job::Failed;
                jobError = "It joined your Wi-Fi but couldn't join the circle: " + hb.base().error();
                return;
            }
        }
        job = Job::Joined;
        joinedAt = millis();
        LOG_INFO("HomeCircle home base: set up in %s", hb.base().circleName().c_str());
    }
    if (job == Job::Joined && millis() - joinedAt > 60000 && !rebootAtMsec)
        rebootAtMsec = millis() + 1000; // start again on the home Wi-Fi
    if (job != Job::Joined && millis() - portalStarted > PORTAL_MS && !rebootAtMsec)
        rebootAtMsec = millis() + 1000; // nobody came: start again, and the page opens again
}

int32_t HomeBaseModule::runOnce()
{
    if (!started) {
        started = true;
        hc::cryptoInit();
        bool joined = hb.load();
        bool wifi = config.network.wifi_enabled && config.network.wifi_ssid[0];
        // Repair what an interrupted setup may have left out.
        if (joined && channelIndex() < 0) {
            ensureChannel();
            nodeDB->saveToDisk(SEGMENT_CHANNELS);
            LOG_INFO("HomeCircle home base: made the private HomeCircle channel");
        }
        configured = joined && wifi;
        if (!configured) {
            // Not in a circle yet, or in one with no home Wi-Fi: the setup page asks for what's missing.
            startPortal();
        } else {
            LOG_INFO("HomeCircle home base: in %s with %u tracker(s)", hb.base().circleName().c_str(), (unsigned)hb.trackerCount());
        }
    }
    if (!configured) {
        portalLoop();
        return 5;
    }
    if (millis() - lastPoll > 5000 || !lastPoll) {
        pollPositions();
        lastPoll = millis();
    }
    if (hcio::online() && millis() - lastTick > 5000) {
        hb.tick();
        if (!hb.log.empty()) {
            LOG_INFO("HomeCircle home base: %s (stack never below %u bytes free)", hb.log.c_str(),
                     (unsigned)uxTaskGetStackHighWaterMark(NULL));
        }
        hb.log.clear();
        lastTick = millis();
    }
    return 1000;
}

#endif
