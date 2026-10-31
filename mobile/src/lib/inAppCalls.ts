// The hook for in-app calling. WhatsApp is how the family calls today; a call
// room built into HomeCircle (WebRTC, built separately) plugs in here by
// registering itself once at start-up:
//
//   registerInAppCalls({ startGroup: (client) => router.push(…) });
//
// and the group call sheet then offers it beside WhatsApp, with nothing else
// to change. Until something registers, the offer doesn't appear.
import type { CircleClient } from '@homecircle/core';

export interface InAppCalls {
  /** Open (or start) the circle's in-app call room. */
  startGroup(client: CircleClient): void;
}

let provider: InAppCalls | null = null;

export const registerInAppCalls = (p: InAppCalls | null) => {
  provider = p;
};

export const inAppCalls = (): InAppCalls | null => provider;
