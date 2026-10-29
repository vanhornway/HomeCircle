// Where her latest call-back request in a circle stands, for the banner on
// her page, the badges on the tiles and what she hears.
import type { CallbackReply, CallbackState, CircleClient } from '@homecircle/core';
import { genderOf, tileName } from './people';
import type { Line } from './lines';

/** The phrase each reply plays. */
export const REPLY_PHRASE: Record<CallbackReply, string> = { now: 'reply.calling_now', '5min': 'reply.five_min', morning: 'reply.morning', evening: 'reply.evening' };

// After someone says "I'm calling you now", the page shows it this long.
const TAKEN_SHOWN_MS = 30 * 60_000;

/** Her latest request in this circle while it's open, or just after someone took it. */
export function currentRequest(client: CircleClient, now = Date.now()): CallbackState | null {
  const me = client.account?.memberId;
  const last = [...client.messages].reverse().find((m) => m.from === me && !m.peer && m.body?.callback?.state === 'ask');
  const s = last ? client.callbackState(last.id) : null;
  if (!s) return null;
  return s.open || (s.takenBy && now - s.takenBy.ts < TAKEN_SHOWN_MS) ? s : null;
}

/** What the banner says (and she hears) about a request. */
export function statusLine(client: CircleClient, s: CallbackState): Line {
  if (s.takenBy) return { key: 'reply.calling_now', g: genderOf(client, s.takenBy.memberId), name: tileName(client, s.takenBy.memberId) };
  const last = s.replies.at(-1);
  if (last) return replyLine(client, last.memberId, last.name, last.reply);
  if (s.for?.length === 1) return { key: 'sent.one', name: tileName(client, s.for[0]) };
  return { key: 'sent.everyone' };
}

export function replyLine(client: CircleClient, memberId: string, name: string, reply: CallbackReply): Line {
  return { key: REPLY_PHRASE[reply], g: genderOf(client, memberId), name: tileName(client, memberId) || name };
}

/** Each person's answer on her tiles: memberId -> reply. */
export function tileReplies(s: CallbackState | null): Map<string, CallbackReply> {
  return new Map(s ? s.replies.map((r) => [r.memberId, r.reply]) : []);
}
