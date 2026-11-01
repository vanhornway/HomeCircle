// The circle's helper in a chat: telling a question for it from a message,
// showing a question without its "/Name", and reading its replies.
//   node --experimental-strip-types --test src/lib/helperChat.test.ts

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The question in a message that starts with the helper's name, else null:
 * "Chirya, remember…", "Hey Chirya: …", "@Chirya …", and the older
 * "/Chirya …", "/Chirya/dream" and "/agent …". The name alone, or a name in
 * the middle of a sentence ("Chirya is cute"), is not a question.
 */
export function helperQuestion(text: string, name: string): string | null {
  const t = text.trim();
  const n = escape(name.trim());
  if (!n) return null;
  const forms = [
    // "/Chirya when…", "/Chirya/dream", "/agent when…".
    new RegExp(`^/(?:${n}|agent)(?:\\s+|/)([\\s\\S]*)$`, 'i'),
    // "@Chirya when…", "@Chirya, when…".
    new RegExp(`^@${n}(?=[\\s,:]|$)[\\s,:]*([\\s\\S]*)$`, 'i'),
    // "Chirya, when…", "Hey Chirya: when…".
    new RegExp(`^(?:(?:hey|hi|ok|okay)\\s+)?${n}\\s*[,:]\\s*([\\s\\S]*)$`, 'i'),
  ];
  for (const re of forms) {
    const m = t.match(re);
    if (m) return m[1].trim() || null;
  }
  return null;
}

/**
 * A question to the helper as it shows in the group: the person's own words.
 * On the wire it's "/Name question" (so older apps still show who it was
 * for); the name may have changed since, so any "/word " is dropped.
 */
export function askedText(text: string, name: string): string {
  const n = escape(name.trim());
  const own = n ? text.match(new RegExp(`^/(?:${n}|agent)(?:\\s+|/)([\\s\\S]*)$`, 'i')) : null;
  if (own) return own[1].trim();
  const any = text.match(/^\/\S+\s+([\s\S]*)$/);
  return any ? any[1].trim() : text;
}

/** A privacy note on a reply: one short line, and the full reason behind a tap. */
export type PrivacyNote = { short: string; full: string };

export type HelperReply = {
  /** The answer itself (empty for a plain "Remembered"). */
  text: string;
  /** "📌 Remembered: A; B" → { verb: 'Remembered', titles: ['A', 'B'] }. */
  kept: { verb: string; titles: string[] } | null;
  /** What saving led to: reminders set up, a reminder it can't set. */
  extra: string[];
  notes: PrivacyNote[];
};

const SHORT_NOTES: [RegExp, string][] = [
  [/^I left out a password/i, 'Left out a password or full number'],
  [/^Health notes are just for you/i, 'Health notes stay private to you'],
];

/** "🔒 Long reason…" → its short line. Unknown notes keep their first sentence. */
function privacyNote(line: string): PrivacyNote {
  const full = line.replace(/^🔒\s*/, '').trim();
  const known = SHORT_NOTES.find(([re]) => re.test(full));
  if (known) return { short: known[1], full };
  const first = full.match(/^[^.:]+/)?.[0]?.trim() || full;
  return { short: first, full };
}

/**
 * The helper's reply, in parts: its answer, what it kept ("📌 Remembered: …"),
 * the lines that follow from keeping it (⏰ reminders) and privacy notes (🔒).
 */
export function parseHelperReply(text: string): HelperReply {
  const out: HelperReply = { text: '', kept: null, extra: [], notes: [] };
  const body: string[] = [];
  let afterKept = false;
  for (const line of text.split('\n')) {
    const kept = line.match(/^📌\s*([^:]+):\s*(.+)$/);
    if (kept && !out.kept) {
      out.kept = { verb: kept[1].trim(), titles: kept[2].split(/;\s*/).map((s) => s.trim()).filter(Boolean) };
      afterKept = true;
    } else if (line.startsWith('🔒')) out.notes.push(privacyNote(line));
    else if (afterKept && line.trim()) out.extra.push(line.trim());
    else if (!afterKept) body.push(line);
  }
  out.text = body.join('\n').trim();
  return out;
}

/** The helper's short status lines ("↩️ Undone.") read as a line across the chat, not a bubble. */
export function isHelperStatusLine(text: string): boolean {
  return /^(↩️ Undone\.|Nothing to undo\.)$/.test(text.trim());
}
