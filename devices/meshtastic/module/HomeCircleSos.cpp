// SPDX-License-Identifier: GPL-3.0-only
// HomeCircle's button for a stock Meshtastic tracker with one button
// (SenseCAP T1000-E). Press it 1 to 5 times, no more than 2 s apart:
//
//   1  I'm OK: answers "Ask to check in" (the tracker beeped for it)
//   2  Here's where I am: a message and a fresh position
//   3  Come pick me up: the same, as an urgent alert
//   4  On my way home: a message and a fresh position
//   5  SOS; 5 again says you're safe
//
// What each one says is set in the HomeCircle app (the Meshtastic plugin, or
// one tracker's own settings); the home base sends it. This firmware only
// counts: it sends "#press N" on the tracker's primary channel (the private
// HomeCircle channel) as data, not a text, so other trackers don't beep, plus
// its position for 2 to 4. An SOS is a text with the alert bell, which any
// home base also takes as an SOS. It goes again every minute until the home
// base answers "#sos-ack" (by radio, or through the internet bridge and a
// gateway near it): then the tracker plays a rising "delivered" tune and
// sends it every 5 minutes while the SOS is on.
//
// The home base also sends "#cfg": whether an SOS also goes out as plain text
// on the public Meshtastic channel (anyone nearby on Meshtastic sees it), and
// the public beacon (a rounded position on the public channel every 15 to 60
// minutes, so gateways anywhere pass it on). Either one adds the public
// channel (LongFast, the default key) here as a muted secondary channel.
// Kept in /prefs/hcsos.
//
// It beeps once per press counted, so you know it understood. register.py
// adds hooks in Meshtastic's ButtonThread that report every press and take
// over Meshtastic's own 2, 3 and 4 press gestures (send a position, GPS on or
// off, mute). A long hold still powers it off. Everything else stays stock.
#include "configuration.h"
#ifdef HOMECIRCLE_SOS

#include "Channels.h"
#include "FSCommon.h"
#include "HomeCircleSosModule.h"
#include "MeshService.h"
#include "NodeDB.h"
#include "Router.h"
#include "SPILock.h"
#include "buzz/buzz.h"
#include "concurrency/OSThread.h"
#include "modules/PositionModule.h"
#include <cstdio>
#include <cstring>
#include <string>

