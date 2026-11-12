// SPDX-License-Identifier: GPL-3.0-only
// HomeCircle home base for Meshtastic: this node joins a circle, connects to
// the home Wi-Fi, and acts for stock Meshtastic trackers (see ../README.md).
#pragma once
#include "configuration.h"
#ifdef HOMECIRCLE_HOMEBASE
#include "SinglePortModule.h"
#include "concurrency/OSThread.h"
#include <string>

class HomeBaseModule : public SinglePortModule, private concurrency::OSThread
{
  public:
    HomeBaseModule();
    /** The link that puts a tracker on the private HomeCircle channel. */
    std::string channelLink();
    /** Ask a node for a fresh position. */
    void askPosition(uint32_t node);

  protected:
    bool wantPacket(const meshtastic_MeshPacket *p) override;
    ProcessMessage handleReceived(const meshtastic_MeshPacket &mp) override;
    int32_t runOnce() override;

  private:
    int channelIndex();
    int ensureChannel();
    void pollPositions();
    void startPortal();
    void portalLoop();
};

extern HomeBaseModule *homeBaseModule;
#endif
