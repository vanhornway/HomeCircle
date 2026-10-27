// "Download memory": everything one person can see of the helper's memory, as
// a folder Obsidian opens as a vault. One Markdown file per note (properties
// for its type, dates, people and tags; [[links]] as the helper writes them),
// calendars also as .ics files, shopping lists and reminders as checklists,
// kept files under Files/ and shown in the notes they belong to, and a Home
// page linking it all. Zipped in parts small enough for the server's file
// limit (most memories fit in one).
import { strToU8, zipSync } from 'fflate';
import { repeatText } from './reminders.js';

const FOLDERS = {
  person: 'People',
  place: 'Places',
  schedule: 'Schedules',
  event: 'Events',
  decision: 'Decisions',
  fact: 'Facts',
  recipe: 'Recipes',
  contact: 'Contacts',
  health: 'Health',
  document: 'Documents',
  trip: 'Trips',
  howto: 'Home manual',
  source: 'Calendars',
};
// Room left in each part for zip headers.
const ENTRY_OVERHEAD = 256;

/** A file name Obsidian and every OS accept (no / \ : * ? " < > | # ^ [ ]). */
export const safeName = (t) =>
  String(t ?? '')
    .replace(/[\\/:*?"<>|#^[\]]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'note';
const yaml = (v) => JSON.stringify(v);
const isoDay = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null);
// Obsidian tags can't have spaces.
const tag = (t) => String(t).trim().replace(/\s+/g, '-');

// Properties per kind of note: [data key, property name].
const PROPERTIES = {
  recipe: [['serves'], ['time']],
  contact: [['role'], ['phone'], ['email'], ['address'], ['hours'], ['website']],
  health: [['kind'], ['dose'], ['schedule'], ['refillBy', 'refill-by']],
  document: [['kind'], ['owner'], ['expires'], ['number_last4', 'number-last4'], ['where']],
  howto: [['every']],
  person: [['role'], ['sizes'], ['gifts'], ['favourites']],
};

/**
 * A note's dates for a calendar: a calendar's own events; a trip's days and
 * each leg that has a date; when a document expires; when a refill is due.
 */
export function noteEvents(n) {
  if (Array.isArray(n.data?.events)) return n.data.events;
  const out = [];
  if (n.type === 'trip' && n.start) {
    out.push({ uid: `${n.id}-trip`, summary: n.title, start: n.start, end: n.end || n.start, allDay: true });
    (n.data?.legs ?? []).forEach((l, i) => {
      const m = String(l.at || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
      if (!m) return;
      const what = [l.kind === 'other' ? null : l.kind, l.from && l.to ? `${l.from} to ${l.to}` : l.from || l.to].filter(Boolean).join(' ');
      out.push({ uid: `${n.id}-leg${i}`, summary: `${what || n.title}${l.confirmation ? ` (${l.confirmation})` : ''}`, start: m[1], end: m[1], time: m[2] ?? null, allDay: !m[2] });
    });
  }
  if (n.type === 'document' && n.data?.expires) out.push({ uid: `${n.id}-expires`, summary: `${n.title} expires`, start: n.data.expires, end: n.data.expires, allDay: true });
  if (n.type === 'health' && n.data?.refillBy) out.push({ uid: `${n.id}-refill`, summary: `${n.title}: refill by`, start: n.data.refillBy, end: n.data.refillBy, allDay: true });
  return out;
}

/** One note as Markdown with front matter. */
function noteMarkdown(n, { files, calendarPath }) {
  const front = [
    ['type', n.type],
    ['scope', n.scope === 'circle' ? 'circle' : 'private'],
    ['start', n.start],
    // What its kind keeps (a recipe's serving size, a contact's phone…), as Obsidian properties.
    ...(PROPERTIES[n.type] ?? []).map(([k, name]) => [name ?? k, n.data?.[k] ?? null]),
    ['end', n.end && n.end !== n.start ? n.end : null],
    // As links, so Obsidian's graph and backlinks connect each note to its people.
    ['people', n.people?.length ? n.people.map((p) => `[[${p}]]`) : null],
    ['tags', n.tags?.length ? n.tags.map(tag) : null],
    ['source', n.source],
    ['created', isoDay(n.createdAt)],
    ['updated', isoDay(n.updatedAt)],
    // A title that couldn't be the file name stays findable by its links.
    ['aliases', safeName(n.title) !== n.title ? [n.title] : null],
    ['homecircle-id', n.id],
  ].filter(([, v]) => v != null && v !== '');
  const lines = ['---', ...front.map(([k, v]) => `${k}: ${yaml(v)}`), '---', '', `# ${n.title}`, '', n.body || ''];
  // A recipe whose text has no ingredients list still gets one from its data.
  const ingredients = n.type === 'recipe' && !/^(?:#{1,4}\s*)?ingredients\b/im.test(n.body || '') ? n.data?.ingredients : null;
  if (Array.isArray(ingredients) && ingredients.length) lines.push('', '## Ingredients', '', ...ingredients.map((i) => `- ${i}`));
  const legs = n.type === 'trip' ? n.data?.legs : null;
  if (Array.isArray(legs) && legs.length) {
    lines.push('', '## Legs', '');
    for (const l of legs) lines.push(`- ${[l.kind, l.from && l.to ? `${l.from} → ${l.to}` : l.from || l.to, l.at && `leaves ${l.at}`, l.arrives && `arrives ${l.arrives}`, l.confirmation && `confirmation ${l.confirmation}`].filter(Boolean).join(', ')}`);
  }
  const events = noteEvents(n);
  if (Array.isArray(events) && events.length) {
    lines.push('', '## Dates', '');
    for (const e of events) lines.push(`- ${e.start}${e.end && e.end !== e.start ? ` to ${e.end}` : ''}${e.time ? ` ${e.time}` : ''}: ${e.summary}${e.off ? ' (off)' : ''}`);
    if (calendarPath) lines.push('', `Calendar file: [[${calendarPath}]]`);
  }
  if (n.data?.url) lines.push('', `From: ${n.data.url}`);
  const file = n.data?.file && files.get(n.data.file.id);
  if (file) lines.push('', '## File', '', `![[${file.path}]]`);
  return `${lines.join('\n').trimEnd()}\n`;
}

const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDay = (d) => d.replaceAll('-', '');
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** A calendar note's dates as an .ics file any calendar app imports. */
export function calendarIcs(n, now) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HomeCircle//Memory download//EN', `X-WR-CALNAME:${icsText(n.title)}`];
  noteEvents(n).forEach((e, i) => {
    const timed = e.time && e.allDay === false && /^\d{2}:\d{2}/.test(e.time);
    out.push(
      'BEGIN:VEVENT',
      `UID:${icsText(e.uid ?? `${n.id}-${i}`)}@homecircle`,
      `DTSTAMP:${stamp}`,
      // A timed event keeps its clock time where it happens (floating).
      timed ? `DTSTART:${icsDay(e.start)}T${e.time.slice(0, 5).replace(':', '')}00` : `DTSTART;VALUE=DATE:${icsDay(e.start)}`,
      ...(timed ? [] : [`DTEND;VALUE=DATE:${icsDay(nextDay(e.end || e.start))}`]),
      `SUMMARY:${icsText(e.summary)}`,
      'END:VEVENT',
    );
  });
  out.push('END:VCALENDAR');
  return `${out.join('\r\n')}\r\n`;
}

/** A shopping list as a checklist, with the usual items under it. */
function listMarkdown(list) {
  const lines = ['---', 'type: "shopping-list"', '---', '', `# ${list.name}`, ''];
  if (!list.items.length) lines.push('Nothing on it right now.');
  for (const i of list.items) lines.push(`- [${i.ticked ? 'x' : ' '}] ${i.name}`);
  if (list.usual?.length) {
    lines.push('', '## Usually bought', '');
    for (const u of list.usual) lines.push(`- ${u.name} (${u.count} times)`);
  }
  return `${lines.join('\n')}\n`;
}

function remindersMarkdown(reminders) {
  const lines = ['---', 'type: "reminders"', '---', '', '# Reminders', ''];
  if (!reminders.length) lines.push('None.');
  const sorted = [...reminders].sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due));
  for (const r of sorted) lines.push(`- [${r.done ? 'x' : ' '}] ${r.title}: due ${r.due}${repeatText(r) ? `, ${repeatText(r)}` : ''}${r.note ? `. ${r.note}` : ''}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The vault's files: { text: { path: string }, attachments: [{ path, bytes }] }.
 *   notes: what this person can see (memory.list({ by }))
 *   lists: viewList() of each shopping list; reminders: the reminders
 *   files: kept files read back, [{ id, name, bytes }]; missing: names that couldn't be
 */
export function exportVault({ notes, lists = [], reminders = [], files = [], missing = [], who, helper, circle, now }) {
  const text = {};
  const used = new Set();
  const place = (folder, name, ext) => {
    let path = `${folder ? `${folder}/` : ''}${safeName(name)}${ext}`;
    for (let i = 2; used.has(path.toLowerCase()); i++) path = `${folder ? `${folder}/` : ''}${safeName(name)} ${i}${ext}`;
    used.add(path.toLowerCase());
    return path;
  };

  // Kept files first, so notes can show them.
  const byId = new Map();
  const attachments = [];
  for (const f of files) {
    const path = place('Files', f.name.replace(/\.[^.]+$/, ''), (f.name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase());
    byId.set(f.id, { path });
    attachments.push({ path, bytes: f.bytes });
  }

  const index = {};
  for (const n of [...notes].sort((a, b) => a.title.localeCompare(b.title))) {
    const folder = FOLDERS[n.type] ?? 'Notes';
    const path = place(folder, n.title, '.md');
    let calendarPath = null;
    if (noteEvents(n).length) {
      calendarPath = place(folder, n.title, '.ics');
      text[calendarPath] = calendarIcs(n, now);
    }
    text[path] = noteMarkdown(n, { files: byId, calendarPath });
    (index[folder] ??= []).push(path.slice(folder.length + 1, -3));
  }
  const listPaths = lists.map((l) => {
    const path = place('Lists', l.name, '.md');
    text[path] = listMarkdown(l);
    return path;
  });
  if (reminders.length) text['Reminders.md'] = remindersMarkdown(reminders);

  const day = isoDay(now);
  const home = [`# ${helper}’s memory`, '', `Downloaded ${day} by ${who}${circle ? ` from ${circle}` : ''}: everything ${who} can see.`, ''];
  for (const folder of Object.values(FOLDERS).concat('Notes')) {
    if (!index[folder]) continue;
    home.push(`## ${folder}`, '', ...index[folder].map((t) => `- [[${folder}/${t}|${t}]]`), '');
  }
  if (listPaths.length) home.push('## Shopping lists', '', ...listPaths.map((p) => `- [[${p.slice(0, -3)}|${p.slice(6, -3)}]]`), '');
  if (reminders.length) home.push('## Reminders', '', '- [[Reminders]]', '');
  text['Home.md'] = `${home.join('\n').trimEnd()}\n`;

  const readme = [
    `# ${helper}’s memory, downloaded ${day}`,
    '',
    `This folder is everything ${helper} remembers that ${who} can see: the circle’s notes and ${who}’s private ones. Other people’s private notes aren’t in it.`,
    '',
    '- **Open it in Obsidian:** unzip it (every part into the same folder, if there are several), then Open folder as vault. Start at Home.',
    '- **Notes** are Markdown, one per thing remembered, in folders by kind. People and places are linked as [[Name]], so the graph view shows who is connected to what.',
    '- **Properties** on each note: its kind, dates, people, tags, when it was made and changed, and whether it’s for the circle or private.',
    '- **Calendars** are also .ics files, which any calendar app imports.',
    '- **Shopping lists and reminders** are checklists under Lists and in Reminders.',
    '- **Files** you chose to keep are under Files, and shown in the notes they belong to.',
  ];
  if (missing.length) readme.push('', `These kept files couldn’t be read back from the server and aren’t included: ${missing.join(', ')}.`);
  text['README.md'] = `${readme.join('\n')}\n`;
  return { text, attachments };
}

/**
 * The vault zipped into parts of at most `partBytes`: notes, calendars, lists
 * and reminders in the first, kept files filling it and then further parts.
 * A file too big for any part is left out (and named in `tooBig`).
 */
export function zipVault({ text, attachments }, { partBytes, name }) {
  const first = {};
  let size = 0;
  for (const [path, s] of Object.entries(text)) {
    first[path] = strToU8(s);
    size += first[path].length + ENTRY_OVERHEAD;
  }
  const parts = [{ entries: Object.fromEntries(Object.entries(first).map(([p, b]) => [p, [b, { level: 6 }]])), size }];
  const tooBig = [];
  for (const a of [...attachments].sort((x, y) => y.bytes.length - x.bytes.length)) {
    const need = a.bytes.length + ENTRY_OVERHEAD;
    if (need > partBytes) {
      tooBig.push(a.path);
      continue;
    }
    // Already compressed (photos, PDFs): stored as they are.
    let part = parts.find((p) => p.size + need <= partBytes);
    if (!part) parts.push((part = { entries: {}, size: 0 }));
    part.entries[a.path] = [a.bytes, { level: 0 }];
    part.size += need;
  }
  return {
    tooBig,
    parts: parts.map((p, i) => ({ name: parts.length === 1 ? `${name}.zip` : `${name} (part ${i + 1} of ${parts.length}).zip`, bytes: zipSync(p.entries) })),
  };
}
