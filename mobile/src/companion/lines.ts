// What she hears, and the same line written in Urdu for the screen. Every
// clip and its Urdu text come from assets/clips/clips.json (one source).
import clips from '../../assets/clips/clips.json';
import type { CallbackReply } from '@homecircle/core';
import { playSequence, stopSequence } from '../../modules/hc-attention/src/HcAttentionModule';

export type Gender = 'm' | 'f';
type Clip = { id: string; ur: string | Record<Gender, string>; variants: string[] };
const BY_ID = new Map((clips.clips as Clip[]).map((c) => [c.id, c]));

export const REPLY_CLIP: Record<CallbackReply, string> = { now: 'cb_now', '5min': 'cb_5min', morning: 'cb_morning', evening: 'cb_evening' };

/** One line: a clip, the person it's about (their he/she picks the recording), and their name. */
export type Line = { id: string; g?: Gender; name?: string };

/** The res/raw name of a line's recording. */
export function clipName({ id, g }: Line): string {
  const c = BY_ID.get(id);
  return c?.variants.length ? `ur_${id}_${g ?? 'm'}` : `ur_${id}`;
}

/** The line in Urdu, with the person's name in place of [نام]. */
export function urdu({ id, g, name }: Line): string {
  const c = BY_ID.get(id);
  if (!c) return '';
  const text = typeof c.ur === 'string' ? c.ur : c.ur[g ?? 'm'];
  return text.replace('[نام]', name ?? '').trim();
}

/**
 * Say lines one after the other. A person's own name clip (recorded by an
 * admin, coming later) will play before a line about them; until then the
 * line plays alone while the screen shows who it's about.
 */
export function say(...lines: Line[]): boolean {
  return playSequence(lines.map(clipName));
}

export function hush() {
  stopSequence();
}