namespace
{

const char *SOS_TEXT = "\a\xF0\x9F\x86\x98 SOS"; // bell, 🆘 SOS
const char *SAFE_TEXT = "OK, I'm safe";
const uint32_t REPEAT_MS = 60 * 1000;          // until the home base says it has it
const uint32_t DELIVERED_REPEAT_MS = 5 * 60 * 1000; // after (and after an hour unanswered)
const int FAST_REPEATS = 60;
const uint32_t PRESS_GAP_MS = 2000; // the count ends after this long without a press
const char *PUBLIC_CHANNEL = "LongFast";
const char *CFG_PATH = "/prefs/hcsos";

bool sosOn = false;
bool delivered = false;
int repeats = 0;
uint32_t lastPressAt = 0;
int presses = 0;

// From the home base's "#cfg": public SOS, beacon every so many seconds, its precision (bits).
struct Cfg {
    bool publicSos = false;
    uint32_t beaconS = 0;
    uint32_t prec = 13;
    std::string raw;
} cfg;
uint32_t beaconAt = 0;

bool parseCfg(const std::string &text, Cfg &out)
{
    int psos = 0;
    unsigned beacon = 0, prec = 13;
    if (sscanf(text.c_str(), "psos=%d beacon=%u prec=%u", &psos, &beacon, &prec) < 2)
        return false;
    out.publicSos = psos == 1;
    out.beaconS = beacon >= 60 && beacon <= 24 * 3600 ? beacon : 0;
    out.prec = prec >= 10 && prec <= 32 ? prec : 13;
    out.raw = text;
    return true;
}

void loadCfg()
{
    concurrency::LockGuard g(spiLock);
    File f = FSCom.open(CFG_PATH, FILE_O_READ);
    if (!f)
        return;
    char buf[64] = {0};
    f.read((uint8_t *)buf, sizeof buf - 1);
    f.close();
    parseCfg(buf, cfg);
}

void saveCfg()
{
    concurrency::LockGuard g(spiLock);
    FSCom.mkdir("/prefs");
    FSCom.remove(CFG_PATH);
    File f = FSCom.open(CFG_PATH, FILE_O_WRITE);
    if (!f)
        return;
    f.write((const uint8_t *)cfg.raw.data(), cfg.raw.size());
    f.close();
}

// The public channel's slot here, or -1.
int publicIndex()
{
    for (int i = 1; i < MAX_NUM_CHANNELS; i++) {
        meshtastic_Channel &c = channels.getByIndex(i);
        if (c.role == meshtastic_Channel_Role_SECONDARY && strcmp(c.settings.name, PUBLIC_CHANNEL) == 0)
            return i;
    }
    return -1;
}

// Add the public channel (muted, with the beacon's precision) when the settings
// want it, take it away when they don't.
void applyPublicChannel()
{
    bool want = cfg.publicSos || cfg.beaconS;
    int idx = publicIndex();
    if (want) {
        if (idx < 0) {
            for (int i = 1; i < MAX_NUM_CHANNELS && idx < 0; i++)
                if (channels.getByIndex(i).role == meshtastic_Channel_Role_DISABLED)
                    idx = i;
            if (idx < 0)
                return; // no free slot
        }
        meshtastic_Channel ch = channels.getByIndex(idx);
        ch.index = idx;
        ch.role = meshtastic_Channel_Role_SECONDARY;
        ch.has_settings = true;
        memset(&ch.settings, 0, sizeof ch.settings);
        strncpy(ch.settings.name, PUBLIC_CHANNEL, sizeof ch.settings.name - 1);
        ch.settings.psk.size = 1;
        ch.settings.psk.bytes[0] = 1; // the default key: anyone on the public channel reads it
        ch.settings.has_module_settings = true;
        ch.settings.module_settings.position_precision = cfg.beaconS ? cfg.prec : 0;
        ch.settings.module_settings.is_muted = true; // don't beep for strangers' messages
        channels.setChannel(ch);
    } else if (idx >= 0) {
        meshtastic_Channel ch = channels.getByIndex(idx);
        ch.role = meshtastic_Channel_Role_DISABLED;
        channels.setChannel(ch);
    } else {
        return;
    }
    channels.onConfigChanged();
    nodeDB->saveToDisk(SEGMENT_CHANNELS);
}

// "SOS: needs help at 37.5482,-121.9885 (HomeCircle)", on the public channel.
void sendPublicSos()
{
    int idx = publicIndex();
    if (!cfg.publicSos || idx < 0)
        return;
    meshtastic_NodeInfoLite *me = nodeDB->getMeshNode(nodeDB->getNodeNum());
    char text[120];
    if (me && me->has_position && (me->position.latitude_i || me->position.longitude_i))
        snprintf(text, sizeof text, "\a\xF0\x9F\x86\x98 SOS: needs help at %.5f,%.5f (HomeCircle tracker %s)", me->position.latitude_i * 1e-7,
                 me->position.longitude_i * 1e-7, owner.long_name);
    else
        snprintf(text, sizeof text, "\a\xF0\x9F\x86\x98 SOS: needs help (HomeCircle tracker %s, no GPS fix yet)", owner.long_name);
    meshtastic_MeshPacket *p = router->allocForSending();
    p->decoded.portnum = meshtastic_PortNum_TEXT_MESSAGE_APP;
    p->to = NODENUM_BROADCAST;
    p->channel = idx;
    p->want_ack = false;
    p->priority = meshtastic_MeshPacket_Priority_ALERT;
    size_t n = std::min(strlen(text), sizeof(p->decoded.payload.bytes));
    memcpy(p->decoded.payload.bytes, text, n);
    p->decoded.payload.size = n;
    service->sendToMesh(p);
}

void sendText(const char *text, bool urgent)
{
    meshtastic_MeshPacket *p = router->allocForSending();
    p->decoded.portnum = meshtastic_PortNum_TEXT_MESSAGE_APP;
    p->to = NODENUM_BROADCAST;
    p->channel = channels.getPrimaryIndex();
    p->want_ack = false;
    p->priority = urgent ? meshtastic_MeshPacket_Priority_ALERT : meshtastic_MeshPacket_Priority_RELIABLE;
    size_t n = std::min(strlen(text), sizeof(p->decoded.payload.bytes));
    memcpy(p->decoded.payload.bytes, text, n);
    p->decoded.payload.size = n;
    service->sendToMesh(p, RX_SRC_LOCAL, true); // and show it in the Meshtastic app if a phone is connected
}

// A press, as data rather than a text: the home base reads it, the mesh relays
// it, and other trackers on the channel don't beep for it (they beep for texts).
void sendPress(const char *text, bool urgent)
{
    meshtastic_MeshPacket *p = router->allocForSending();
    p->decoded.portnum = meshtastic_PortNum_PRIVATE_APP;
    p->to = NODENUM_BROADCAST;
    p->channel = channels.getPrimaryIndex();
    p->want_ack = false;
    p->priority = urgent ? meshtastic_MeshPacket_Priority_ALERT : meshtastic_MeshPacket_Priority_RELIABLE;
    size_t n = std::min(strlen(text), sizeof(p->decoded.payload.bytes));
    memcpy(p->decoded.payload.bytes, text, n);
    p->decoded.payload.size = n;
    service->sendToMesh(p);
}

void sendPosition()
{
    if (positionModule)
        positionModule->sendOurPosition();
}

void toggleSos();

// Sends the SOS and the position again while the SOS is on, and acts on a
// count of presses once the presses stop.
class ButtonWork : public concurrency::OSThread
{
  public:
    ButtonWork() : OSThread("HomeCircleButton") {}
    void soon(uint32_t ms)
    {
        enabled = true;
        setIntervalFromNow(ms);
    }

