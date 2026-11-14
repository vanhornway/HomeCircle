// Messages sent through a tracker over the mesh, until the server has them:
// the conversation shows them as "Sent over mesh via UT2" until the home base
// passes them on and they arrive like any message (with the same id).
import { useSyncExternalStore } from 'react';
import { ApiError, type CircleClient } from '@homecircle/core';
import { sendThroughTracker } from './meshRadio';
import { homeBaseOf, trackerList } from './trackers';
import { pairedNow } from './pairedTracker';

export type MeshOutboxItem = { id: string; circle: string; peer: string | null; text: string; at: number; via: string };

let items: MeshOutboxItem[] = [];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The pending mesh messages in one conversation, oldest first. */
export function useMeshOutbox(client: CircleClient, peer: string | null): MeshOutboxItem[] {
  const all = useSyncExternalStore(subscribe, () => items);
  const arrived = new Set(client.messages.map((m) => m.id));
  return all.filter((x) => x.circle === client.circleId && x.peer === peer && !arrived.has(x.id));
}

/**
 * The tracker this person carries, if the circle has Meshtastic trackers:
 * messages can go through it. The one paired with this phone first (if it's
 * one of the circle's), else the one the circle says they carry.
 */
export function myTracker(client: CircleClient): { id: string; name: string; node: string } | null {
  if (!client.feature('meshtastic') || !client.account) return null;
  const trackers = trackerList(client);
  const paired = pairedNow();
  const p = paired ? trackers.find((x) => x.tracker.node === paired.node) : null;
  if (p) return { id: p.id, name: p.name, node: p.tracker.node! };
  const mine = trackers.find((x) => x.tracker.mode === 'carried' && x.tracker.carriedBy === client.account!.memberId && x.tracker.node);
  return mine ? { id: mine.id, name: mine.name, node: mine.tracker.node! } : null;
}

/** Whether a send failed because the server can't be reached (no internet, or it's down). */
export function unreachable(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 0 || [502, 503, 504].includes(e.status));
}

/**
 * Seal the message and send it through the tracker; it shows as pending until
 * the server has it. Pass the id it was already tried with over the internet,
 * so if that got through after all, the server keeps one copy.
 */
export async function sendOverMesh(client: CircleClient, text: string, peer: string | null, messageId?: string): Promise<MeshOutboxItem> {
  const tracker = myTracker(client);
  if (!tracker) throw new Error('No tracker of yours to send through.');
  const { id, packet } = await client.meshMessage(text, { to: peer, ...(messageId ? { id: messageId } : {}) });
  await sendThroughTracker(tracker.node, packet, homeBaseOf(client)?.status.node ?? null);
  const item = { id, circle: client.circleId!, peer, text: text.trim(), at: Date.now(), via: tracker.name };
  items = [...items, item];
  changed();
  return item;
}
