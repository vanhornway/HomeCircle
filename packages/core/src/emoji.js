// Emoji data and helpers shared by the web and mobile apps.

/** Shown when long-pressing (mobile) or hovering (web) a message. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** The composer's emoji picker. */
export const EMOJI_GROUPS = [
  {
    name: 'Smileys',
    emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😋', '😜', '🤪', '😎', '🤗', '🤔', '🤨', '😐', '🙄', '😏', '😬', '😌', '😴', '🤒', '🥳', '😮', '😲', '🥺', '😢', '😭', '😤', '😡', '🤯', '😱'],
  },
  {
    name: 'Gestures',
    emojis: ['👍', '👎', '👌', '✌️', '🤞', '🤟', '👋', '🙌', '👏', '🙏', '💪', '🤝', '✋', '👊', '🫶', '🫡'],
  },
  {
    name: 'Hearts',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💕', '💖', '💯', '✨', '🔥', '⭐', '🎉', '🎂'],
  },
  {
    name: 'Everyday',
    emojis: ['🏠', '🏫', '🏢', '🚗', '🚌', '🚲', '✈️', '📍', '🗺️', '⏰', '📱', '🔋', '☕', '🍕', '🍔', '🍎', '🛒', '⚽', '🏀', '🐶', '🐱', '🌧️', '☀️', '🌙'],
  },
];

const RANGES = [
  [0x1f000, 0x1faff], // pictographs, emoticons, transport, symbols & pictographs ext.
  [0x2600, 0x27bf], // misc symbols, dingbats
  [0x2b00, 0x2bff],
  [0x2190, 0x21ff],
  [0x2300, 0x23ff],
  [0x25a0, 0x25ff],
  [0x2900, 0x297f],
  [0x3030, 0x3030],
  [0x303d, 0x303d],
  [0x3297, 0x3299],
  [0x00a9, 0x00a9],
  [0x00ae, 0x00ae],
  [0x203c, 0x203c],
  [0x2049, 0x2049],
  [0x2122, 0x2122],
  [0x2139, 0x2139],
];
// Joiners and modifiers that don't count as separate emoji.
const MODIFIERS = new Set([0x200d, 0xfe0f, 0xfe0e, 0x20e3]);
const isSkinTone = (cp) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const isTag = (cp) => cp >= 0xe0020 && cp <= 0xe007f;

/**
 * True for short messages made only of emoji (e.g. "❤️" or "👍🎉"), which the
 * apps show large. Written without \p{} so it works on every JS engine.
 */
export function isEmojiOnly(text, max = 6) {
  const s = String(text || '').replace(/\s+/g, '');
  if (!s) return false;
  let count = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (MODIFIERS.has(cp) || isSkinTone(cp) || isTag(cp)) continue;
    if (!RANGES.some(([a, b]) => cp >= a && cp <= b)) return false;
    count++;
  }
  return count > 0 && count <= max;
}

export function isValidReaction(emoji) {
  return typeof emoji === 'string' && emoji.length > 0 && emoji.length <= 16 && isEmojiOnly(emoji, 1);
}
