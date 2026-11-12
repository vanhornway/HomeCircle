// SPDX-License-Identifier: GPL-3.0-only
// HomeCircle for Meshtastic. The protocol itself (joining, keys, sealing,
// mesh packets) is the tracker library in devices/tracker/lib/homecircle,
// copied in by build.sh; this file connects it to Meshtastic: the node's GPS
// fix, battery, Wi-Fi, file system and radio.
#include "HomeCircleModule.h"
#ifdef HOMECIRCLE

#include "Channels.h"
#include "FSCommon.h"
#include "MeshService.h"
#include "NodeDB.h"
#include "PowerStatus.h"
#include "RTC.h"
#include "SPILock.h"
#include "HomeCircleIO.h"
#include <Arduino.h>
#include <math.h>

// A button for SOS, separate from the board's own (Meshtastic uses that one).
// Wire it from this pin to GND. -1: no SOS button (commands still work).
#ifndef HC_SOS_PIN
#define HC_SOS_PIN -1
#endif

HomeCircleModule *homeCircleModule;

namespace
{

const char *CHANNEL = "HomeCircle";

using hcio::nowMs;
using hcio::online;

hcio::FsStore store;
hcio::WifiHttp http;
hc::Device device(http, store, nowMs);

bool started = false;
bool joined = false;
uint32_t nextReportMs = 0;
uint32_t reports = 0;
int movingMin = 2, stillMin = 60;
bool sosEnabled = true;
int32_t lastLat = 0, lastLng = 0;
uint8_t safeRepeats = 0; // "safe" goes out a few times over the mesh: there's no answer to say it arrived
#if HC_SOS_PIN >= 0
uint32_t buttonDownMs = 0;
#endif

// A command waiting for the module's thread (network calls don't run inside packet handling).
std::string pending;

bool positionFix(hc::Fix &fix)
{
    const meshtastic_Position &p = localPosition;
    if (!p.latitude_i && !p.longitude_i)
        return false;
    uint32_t now = getTime();
    if (p.time && now > p.time && now - p.time > 15 * 60)
        return false; // stale
    fix.lat = p.latitude_i * 1e-7;
    fix.lng = p.longitude_i * 1e-7;
    fix.accuracy = p.gps_accuracy && p.PDOP ? (float)p.gps_accuracy * p.PDOP / 100000.0f : -1;
    fix.speed = p.has_ground_speed ? (float)p.ground_speed : -1;
    if (powerStatus && powerStatus->getHasBattery()) {
        fix.battery = powerStatus->getBatteryChargePercent();
        fix.charging = powerStatus->getIsCharging();
    }
    return true;
}

} // namespace

HomeCircleModule::HomeCircleModule()
    : SinglePortModule("homecircle", meshtastic_PortNum_TEXT_MESSAGE_APP), concurrency::OSThread("HomeCircle")
{
    isPromiscuous = true; // commands arrive as channel messages
    homeCircleModule = this;
    setIntervalFromNow(20 * 1000);
}

uint8_t HomeCircleModule::channelIndex(bool *found)
{
    meshtastic_Channel &c = channels.getByName(CHANNEL);
    bool ok = strcmp(channels.getName(c.index), CHANNEL) == 0;
    if (found)
        *found = ok;
    return ok ? c.index : channels.getPrimaryIndex();
}

bool HomeCircleModule::wantPacket(const meshtastic_MeshPacket *p)
{
    return p && p->decoded.portnum == meshtastic_PortNum_TEXT_MESSAGE_APP;
}

// Commands: text on the HomeCircle channel, naming this node, so only people
// with that channel's key can set it up, and one channel can hold several trackers.
ProcessMessage HomeCircleModule::handleReceived(const meshtastic_MeshPacket &mp)
{
    bool found = false;
    uint8_t ch = channelIndex(&found);
    if (!found || mp.channel != ch || mp.decoded.payload.size < 4)
        return ProcessMessage::CONTINUE;
    std::string text((const char *)mp.decoded.payload.bytes, mp.decoded.payload.size);
    char me[16];
    snprintf(me, sizeof me, "hc !%08x ", (unsigned)nodeDB->getNodeNum());
    if (text.rfind(me, 0) != 0)
        return ProcessMessage::CONTINUE;
    pending = text.substr(strlen(me));
    setIntervalFromNow(0);
    return ProcessMessage::CONTINUE;
}

void HomeCircleModule::reply(const char *text)
{
    meshtastic_MeshPacket *p = allocDataPacket();
    p->decoded.portnum = meshtastic_PortNum_TEXT_MESSAGE_APP;
    p->to = NODENUM_BROADCAST;
    p->channel = channelIndex();
    size_t n = strnlen(text, sizeof(p->decoded.payload.bytes));
    memcpy(p->decoded.payload.bytes, text, n);
    p->decoded.payload.size = n;
    service->sendToMesh(p);
}

void HomeCircleModule::sendMesh(const std::vector<uint8_t> &packet, bool urgent)
{
    if (packet.empty())
        return;
    meshtastic_MeshPacket *p = allocDataPacket();
    if (packet.size() > sizeof(p->decoded.payload.bytes)) {
        packetPool.release(p);
        return;
    }
    p->decoded.portnum = meshtastic_PortNum_PRIVATE_APP;
    p->to = NODENUM_BROADCAST;
    p->channel = channelIndex();
    p->want_ack = false;
    p->priority = urgent ? meshtastic_MeshPacket_Priority_ALERT : meshtastic_MeshPacket_Priority_BACKGROUND;
    memcpy(p->decoded.payload.bytes, packet.data(), packet.size());
    p->decoded.payload.size = packet.size();
    service->sendToMesh(p);
    LOG_INFO("HomeCircle: sent %u bytes over the mesh", (unsigned)packet.size());
}

