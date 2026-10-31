// The helper's reminder messages ("⏰ Car registration is due in 5 days (Nov 5).")
// shown as a card: a title, when it's due, and whether it's late.
//   node --experimental-strip-types --test src/lib/reminderCard.test.ts

export interface ReminderLook {
  title: string;
  /** "Due in 5 days (Nov 5)", "Due today", "Was due 3 days ago (Oct 3)". */
  when: string;
  /** Anything else the message said (the note on it), without the "Tap Done" nudge. */
  note: string;
  late: boolean;
}

/** Reads the helper's reminder text; anything it can't read becomes the title as it is. */
export function parseReminder(text: string): ReminderLook {
  const body = text.replace(/^⏰\s*/, '').trim();
  const m = /^(.+?) (is due|was due) (.+?)(?:\.|$)(?:\s+(.*))?$/s.exec(body);
  if (!m) return { title: body || 'Reminder', when: '', note: '', late: false };
  const late = m[2] === 'was due';
  const note = (m[4] ?? '')
    .replace(/Late fees may apply\.?/i, '')
    .replace(/Tap Done once it[’']s taken care of\.?/i, '')
    .trim();
  return { title: m[1], when: `${late ? 'Was due' : 'Due'} ${m[3]}`, note, late };
}
