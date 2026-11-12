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
// its position for 2 to 4. An SOS is a text with
// the alert bell, which any home base also takes as an SOS, sent again every
// 30 s three more times since a broadcast has no delivery receipt.
//
// It beeps once per press counted, so you know it understood. register.py
// adds hooks in Meshtastic's ButtonThread that report every press and take
// over Meshtastic's own 2, 3 and 4 press gestures (send a position, GPS on or
// off, mute). A long hold still powers it off. Everything else stays stock.
#include "configuration.h"
#ifdef HOMECIRCLE_SOS

#include "Channels.h"
#include "MeshService.h"
#include "NodeDB.h"
#include "Router.h"
#include "buzz/buzz.h"
#include "concurrency/OSThread.h"
#include "modules/PositionModule.h"
#include <cstdio>
#include <cstring>

namespace
{

const char *SOS_TEXT = "\a\xF0\x9F\x86\x98 SOS"; // bell, 🆘 SOS
const char *SAFE_TEXT = "OK, I'm safe";
const uint32_t REPEAT_MS = 30 * 1000;
const uint32_t PRESS_GAP_MS = 2000; // the count ends after this long without a press

bool sosOn = false;
int repeatsLeft = 0;
uint32_t lastPressAt = 0;
int presses = 0;

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
        if (sosOn && repeatsLeft > 0) {
            if (now - sentAt >= REPEAT_MS) {
                repeatsLeft--;
                sentAt = now;
                sendText(SOS_TEXT, true);
                sendPosition();
                LOG_INFO("HomeCircle button: SOS sent again (%d more)", repeatsLeft);
            }
            return 1000;
        }
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
        repeatsLeft = 3;
        work->sentAt = millis();
        work->soon(1000);
        playLongBeep(); // a long beep: the SOS is on its way
        LOG_INFO("HomeCircle button: SOS sent");
    } else {
        repeatsLeft = 0;
        sendText(SAFE_TEXT, false);
        playBeep(); // a short beep: safe
        LOG_INFO("HomeCircle button: safe");
    }
}

} // namespace

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
