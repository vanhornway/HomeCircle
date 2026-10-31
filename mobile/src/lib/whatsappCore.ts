// WhatsApp links, as plain functions with no React Native in them (checked with
//   node --test --experimental-strip-types src/lib/*.test.ts ).
// whatsapp.ts opens what these build.

/** Why a phone number was refused. */
export type NumberProblem = 'empty' | 'letters' | 'no_country_code' | 'too_short' | 'too_long' | 'bad_country_code';

export type NumberResult = { ok: true; digits: string } | { ok: false; problem: NumberProblem };

/** What to tell the person for each problem. */
export const NUMBER_PROBLEMS: Record<NumberProblem, string> = {
  empty: 'There is no phone number yet.',
  letters: 'A phone number has only digits (and spaces, hyphens or brackets).',
  no_country_code: 'Add the country code at the start, such as +1 for the US or +92 for Pakistan. A number that starts with 0 is a local one.',
  too_short: 'That number is too short.',
  too_long: 'That number is too long.',
  bad_country_code: 'That country code isn’t valid. Country codes never start with 0.',
};

const MIN_DIGITS = 8; // the shortest international numbers
const MAX_DIGITS = 15; // E.164

/**
 * A phone number as WhatsApp wants it: digits only, country code first, no
 * "+", spaces, hyphens, dots or brackets ("+92 (300) 123-4567" → "923001234567").
 * A leading "00" counts as "+". A number with neither is a local one: it is
 * refused with `no_country_code`, never guessed at, because the wrong guess
 * rings a stranger.
 */
export function cleanNumber(raw: unknown): NumberResult {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, problem: 'empty' };
  const t = raw.trim();
  // "ext." and the like are letters too; a number with one can't be dialled as is.
  if (/\p{L}/u.test(t) || /[^\d\s()\-.+‐-― ]/u.test(t)) return { ok: false, problem: 'letters' };
  const plus = (t.match(/\+/g) ?? []).length;
  if (plus > 1 || (plus === 1 && !t.startsWith('+'))) return { ok: false, problem: 'no_country_code' };
  let digits = t.replace(/\D/g, '');
  if (!digits) return { ok: false, problem: 'empty' };
  if (plus === 0) {
    if (!digits.startsWith('00')) return { ok: false, problem: 'no_country_code' };
    digits = digits.slice(2);
  }
  if (digits.startsWith('0')) return { ok: false, problem: 'bad_country_code' };
  if (digits.length < MIN_DIGITS) return { ok: false, problem: 'too_short' };
  if (digits.length > MAX_DIGITS) return { ok: false, problem: 'too_long' };
  return { ok: true, digits };
}

/** WhatsApp ignores a prefilled line past a few thousand characters; keep it well under any URL limit. */
const MAX_TEXT = 1000;

/** The app link and the web link that open a chat with this number (digits from cleanNumber), with an optional first line. */
export function chatUrls(digits: string, text?: string | null): { app: string; web: string } {
  const line = (text ?? '').trim().slice(0, MAX_TEXT);
  const app = `whatsapp://send?phone=${digits}${line ? `&text=${encodeURIComponent(line)}` : ''}`;
  const web = `https://wa.me/${digits}${line ? `?text=${encodeURIComponent(line)}` : ''}`;
  return { app, web };
}

/**
 * A WhatsApp call link as kept: https://call.whatsapp.com/video/… or /voice/…
 * Anything else (another host, plain http, a look-alike such as
 * call.whatsapp.com.evil.com, a login in the address, extra path) is null, and
 * a query or fragment is dropped. The same rule as `cleanCallLink` in
 * @homecircle/core, which seals the link for the circle.
 */
export function cleanCallUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  const m = /^https:\/\/call\.whatsapp\.com\/(video|voice)\/([A-Za-z0-9_-]{8,64})\/?(?:[?#]\S*)?$/.exec(raw.trim());
  return m ? `https://call.whatsapp.com/${m[1]}/${m[2]}` : null;
}

/** Where to get WhatsApp: the Play Store app first, then its web page; the App Store on iOS. */
export function storeUrls(os: 'ios' | 'android' | string): string[] {
  if (os === 'ios') return ['https://apps.apple.com/app/whatsapp-messenger/id310633997'];
  return ['market://details?id=com.whatsapp', 'https://play.google.com/store/apps/details?id=com.whatsapp'];
}
