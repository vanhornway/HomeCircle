// SPDX-License-Identifier: GPL-3.0-only
// The HomeCircle tracker's receiver (HomeCircleSos.cpp): its home base's
// "#sos-ack" (the SOS got there: beep "delivered") and "#cfg" (public SOS and
// beacon), as data on the private channel. Registered by register.py.
#pragma once
#include "configuration.h"
#ifdef HOMECIRCLE_SOS
#include "SinglePortModule.h"

class HomeCircleSosModule : public SinglePortModule
{
  public:
    HomeCircleSosModule();

  protected:
    ProcessMessage handleReceived(const meshtastic_MeshPacket &mp) override;
};
#endif
