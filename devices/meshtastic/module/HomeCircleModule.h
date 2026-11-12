// SPDX-License-Identifier: GPL-3.0-only
// HomeCircle for Meshtastic: this node is also a HomeCircle tracker. Built
// into the Meshtastic firmware (see ../README.md and build.sh).
#pragma once
#include "configuration.h"
#ifdef HOMECIRCLE
#include "SinglePortModule.h"
#include "concurrency/OSThread.h"
#include <vector>

/**
 * Reports this node's location to a HomeCircle circle: over HTTPS when the
 * node is on Wi-Fi, otherwise as a sealed packet on the mesh that a home base
 * hands to the server. Takes commands as text on the "HomeCircle" channel:
 *
 *   hc !a1b2c3d4 join <invite link> <name>
 *   hc !a1b2c3d4 status | sos | safe | forget
 */
class HomeCircleModule : public SinglePortModule, private concurrency::OSThread
{
  public:
    HomeCircleModule();

  protected:
    bool wantPacket(const meshtastic_MeshPacket *p) override;
    ProcessMessage handleReceived(const meshtastic_MeshPacket &mp) override;
    int32_t runOnce() override;

  private:
    void report();
    void runCommand();
    void pollButton();
    void reply(const char *text);
    void sendMesh(const std::vector<uint8_t> &packet, bool urgent);
    uint8_t channelIndex(bool *found = nullptr);
};

extern HomeCircleModule *homeCircleModule;
#endif
