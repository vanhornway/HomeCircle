// SPDX-License-Identifier: GPL-3.0-only
// HomeCircle SOS for a stock Meshtastic tracker with one button (SenseCAP
// T1000-E): press the button 5 times (no more than 2 s apart) for an SOS, 5
// times again to say you're safe. Everything else about the tracker stays stock Meshtastic.
//
// It sends a text on the tracker's primary channel (the private HomeCircle
// channel) with the alert bell, plus its position. Any home base that hears
// it, directly or through other nodes, turns it into an SOS from this
// tracker in the circle (hc::HomeBase::onText). A broadcast has no delivery
// receipt, so the SOS and the position go out again every 30 s, three more
// times.
//
// register.py adds hooks in Meshtastic's ButtonThread that report every press.
// Meshtastic's own gestures still work: quick taps of 2 send a position, 3
// turn GPS on or off, 4 mute; a long hold powers off. Pressing at a steady
// pace (about once a second) avoids those and still counts.
#include "configuration.h"
#ifdef HOMECIRCLE_SOS

#include "Channels.h"
#include "MeshService.h"
#include "NodeDB.h"
#include "Router.h"
#include "buzz/buzz.h"
#include "concurrency/OSThread.h"
#include "modules/PositionModule.h"
#include <cstring>

namespace
{

const char *SOS_TEXT = "\a\xF0\x9F\x86\x98 SOS";    // bell, 🆘 SOS
const char *SAFE_TEXT = "OK, I'm safe";
const uint32_t REPEAT_MS = 30 * 1000;

bool sosOn = false;
int repeatsLeft = 0;

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

void sendPosition()
{
    if (positionModule)
        positionModule->sendOurPosition();
}

// Sends the SOS and the position again while the SOS is on.
class SosRepeat : public concurrency::OSThread
{
  public:
    SosRepeat() : OSThread("HomeCircleSos") { disable(); }
    void start()
    {
        enabled = true;
        setIntervalFromNow(REPEAT_MS);
    }

  protected:
    int32_t runOnce() override
    {
        if (!sosOn || repeatsLeft <= 0)
            return disable();
        repeatsLeft--;
        sendText(SOS_TEXT, true);
        sendPosition();
        LOG_INFO("HomeCircle SOS: sent again (%d more)", repeatsLeft);
        return REPEAT_MS;
    }
};
SosRepeat *repeater = nullptr;

} // namespace

namespace
{
const uint32_t PRESS_GAP_MS = 2000; // a longer gap starts the count again
uint32_t lastPressAt = 0;
int presses = 0;

void toggleSos();
} // namespace

// Every press of the button (register.py's hooks in ButtonThread): a single
// press counts 1, a quick double 2, quick multi-presses their count.
void hcButtonClicks(int n)
{
    uint32_t now = millis();
    if (now - lastPressAt > PRESS_GAP_MS)
        presses = 0;
    lastPressAt = now;
    presses += n;
    LOG_INFO("HomeCircle SOS: press %d of 5", presses);
    if (presses >= 5) {
        presses = 0;
        toggleSos();
    }
}

namespace
{
void toggleSos()
{
    if (!repeater)
        repeater = new SosRepeat();
    sosOn = !sosOn;
    if (sosOn) {
        sendText(SOS_TEXT, true);
        sendPosition();
        repeatsLeft = 3;
        repeater->start();
        playLongBeep(); // a long beep: the SOS is on its way
        LOG_INFO("HomeCircle SOS: sent");
    } else {
        repeatsLeft = 0;
        sendText(SAFE_TEXT, false);
        playBeep(); // a short beep: safe
        LOG_INFO("HomeCircle SOS: safe");
    }
}
} // namespace

#endif
