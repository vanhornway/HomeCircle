// Where her latest call-back request in a circle stands, for the banner on
// her page, the badges on the tiles and what she hears.
import type { CallbackReply, CallbackState, CircleClient } from '@homecircle/core';
import { genderOf } from './people';
import { REPLY_CLIP, type Line } from './lines';

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
  if (s.takenBy) return { id: 'cb_now', g: genderOf(client, s.takenBy.memberId), name: s.takenBy.name };
  const last = s.replies.at(-1);
  if (last) return replyLine(client, last.memberId, last.name, last.reply);
  if (s.for?.length === 1) return { id: 'cb_sent_one', name: client.members.get(s.for[0])?.name ?? '' };
  return { id: 'cb_sent_all' };
}

export function replyLine(client: CircleClient, memberId: string, name: string, reply: CallbackReply): Line {
  return { id: REPLY_CLIP[reply], g: genderOf(client, memberId), name };
}

/** Each person's answer on her tiles: memberId -> reply. */
export function tileReplies(s: CallbackState | null): Map<string, CallbackReply> {
  return new Map(s ? s.replies.map((r) => [r.memberId, r.reply]) : []);
}
