// Long-term reminders (car registration, passports, insurance), kept by the
// circle's helper. Anyone adds one; every admin, and whoever added it, is
// told 30, 7 and 1 days before and on the day, then every 3 days after until
// someone marks it done. A yearly one moves to next year when it's done, one
// every few months (a filter to change) that many months on. A private one
// (a refill) is only ever for the person it's for.
import { randomBytes } from 'node:crypto';

export const STAGES = [30, 7, 1, 0];
const NAG_EVERY_DAYS = 3;
const MAX_REMINDERS = 100;
const DAY = 86400_000;
const day = /^\d{4}-\d{2}-\d{2}$/;

const toDate = (d) => new Date(`${d}T00:00:00Z`);
export const daysBetween = (from, to) => Math.round((toDate(to) - toDate(from)) / DAY);
const fmt = (d) => toDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** The same day a year later (Feb 29 → Feb 28). */
export function nextYear(d) {
  const [y, m, dd] = d.split('-').map(Number);
  const last = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return `${y + 1}-${String(m).padStart(2, '0')}-${String(Math.min(dd, last)).padStart(2, '0')}`;
}

/** The same day `months` later (Jan 31 + 1 → Feb 28). */
export function addMonths(d, months) {
  const [y, m, dd] = d.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(dd, last)).padStart(2, '0')}`;
}

export function cleanReminder(r) {
  const title = String(r?.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!title) throw new Error('Say what the reminder is for, like “Car registration”');
  if (!day.test(r?.due ?? '')) throw new Error('Give the date it’s due');
  const months = Math.round(Number(r?.months));
  // Every 12 months is every year.
  const repeat = r.repeat === 'yearly' || (r.repeat === 'months' && months === 12) ? 'yearly' : r.repeat === 'months' && months >= 1 && months <= 60 ? 'months' : 'none';
  return { title, due: r.due, repeat, ...(repeat === 'months' ? { months } : {}), note: String(r?.note || '').slice(0, 300), ...(r?.only ? { only: String(r.only) } : {}) };
}

/** Whether `by` sees a reminder: everyone, unless it's private to someone. */
export const canSeeReminder = (r, by) => !r.only || r.only === by;

export function addReminder(list, r, by, now) {
  if (list.length >= MAX_REMINDERS) throw new Error('That’s a lot of reminders. Mark some done or delete them first.');
  const rem = { id: randomBytes(6).toString('base64url'), ...cleanReminder(r), createdBy: by, createdAt: now, done: false, sent: [], lastNag: null };
  list.push(rem);
  return rem;
}

/**
 * What to send about a reminder today, or null: the latest stage reached
 * (a reminder added 5 days out says "in 5 days" once, not the 30-day one
 * too), or a nag every 3 days once it's late. Marks it as sent.
 */
export function dueMessage(r, today) {
  if (r.done) return null;
  const days = daysBetween(today, r.due);
  if (days < 0) {
    if (r.lastNag && daysBetween(r.lastNag, today) < NAG_EVERY_DAYS) return null;
    r.lastNag = today;
    return `⏰ ${r.title} was due ${-days === 1 ? 'yesterday' : `${-days} days ago`} (${fmt(r.due)}). Late fees may apply. Tap Done once it’s taken care of.`;
  }
  const stage = STAGES.filter((s) => days <= s && !r.sent.includes(s)).at(-1);
  if (stage == null) return null;
  r.sent = [...new Set([...r.sent, ...STAGES.filter((s) => s >= days)])];
  return `⏰ ${r.title} is due ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`} (${fmt(r.due)}).${r.note ? ` ${r.note}` : ''}`;
}

/** Done: a yearly one moves on a year (and starts its reminders again); others are finished. */
export function markDone(r, by, now) {
  if (r.repeat === 'yearly' || r.repeat === 'months') {
    r.due = r.repeat === 'yearly' ? nextYear(r.due) : addMonths(r.due, r.months);
    r.sent = [];
    r.lastNag = null;
  } else {
    r.done = true;
  }
  r.doneBy = by;
  r.doneAt = now;
  return r;
}

/** "every year", "every 3 months", or null. */
export const repeatText = (r) => (r.repeat === 'yearly' ? 'every year' : r.repeat === 'months' ? (r.months === 1 ? 'every month' : `every ${r.months} months`) : null);

export const reminderLine = (r) => `• ${r.title}: ${r.done ? 'done' : fmt(r.due)}${repeatText(r) && !r.done ? ` (${repeatText(r)})` : ''}`;
export { fmt as fmtDue };
