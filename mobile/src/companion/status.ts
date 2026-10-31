// Where her latest call-back request in a circle stands, for the banner on
// her page, the badges on the tiles and what she hears.
import type { CallbackAnswer, CallbackState, CircleClient } from '@homecircle/core';
import { genderOf, tileName } from './people';
import type { Line } from './lines';

/** The phrase each reply plays. */
export const REPLY_PHRASE: Record<CallbackAnswer, string> = { now: 'reply.calling_now', '5min': 'reply.five_min', morning: 'reply.morning', evening: 'reply.evening', asleep: 'asleep.one' };

// The banner at the top (and the answers on the tiles) show the latest thing
// that happened to her request, this long. After that the page goes back to
// normal and she can ask again, so she's never unsure when it was done.
export const SHOWN_MS = 2 * 60_000;

/** When the latest thing happened to a request: her asking, or the newest answer. */
export const lastActivity = (s: CallbackState) => Math.max(s.ts, ...s.replies.map((r) => r.ts));

/** Her latest request in this circle, for the two minutes after it was sent or answered. */
export function currentRequest(client: CircleClient, now = Date.now()): CallbackState | null {
  const me = client.account?.memberId;
  const last = [...client.messages].reverse().find((m) => m.from === me && !m.peer && m.body?.callback?.state === 'ask');
  const s = last ? client.callbackState(last.id) : null;
  return s && now - lastActivity(s) < SHOWN_MS ? s : null;
}

/** What the banner says (and she hears) about a request. */
export function statusLine(client: CircleClient, s: CallbackState): Line {
  if (s.takenBy) return { key: 'reply.calling_now', g: genderOf(client, s.takenBy.memberId), name: tileName(client, s.takenBy.memberId) };
  const last = s.replies.at(-1);
  if (last) return replyLine(client, last.memberId, last.name, last.reply);
  if (s.for?.length === 1) return { key: 'sent.one', name: tileName(client, s.for[0]) };
  return { key: 'sent.everyone' };
}

export function replyLine(client: CircleClient, memberId: string, name: string, reply: CallbackAnswer): Line {
  return { key: REPLY_PHRASE[reply], g: genderOf(client, memberId), name: tileName(client, memberId) || name };
}

/** Each person's answer on her tiles: memberId -> reply. */
export function tileReplies(s: CallbackState | null): Map<string, CallbackAnswer> {
  return new Map(s ? s.replies.map((r) => [r.memberId, r.reply]) : []);
}