void HomeCircleModule::runCommand()
{
    std::string cmd = pending;
    pending.clear();
    char out[200];
    if (cmd.rfind("join ", 0) == 0) {
        // join <link> <name…>
        std::string rest = cmd.substr(5);
        size_t sp = rest.find(' ');
        std::string link = rest.substr(0, sp), name = sp == std::string::npos ? "" : rest.substr(sp + 1);
        if (joined) {
            reply("HomeCircle: already in a circle. Send \"forget\" first.");
        } else if (!online()) {
            reply("HomeCircle: joining needs Wi-Fi once. Turn on Wi-Fi in this node's network settings, then try again.");
        } else {
            hc::Status s = device.join(link, name.empty() ? "Tracker" : name);
            joined = s == hc::Status::Ok;
            snprintf(out, sizeof out, joined ? "HomeCircle: joined %s as %s." : "HomeCircle: couldn't join (%s).",
                     joined ? device.circleName().c_str() : device.error().c_str(), device.name().c_str());
            reply(out);
            if (joined)
                nextReportMs = millis();
        }
    } else if (cmd == "status") {
        snprintf(out, sizeof out, "HomeCircle: %s%s, %s, every %d/%d min%s", joined ? "in " : "not set up",
                 joined ? device.circleName().c_str() : "", online() ? "Wi-Fi" : "mesh only", movingMin, stillMin,
                 device.sosActive() ? ", SOS on" : "");
        reply(out);
    } else if (cmd == "sos" && joined && sosEnabled) {
        device.sos(true, online());
        nextReportMs = millis();
        reply("HomeCircle: SOS sent.");
    } else if (cmd == "safe" && joined) {
        device.sos(false, online());
        safeRepeats = 3;
        nextReportMs = millis();
        reply("HomeCircle: safe sent.");
    } else if (cmd == "forget") {
        device.forget();
        joined = false;
        reply("HomeCircle: forgot the circle.");
    }
}

void HomeCircleModule::pollButton()
{
#if HC_SOS_PIN >= 0
    bool down = digitalRead(HC_SOS_PIN) == LOW;
    uint32_t now = millis();
    if (down && !buttonDownMs)
        buttonDownMs = now ? now : 1;
    if (!down && buttonDownMs) {
        uint32_t held = now - buttonDownMs;
        buttonDownMs = 0;
        if (!joined)
            return;
        if (held >= 5000 && device.sosActive()) {
            device.sos(false, online());
            safeRepeats = 3;
        } else if (held >= 2000 && !device.sosActive() && sosEnabled) {
            device.sos(true, online());
        }
        nextReportMs = now;
    }
#endif
}

void HomeCircleModule::report()
{
    hc::Fix fix;
    bool have = positionFix(fix);
    bool viaInternet = online();
    if (viaInternet) {
        if (!device.meshRegistered())
            device.registerMesh();
        device.flushSos();
        if (reports % 6 == 0) {
            hc::TrackerSettings t;
            if (device.fetchSettings(t) == hc::Status::Ok) {
                movingMin = t.moving;
                stillMin = t.still;
                sosEnabled = t.sos;
            }
        }
        if (have) {
            hc::Status s = device.shareLocation(fix, device.sosActive() ? "sos" : "update", movingMin, stillMin);
            if (s == hc::Status::Removed) {
                device.forget();
                joined = false;
                return;
            }
            if (s == hc::Status::Offline)
                viaInternet = false; // try the mesh instead
        }
    }
    if (!viaInternet) {
        if (device.sosActive() || safeRepeats) {
            sendMesh(device.meshSos(), true);
            if (safeRepeats)
                safeRepeats--;
        }
        if (have)
            sendMesh(device.meshLocation(fix), device.sosActive());
    }
    reports++;
    bool moved = have && (lastLat || lastLng) &&
                 (abs(localPosition.latitude_i - lastLat) > 1500 || abs(localPosition.longitude_i - lastLng) > 1500 || fix.speed > 2);
    if (have) {
        lastLat = localPosition.latitude_i;
        lastLng = localPosition.longitude_i;
    }
    uint32_t minutes = device.sosActive() ? 1 : moved ? movingMin : stillMin;
    nextReportMs = millis() + minutes * 60000UL;
}

int32_t HomeCircleModule::runOnce()
{
    if (!started) {
        started = true;
        hc::cryptoInit();
        joined = device.load();
#if HC_SOS_PIN >= 0
        pinMode(HC_SOS_PIN, INPUT_PULLUP);
#endif
        nextReportMs = millis() + 60000; // let the GPS find itself first
        LOG_INFO("HomeCircle: %s", joined ? "in a circle" : "not set up; waiting for a join command on the HomeCircle channel");
    }
    if (!pending.empty())
        runCommand();
    pollButton();
    if (joined && (int32_t)(millis() - nextReportMs) >= 0)
        report();
#if HC_SOS_PIN >= 0
    return 100;
#else
    int32_t wait = (int32_t)(nextReportMs - millis());
    return wait < 1000 ? 1000 : wait > 60000 ? 60000 : wait;
#endif
}

#endif