  protected:
    int32_t runOnce() override
    {
        uint32_t now = millis();
        if (presses > 0 && now - lastPressAt >= PRESS_GAP_MS) {
            int n = presses;
            presses = 0;
            act(n);
        }
        if (presses > 0)
            return 200;
        // The public beacon: a rounded position on the public channel now and then.
        if (cfg.beaconS && positionModule && now - beaconAt >= cfg.beaconS * 1000) {
            int idx = publicIndex();
            beaconAt = now;
            if (idx >= 0) {
                positionModule->sendOurPosition(NODENUM_BROADCAST, false, idx);
                LOG_INFO("HomeCircle tracker: public beacon");
            }
        }
        if (sosOn) {
            uint32_t every = delivered || repeats >= FAST_REPEATS ? DELIVERED_REPEAT_MS : REPEAT_MS;
            if (now - sentAt >= every) {
                repeats++;
                sentAt = now;
                sendText(SOS_TEXT, true);
                sendPosition();
                sendPublicSos();
                LOG_INFO("HomeCircle button: SOS sent again (%s)", delivered ? "delivered" : "not answered yet");
            }
            return 1000;
        }
        if (cfg.beaconS)
            return 30 * 1000;
        return disable();
    }

  public:
    uint32_t sentAt = 0;

  private:
    void act(int n)
    {
        if (n >= 5) {
            toggleSos();
            return;
        }
        char text[16];
        snprintf(text, sizeof text, "#press %d", n);
        sendPress(text, n == 3);
        if (n >= 2)
            sendPosition();
        LOG_INFO("HomeCircle button: %d press(es)", n);
    }
};
ButtonWork *work = nullptr;

void toggleSos()
{
    sosOn = !sosOn;
    if (sosOn) {
        sendText(SOS_TEXT, true);
        sendPosition();
        sendPublicSos();
        delivered = false;
        repeats = 0;
        work->sentAt = millis();
        work->soon(1000);
        playLongBeep(); // a long beep: the SOS is on its way
        LOG_INFO("HomeCircle button: SOS sent");
    } else {
        delivered = false;
        sendText(SAFE_TEXT, false);
        playBeep(); // a short beep: safe
        LOG_INFO("HomeCircle button: safe");
    }
}

} // namespace

// --- the receiver: "#sos-ack" and "#cfg" from the home base ---------------------

HomeCircleSosModule::HomeCircleSosModule() : SinglePortModule("homecircle-sos", meshtastic_PortNum_PRIVATE_APP)
{
    if (!work)
        work = new ButtonWork();
    loadCfg();
    if (cfg.beaconS)
        work->soon(60 * 1000); // the beacon starts a minute after power on
}

ProcessMessage HomeCircleSosModule::handleReceived(const meshtastic_MeshPacket &mp)
{
    std::string text((const char *)mp.decoded.payload.bytes, mp.decoded.payload.size);
    char me[12];
    snprintf(me, sizeof me, "!%08x", (unsigned)nodeDB->getNodeNum());
    if (text == std::string("#sos-ack ") + me) {
        if (sosOn && !delivered) {
            delivered = true;
            play4ClickUp(); // rising: the circle has it
            LOG_INFO("HomeCircle tracker: SOS delivered");
        }
        return ProcessMessage::STOP;
    }
    std::string prefix = std::string("#cfg ") + me + " ";
    if (text.rfind(prefix, 0) == 0) {
        Cfg got;
        if (parseCfg(text.substr(prefix.size()), got)) {
            bool changed = got.raw != cfg.raw;
            cfg = got;
            if (changed) {
                saveCfg();
                applyPublicChannel();
                beaconAt = 0;
                if (cfg.beaconS)
                    work->soon(10 * 1000);
            }
            // Confirm, so the home base stops sending it.
            std::string ok = "#cfg-ok " + cfg.raw;
            meshtastic_MeshPacket *p = router->allocForSending();
            p->decoded.portnum = meshtastic_PortNum_PRIVATE_APP;
            p->to = NODENUM_BROADCAST;
            p->channel = channels.getPrimaryIndex();
            p->want_ack = false;
            size_t n = std::min(ok.size(), sizeof(p->decoded.payload.bytes));
            memcpy(p->decoded.payload.bytes, ok.data(), n);
            p->decoded.payload.size = n;
            service->sendToMesh(p);
            LOG_INFO("HomeCircle tracker: settings %s", cfg.raw.c_str());
        }
        return ProcessMessage::STOP;
    }
    return ProcessMessage::CONTINUE;
}

// Every press of the button (register.py's hooks in ButtonThread): a single
// press counts 1, a quick double 2, quick multi-presses their count. True
// takes over Meshtastic's own gesture for that count.
bool hcButtonPresses(int n)
{
    if (!work)
        work = new ButtonWork();
    uint32_t now = millis();
    if (now - lastPressAt > PRESS_GAP_MS)
        presses = 0;
    lastPressAt = now;
    presses += n;
    for (int i = 0; i < n && presses - n + i < 5; i++)
        playBeep(); // one beep per press counted
    LOG_INFO("HomeCircle button: %d press(es) so far", presses);
    if (presses >= 5) {
        presses = 0; // 5 is the most: act now
        toggleSos();
    } else {
        work->soon(PRESS_GAP_MS);
    }
    return true;
}

#endif
