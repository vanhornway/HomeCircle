// What to show for a batch of new messages, as plain functions (no React
// Native), so it can be checked with plain Node:  node --test src/lib/notifyPlan.test.ts
//
// Two things went wrong when Android held a wake-up back until the phone was
// unlocked: every message became its own notification (up to five at once, all
// with a sound), and messages that were minutes old sounded as if they had just
// arrived. Now each conversation gets one notification that is replaced as more
// arrive, only the newest one sounds, and old messages are listed quietly.

/** A message this old no longer deserves a sound: the person will see it on the list. */
export const STALE_MS = 5 * 60_000;
/** With the app open, anything but a live message is history catching up. */
export const ACTIVE_FRESH_MS = 30_000;

export type Candidate = { id: string; seq: number; ts: number; peer?: string | null };

export type NotificationGroup<T extends Candidate> = {
  /** Same id each time, so a newer notification replaces the one for this conversation. */
  identifier: string;
  peer: string | null;
  messages: T[];
  latest: T;
  /** Plays a sound and pops up. At most one group in a batch does. */
  loud: boolean;
};

/** The notification id for one conversation in one circle. */
export const groupIdentifier = (circleId: string, peer: string | null | undefined) => `chat:${circleId}:${peer || 'group'}`;

/** Whether a message arrived recently enough to sound. A clock a bit ahead counts as recent. */
export function isFresh(ts: number, now: number, appActive: boolean) {
  return now - ts <= (appActive ? ACTIVE_FRESH_MS : STALE_MS);
}

/**
 * One group per conversation (the group chat, or one direct message), the one
 * with the newest message first. Only the newest group with a fresh message is
 * loud; the rest are shown quietly.
 */
export function planNotifications<T extends Candidate>(messages: T[], circleId: string, now: number, appActive: boolean): NotificationGroup<T>[] {
  const byConversation = new Map<string, T[]>();
  for (const m of [...messages].sort((a, b) => a.seq - b.seq)) {
    const id = groupIdentifier(circleId, m.peer);
    byConversation.set(id, [...(byConversation.get(id) ?? []), m]);
  }
  const groups = [...byConversation.entries()]
    .map(([identifier, list]) => ({ identifier, peer: list[0].peer || null, messages: list, latest: list[list.length - 1], loud: false }))
    .sort((a, b) => b.latest.seq - a.latest.seq);
  const loud = groups.find((g) => isFresh(g.latest.ts, now, appActive));
  if (loud) loud.loud = true;
  return groups;
}

/** "3 new messages", for the line above the latest one. */
export const countText = (n: number) => (n === 1 ? '' : `${n} new messages`);
