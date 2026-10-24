// The circle agent's thinking, for one circle. It handles what people send
// it, sealed for it: a question, Remember, Undo, a calendar to add, and the
// app's Memory screen. It looks things up in memory and works dates out in
// code; the AI is asked only for what needs words, with names swapped out,
// within the circle's monthly budget. Answers go to each person sealed for
// them: everyone in the group for a group question, only you for a direct one.
import { complete as llmComplete, cleanProviderConfig, LlmError, PROVIDERS } from './llm.js';
import { nameSwapper } from './names.js';
import { calendarUrl, fetchPublic, parseIcs, freeStretches, isDayOff } from './calendar.js';

const DAY = 86400_000;
const iso = (d) => d.toISOString().slice(0, 10);
const URL_RE = /(?:https?|webcals?):\/\/[^\s<>"']+/i;
const GROUPS = { kids: /^(the )?(kids|children|boys|girls)$/i, everyone: /^(everyone|everybody|all of us|the family|family|us)$/i };
const MAX_NOTES_IN_PROMPT = 15;

const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
// "Nov 25–29", or "Dec 19–Jan 3" across months.
const fmtRange = (r) => (r.start === r.end ? fmtDay(r.start) : r.start.slice(0, 7) === r.end.slice(0, 7) ? `${fmtDay(r.start)}–${Number(r.end.slice(8))}` : `${fmtDay(r.start)}–${fmtDay(r.end)}`);
const names = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

// What the AI returns when it reads a message.
const NOTE_ITEM = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['person', 'place', 'schedule', 'event', 'decision', 'fact'] },
    title: { type: 'string' },
    body: { type: 'string' },
    people: { type: 'array', items: { type: 'string' } },
    start: { type: ['string', 'null'] },
    end: { type: ['string', 'null'] },
    role: { type: ['string', 'null'], enum: ['kid', 'adult', null] },
  },
  required: ['type', 'title', 'body', 'people', 'start', 'end', 'role'],
  additionalProperties: false,
};
const UNDERSTAND = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['free_time', 'recall', 'remember', 'other'] },
    people: { type: 'array', items: { type: 'string' } },
    days: { type: ['integer', 'null'] },
    from: { type: ['string', 'null'] },
    to: { type: ['string', 'null'] },
    keywords: { type: 'array', items: { type: 'string' } },
    remember: { type: 'array', items: NOTE_ITEM },
  },
  required: ['intent', 'people', 'days', 'from', 'to', 'keywords', 'remember'],
  additionalProperties: false,
};
const NOTES_ONLY = { type: 'object', properties: { notes: { type: 'array', items: NOTE_ITEM } }, required: ['notes'], additionalProperties: false };

export class Brain {
  /**
   * @param {object} o
   * @param {import('../../../packages/core/src/agent.js').AgentClient} o.agent
   * @param {import('./memory.js').Memory} o.memory
   */
  constructor({ agent, memory, now = () => new Date(), llm = llmComplete, llmOptions = {}, fetchImpl = fetch, allowPrivateFetch = false, log = () => {} }) {
    this.agent = agent;
    this.memory = memory;
    this.now = now;
    this.llm = llm;
    this.llmOptions = llmOptions;
    this.fetchImpl = fetchImpl;
    this.allowPrivateFetch = allowPrivateFetch;
    this.log = log;
    this.queue = Promise.resolve();
  }

  /** Handle one message, one at a time (so notes and budgets don't race). */
  handle(msg) {
    this.queue = this.queue.then(() => this._handle(msg)).catch((e) => this.log('agent: handling failed', e?.message ?? e));
    return this.queue;
  }

  get config() {
    return this.memory.getSetting('config') ?? {};
  }

  get name() {
    return this.config.name || 'Agent';
  }

  today() {
    return iso(this.now());
  }

  // --- people ------------------------------------------------------------

  /** Names people's phones told us ({ id: name }), learned from what they send. */
  people() {
    return this.memory.getSetting('people') ?? {};
  }

  _learn(body) {
    if (!Array.isArray(body.people)) return;
    const known = this.people();
    let changed = false;
    for (const p of body.people) {
      if (typeof p?.id === 'string' && typeof p?.name === 'string' && known[p.id] !== p.name) {
        known[p.id] = p.name.slice(0, 40);
        changed = true;
      }
    }
    if (changed) this.memory.setSetting('people', known);
    if (typeof body.agentName === 'string' && body.agentName && body.agentName !== this.config.name) {
      this.memory.setSetting('config', { ...this.config, name: body.agentName.slice(0, 24) });
    }
  }

  _nameOf(id) {
    return this.people()[id] || 'Someone';
  }

  _idsFor(personNames) {
    const want = new Set(personNames.map((n) => n.toLowerCase()));
    return Object.entries(this.people())
      .filter(([, n]) => want.has(n.toLowerCase()))
      .map(([id]) => id);
  }

  /** Names the AI must never see: everyone in the circle, people and places in memory. */
  _swapper(by) {
    const people = new Set(Object.values(this.people()));
    const places = new Set();
    for (const n of this.memory.list({ by })) {
      if (n.type === 'person') people.add(n.title);
      if (n.type === 'place') places.add(n.title);
      for (const p of n.people) people.add(p);
    }
    return nameSwapper({ people: [...people], places: [...places] });
  }

  // --- talking back ------------------------------------------------------

  /** Answer where the message came from: everyone in the group, or only the sender. */
  async reply(msg, text, extra = {}) {
    const body = { text, ...extra };
    if (msg.body.thread === 'group') {
      for (const p of this.agent.people()) await this.agent.send(p.id, { ...body, thread: 'group', replyTo: msg.body.replyTo ?? null }).catch((e) => this.log('agent: send failed', e.message));
    } else {
      await this.agent.send(msg.from, { ...body, thread: 'dm' });
    }
  }

  async _rpcReply(msg, ok, data) {
    await this.agent.send(msg.from, { rpcResult: { id: msg.body.rpc.id, ok, ...(ok ? { data } : { error: data }) }, thread: 'dm', agentCopy: true });
  }

  // --- the AI, within budget ---------------------------------------------

  _provider() {
    const c = this.config;
    if (!c.provider) return null;
    try {
      return cleanProviderConfig(c.provider);
    } catch {
      return null;
    }
  }

  /** Room left this month: null if no budget is set. */
  _budgetLeft() {
    const budget = Number(this.config.budgetUsd);
    if (!Number.isFinite(budget) || budget <= 0) return null;
    return budget - this.memory.spent(this.now()).total;
  }

  _outOfBudget() {
    const left = this._budgetLeft();
    return left != null && left <= 0;
  }

  _nextMonth() {
    const d = this.now();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  async _ai(by, args) {
    const provider = this._provider();
    if (!provider) throw new BrainError(`I’m not set up yet: an admin needs to add an AI provider in the ${this.name} settings.`);
    if (this._outOfBudget()) throw new BrainError(`I’m out of budget until ${this._nextMonth()}. Ask an admin to raise it.`);
    const res = await this.llm(provider, args, this.llmOptions);
    this.memory.spend(by, res.usd, this.now());
    await this._warnIfNearBudget();
    if (res.refused) throw new BrainError('I can’t help with that one.');
    return res;
  }

  /** Admins hear once a month when 80% of the budget is spent. */
  async _warnIfNearBudget() {
    const budget = Number(this.config.budgetUsd);
    if (!(budget > 0)) return;
    const month = iso(this.now()).slice(0, 7);
    const spent = this.memory.spent(this.now()).total;
    if (spent < 0.8 * budget || this.memory.getSetting('warned') === month) return;
    this.memory.setSetting('warned', month);
    for (const p of this.agent.people().filter((m) => this.agent.isAdmin(m.id))) {
      await this.agent
        .send(p.id, { text: `Heads-up: ${this.name} has used $${spent.toFixed(2)} of its $${budget.toFixed(2)} budget this month.`, thread: 'dm' })
        .catch(() => {});
    }
  }

  // --- routing -----------------------------------------------------------

  async _handle(msg) {
    const b = msg.body || {};
    this._learn(b);
    try {
      if (b.rpc) return await this._rpc(msg);
      if (b.undo) return await this._undo(msg, b.undo);
      if (b.remember) return await this._remember(msg);
      if (typeof b.ask === 'string') return await this._ask(msg);
    } catch (e) {
      if (b.rpc) return this._rpcReply(msg, false, e instanceof BrainError || e instanceof LlmError ? e.message : 'Something went wrong');
      const text = e instanceof BrainError || e instanceof LlmError ? e.message : 'Sorry, something went wrong on my side.';
      if (!(e instanceof BrainError || e instanceof LlmError)) this.log('agent: error', e?.stack ?? e);
      return this.reply(msg, text);
    }
  }

  // --- Remember ------------------------------------------------------------

  _scopeFor(msg, explicit) {
    if (explicit === 'private') return msg.from;
    if (explicit === 'circle') return 'circle';
    // In a direct chat with the agent, private unless they say to share.
    return msg.body.thread === 'dm' && !/share (it )?with (the )?(circle|family|everyone)/i.test(msg.body.ask || '') ? msg.from : 'circle';
  }

  _save(items, { scope, by }) {
    return items.map((n) =>
      this.memory.add({ ...n, data: n.role ? { role: n.role } : null, start: /^\d{4}-\d{2}-\d{2}$/.test(n.start ?? '') ? n.start : null, end: /^\d{4}-\d{2}-\d{2}$/.test(n.end ?? '') ? n.end : null }, { scope, by, now: this.now().getTime() }),
    );
  }

  async _remember(msg) {
    const r = msg.body.remember;
    const scope = this._scopeFor(msg, r.scope);
    const at = new Date(Number(r.at) || this.now().getTime());
    let saved;
    if (this._provider() && !this._outOfBudget()) {
      const s = this._swapper(msg.from);
      const res = await this._ai(msg.from, {
        system: this._readerPrompt(),
        messages: [{ role: 'user', content: s.mask(`Keep this message from ${r.by || 'someone'} (sent ${iso(at)}) as notes:\n\n${r.text}`) }],
        schema: NOTES_ONLY,
        maxTokens: 2000,
      });
      const notes = (res.json?.notes ?? []).map((n) => unmaskNote(n, s));
      saved = this._save(notes.length ? notes : [rawNote(r.text, r.by)], { scope, by: msg.from });
    } else {
      // No AI (not set up, or out of budget): keep it as written; it's still found by its words.
      saved = this._save([rawNote(r.text, r.by)], { scope, by: msg.from });
    }
    this.memory.setSetting(`last:${msg.from}`, saved.map((n) => n.id));
    await this.reply(msg, `📌 Remembered: ${saved.map((n) => n.title).join('; ')}`, { undo: saved.map((n) => n.id) });
  }

  async _undo(msg, ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => typeof x === 'string');
    let done = 0;
    for (const id of list) {
      try {
        this.memory.undo(id, { by: msg.from, now: this.now().getTime() });
        done++;
      } catch {
        // already gone, or not theirs to undo
      }
    }
    await this.reply(msg, done ? '↩️ Undone.' : 'Nothing to undo.');
  }

  // --- questions ---------------------------------------------------------

  async _ask(msg) {
    const text = msg.body.ask.trim();
    // Plain commands, no AI needed.
    const url = text.match(URL_RE)?.[0];
    if (url) return this._addSource(msg, url, text.replace(url, ' '));
    if (/^(?:it'?s|its|that'?s|this is)?\s*for\s+(.+)$/i.test(text) && this.memory.getSetting(`pending:${msg.from}`)) return this._finishSource(msg, text.match(/for\s+(.+)$/i)[1]);
    if (/^(list|show)( (me|my|the))? (sources|calendars)\b/i.test(text)) return this._listSources(msg);
    if (/^(usage|budget|spending|how much)\b/i.test(text)) return this._usage(msg);
    if (/^undo\b/i.test(text)) return this._undo(msg, this.memory.getSetting(`last:${msg.from}`) ?? []);
    if (/^forget (the )?(.+)$/i.test(text)) return this._forget(msg, text.match(/^forget (?:the )?(.+)$/i)[1]);

    const s = this._swapper(msg.from);
    const asker = this._nameOf(msg.from);
    const u = await this._ai(msg.from, {
      system: this._readerPrompt(),
      messages: [{ role: 'user', content: s.mask(`${asker} asks: ${text}`) }],
      schema: UNDERSTAND,
      maxTokens: 2000,
    });
    const plan = u.json ?? { intent: 'other', people: [], days: null, from: null, to: null, keywords: [], remember: [] };
    const wanted = (plan.people ?? []).map((p) => s.unmask(p));
    const remember = (plan.remember ?? []).map((n) => unmaskNote(n, s));
    const saved = remember.length ? this._save(remember, { scope: this._scopeFor(msg), by: msg.from }) : [];
    if (saved.length) this.memory.setSetting(`last:${msg.from}`, saved.map((n) => n.id));
    if (plan.intent === 'remember' && saved.length) {
      return this.reply(msg, `📌 Remembered: ${saved.map((n) => n.title).join('; ')}`, { undo: saved.map((n) => n.id) });
    }

    const who = this._resolvePeople(wanted, msg.from);
    const notes = this.memory.lookup({
      text: `${text} ${(plan.keywords ?? []).map((k) => s.unmask(k)).join(' ')}`,
      people: who.map((p) => p.name),
      from: plan.from,
      to: plan.to,
      by: msg.from,
      archived: !!(plan.to && plan.to < this.today()),
    });
    const worked = plan.intent === 'free_time' ? this._freeTime(who, plan.days ?? 1, msg.from) : null;

    const answer = await this._ai(msg.from, {
      system: this._answerPrompt(),
      messages: [{ role: 'user', content: s.mask(this._context(notes, worked, asker, text)) }],
      maxTokens: 1500,
    });
    let out = s.unmask(answer.text).trim() || 'I don’t know yet.';
    if (saved.length) out += `\n\n📌 Remembered: ${saved.map((n) => n.title).join('; ')}`;
    await this.reply(msg, out, saved.length ? { undo: saved.map((n) => n.id) } : {});
  }

  _readerPrompt() {
    const d = this.now();
    return [
      `You read messages a family sends their helper, ${this.name}, and say what each one needs. Today is ${iso(d)} (${d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}).`,
      'People and places appear as stand-ins (Person A, Place 1): copy them exactly as written.',
      'intent: "free_time" when they ask when people are free or available (days = how many days in a row, null if not said); "recall" for a question to answer from what was kept before; "remember" when they tell you something to keep (a fact, a decision, a date, a schedule, who someone is); "other" for anything else.',
      'people: who the message is about, as written ("Person B"), or a group word as written ("kids", "everyone").',
      'from/to: a date range the question is about, YYYY-MM-DD, or null. keywords: a few words to search notes with.',
      'remember: notes to keep, only for things stated as facts or decisions (never for questions). One note per thing; title short; body one or two sentences that link people and places as [[Person A]] or [[Place 1]]. For "Person B and Person C are our kids", one person note each with role "kid". Dates as YYYY-MM-DD.',
    ].join('\n');
  }

  _answerPrompt() {
    return [
      `You are ${this.name}, a helper for one family. Answer briefly (a few sentences), in the language the question is asked in, using only the notes and results given.`,
      'If they don’t answer the question, say so plainly and say what to add (for example, which calendar to share). Never invent dates or facts.',
      'People and places are stand-ins (Person A, Place 1): use them exactly as written. Write dates like "Nov 25–29".',
    ].join('\n');
  }

  _context(notes, worked, asker, question) {
    const lines = ['Notes:'];
    for (const n of notes.slice(0, MAX_NOTES_IN_PROMPT)) {
      const when = n.start ? ` (${n.start === n.end || !n.end ? fmtDay(n.start) : `${fmtDay(n.start)}–${fmtDay(n.end)}`})` : '';
      const role = n.data?.role ? ` [${n.data.role}]` : '';
      lines.push(`- ${n.type}: ${n.title}${role}${when}: ${(n.body || '').slice(0, 600)}`);
    }
    if (notes.length === 0) lines.push('- (none found)');
    if (worked) lines.push('', 'Worked out from calendars:', worked);
    lines.push('', `Today: ${this.today()}`, `Question from ${asker}: ${question}`);
    return lines.join('\n');
  }

  /** "kids" → the person notes marked kid; "everyone" → everyone; names as given. */
  _resolvePeople(wanted, by) {
    const persons = this.memory.list({ by, type: 'person' });
    const out = new Map();
    for (const w of wanted) {
      if (GROUPS.kids.test(w)) for (const p of persons.filter((n) => n.data?.role === 'kid')) out.set(p.title.toLowerCase(), { name: p.title });
      else if (GROUPS.everyone.test(w)) for (const n of new Set([...persons.map((p) => p.title), ...Object.values(this.people())])) out.set(n.toLowerCase(), { name: n });
      else out.set(w.toLowerCase(), { name: w });
    }
    return [...out.values()];
  }

  /** When everyone asked about is free, from their calendars and booked events. */
  _freeTime(who, days, by) {
    if (!who.length) return 'Nobody to check: say who (for example “the kids”), and tell me who the kids are.';
    const sources = this.memory.list({ by, type: 'source' });
    const events = this.memory.list({ by, type: 'event' });
    const missing = [];
    const people = who.map(({ name }) => {
      const key = name.toLowerCase();
      const mine = sources.filter((s) => (s.data?.for ?? []).some((f) => f.toLowerCase() === key));
      const school = mine.filter((s) => s.data?.kind === 'school').flatMap((s) => s.data.events ?? []);
      if (!school.length) missing.push(name);
      const busy = [
        // Other calendars: all-day events block a day; a weekly practice doesn't.
        ...mine.filter((s) => s.data?.kind !== 'school').flatMap((s) => (s.data.events ?? []).filter((e) => e.allDay)),
        ...events.filter((e) => e.start && (e.people.some((p) => p.toLowerCase() === key) || (e.body || '').toLowerCase().includes(`[[${key}]]`))).map((e) => ({ start: e.start, end: e.end || e.start })),
      ];
      return { school, busy };
    });
    const found = freeStretches(people, { days, from: this.today(), limit: 3 });
    const lines = [`Free ${days} day${days === 1 ? '' : 's'} in a row for ${names(who.map((p) => p.name))}: ${found.length ? found.map(fmtRange).join('; ') : 'none in the next year'}.`];
    if (missing.length) lines.push(`No school calendar for ${names(missing)}: their school days aren’t known, so only weekends and booked events count for them.`);
    return lines.join('\n');
  }

  // --- sources (calendars) -------------------------------------------------

  async _addSource(msg, raw, rest) {
    let link;
    try {
      link = calendarUrl(raw);
    } catch (e) {
      throw new BrainError(e.message);
    }
    let doc;
    try {
      doc = await fetchPublic(link.url, { fetchImpl: this.fetchImpl, allowPrivate: this.allowPrivateFetch });
    } catch (e) {
      throw new BrainError(`I couldn’t read that link: ${e.message}.${link.note ? ` ${link.note}` : ''}`);
    }
    const text = doc.bytes.toString('utf8');
    if (!/BEGIN:VCALENDAR/.test(text)) {
      const pdf = /pdf/i.test(doc.type) || doc.bytes.subarray(0, 5).toString() === '%PDF-';
      throw new BrainError(pdf ? 'That’s a PDF. Reading PDFs comes in a later update; share the school’s calendar link (.ics) if it has one.' : 'That link isn’t a calendar I can read. Share its iCal (.ics) or webcal address.');
    }
    const t = this.now();
    // A year back, so a school calendar's first day (months ago) still marks where the school year starts.
    const events = parseIcs(text, { from: iso(new Date(t.getTime() - 365 * DAY)), to: iso(new Date(t.getTime() + 450 * DAY)) });
    if (!events.length) throw new BrainError('That calendar has no events around now.');
    const pending = { url: link.url, events, fetchedAt: t.getTime(), thread: msg.body.thread, replyTo: msg.body.replyTo ?? null, scope: this._scopeFor(msg) };
    const forWho = rest.match(/\bfor\s+([^.?!]+)/i)?.[1];
    if (forWho) return this._storeSource(msg, pending, forWho);
    this.memory.setSetting(`pending:${msg.from}`, pending);
    await this.reply(msg, `I can read it: ${events.length} events. Whose calendar is it? Answer “/${this.name} for Kid” (or “for Kid and Sam”).`);
  }

  async _finishSource(msg, who) {
    const pending = this.memory.getSetting(`pending:${msg.from}`);
    this.memory.setSetting(`pending:${msg.from}`, null);
    return this._storeSource(msg, pending, who);
  }

  async _storeSource(msg, src, who) {
    const forNames = who
      .split(/,|\band\b|&/i)
      .map((s) => s.trim().replace(/^(the|my|our)\s+/i, ''))
      .filter(Boolean)
      .slice(0, 8);
    const offDays = src.events.filter((e) => isDayOff(e.summary));
    const kind = offDays.length >= 3 ? 'school' : 'calendar';
    const label = `${names(forNames)}’s ${kind === 'school' ? 'school calendar' : 'calendar'}`;
    const note = this.memory.add(
      {
        type: 'source',
        title: label,
        body: `${kind === 'school' ? 'School calendar' : 'Calendar'} for ${forNames.map((n) => `[[${n}]]`).join(', ')}.`,
        people: forNames,
        data: { url: src.url, kind, for: forNames, events: src.events, fetchedAt: src.fetchedAt },
        source: 'calendar link',
      },
      { scope: src.scope, by: msg.from, now: this.now().getTime() },
    );
    const next = (kind === 'school' ? offDays : src.events).find((e) => e.end >= this.today());
    const detail = kind === 'school' ? `${offDays.length} days off listed` : `${src.events.length} events`;
    await this.reply(
      { ...msg, body: { ...msg.body, thread: src.thread, replyTo: src.replyTo } },
      `📅 Added ${label}: ${detail}${next ? `; next: ${next.summary} (${fmtRange(next)})` : ''}. I’ll check it for changes every 6 hours.`,
      { undo: [note.id] },
    );
  }

  async _listSources(msg) {
    const list = this.memory.list({ by: msg.from, type: 'source' });
    await this.reply(msg, list.length ? `Calendars I read:\n${list.map((s) => `• ${s.title} (checked ${fmtDay(iso(new Date(s.data?.fetchedAt ?? s.updatedAt)))})`).join('\n')}` : 'No calendars yet. Send me a calendar link to add one.');
  }

  async _forget(msg, what) {
    const hit = this.memory.lookup({ text: what, by: msg.from, archived: true, limit: 1 })[0];
    if (!hit) return this.reply(msg, `I don’t have anything about “${what}”.`);
    this.memory.remove(hit.id, { by: msg.from, now: this.now().getTime() });
    await this.reply(msg, `🗑️ Forgot: ${hit.title}`, { undo: [hit.id] });
  }

  async _usage(msg) {
    const spent = this.memory.spent(this.now());
    const budget = Number(this.config.budgetUsd) || 0;
    const lines = [`This month: $${spent.total.toFixed(2)}${budget ? ` of $${budget.toFixed(2)}` : ''}.`];
    if (this.agent.isAdmin(msg.from)) {
      for (const [id, usd] of Object.entries(spent.byMember).sort((a, b) => b[1] - a[1])) lines.push(`• ${this._nameOf(id)}: $${usd.toFixed(2)}`);
    }
    await this.reply(msg, lines.join('\n'));
  }

  /**
   * Re-read calendars that are due (every 6 hours). Tells the people a
   * calendar is for, and whoever added it, what changed ahead.
   */
  async refreshSources({ everyMs = 6 * 3600_000 } = {}) {
    const now = this.now().getTime();
    for (const src of this.memory.list({ by: '*', type: 'source' }).concat(this._privateSources())) {
      const d = src.data;
      if (!d?.url || now - (d.fetchedAt ?? 0) < everyMs) continue;
      let events;
      try {
        const doc = await fetchPublic(d.url, { fetchImpl: this.fetchImpl, allowPrivate: this.allowPrivateFetch });
        events = parseIcs(doc.bytes.toString('utf8'), { from: iso(new Date(now - 365 * DAY)), to: iso(new Date(now + 450 * DAY)) });
      } catch (e) {
        this.log('agent: calendar refresh failed', e.message);
        continue;
      }
      const key = (e) => `${e.uid}|${e.start}|${e.end}|${e.summary}`;
      const before = new Set((d.events ?? []).map(key));
      const after = new Set(events.map(key));
      const today = this.today();
      const added = events.filter((e) => !before.has(key(e)) && e.end >= today);
      const removed = (d.events ?? []).filter((e) => !after.has(key(e)) && e.end >= today);
      this.memory.update(src.id, { data: { ...d, events, fetchedAt: now } }, { by: src.scope === 'circle' ? src.createdBy : src.scope, now });
      if (!added.length && !removed.length) continue;
      const parts = [
        ...added.slice(0, 5).map((e) => `added “${e.summary}” (${fmtRange(e)})`),
        ...removed.slice(0, 5).map((e) => `removed “${e.summary}” (${fmtRange(e)})`),
      ];
      const text = `📅 ${src.title} changed: ${parts.join('; ')}${added.length + removed.length > 10 ? '; and more' : ''}.`;
      const to = new Set([...(src.scope === 'circle' ? this._idsFor(d.for ?? []) : []), src.createdBy].filter(Boolean));
      for (const id of to) await this.agent.send(id, { text, thread: 'dm' }).catch(() => {});
    }
  }

  _privateSources() {
    // Private calendars: one person's own notes.
    return Object.keys(this.people()).flatMap((id) => this.memory.list({ by: id, type: 'source' }).filter((n) => n.scope === id));
  }

  // --- the app's Memory screen and settings ----------------------------------

  async _rpc(msg) {
    const { op, args = {} } = msg.body.rpc;
    const by = msg.from;
    const brief = (n) => ({ ...n, data: n.data?.events ? { ...n.data, url: undefined, events: undefined, count: n.data.events.length } : n.data });
    const now = this.now().getTime();
    const adminOnly = () => {
      if (!this.agent.isAdmin(by)) throw new BrainError('Only circle admins can do that');
    };
    switch (op) {
      case 'list':
        return this._rpcReply(msg, true, this.memory.list({ by, type: args.type ?? null }).map(brief));
      case 'search':
        return this._rpcReply(msg, true, this.memory.lookup({ text: String(args.text || ''), by, archived: true }).map(brief));
      case 'get': {
        const n = this.memory.get(args.id, { by });
        if (!n) throw new BrainError('No such note');
        const linked = this.memory.lookup({ people: [n.title], by, hops: 0, limit: 20 }).filter((x) => x.id !== n.id);
        return this._rpcReply(msg, true, { note: brief(n), history: this.memory.history(n.id, { by }).map((h) => ({ ...h, by: this._nameOf(h.by) })), linked: linked.map(brief) });
      }
      case 'update':
        return this._rpcReply(msg, true, brief(this.memory.update(args.id, pick(args.patch, ['title', 'body', 'people', 'start', 'end', 'type']), { by, now })));
      case 'add':
        return this._rpcReply(msg, true, brief(this.memory.add(pick(args.note, ['title', 'body', 'people', 'start', 'end', 'type']), { scope: args.private ? by : 'circle', by, now })));
      case 'remove':
        this.memory.remove(args.id, { by, now });
        return this._rpcReply(msg, true, null);
      case 'undo':
        return this._rpcReply(msg, true, brief(this.memory.undo(args.id, { by, now }) ?? {}));
      case 'usage': {
        const spent = this.memory.spent(this.now());
        return this._rpcReply(msg, true, {
          total: spent.total,
          budgetUsd: Number(this.config.budgetUsd) || 0,
          byMember: this.agent.isAdmin(by) ? Object.entries(spent.byMember).map(([id, usd]) => ({ name: this._nameOf(id), usd })) : null,
        });
      }
      case 'settings': {
        const p = this.config.provider;
        return this._rpcReply(msg, true, {
          name: this.name,
          provider: p ? { provider: p.provider, model: p.model, baseUrl: p.provider === 'other' ? p.baseUrl : null, inUsd: p.inUsd, outUsd: p.outUsd, keySet: !!p.apiKey } : null,
          budgetUsd: Number(this.config.budgetUsd) || 0,
          providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { name: v.name, models: v.models ?? null, suggested: v.suggested ?? null }])),
        });
      }
      case 'setSettings': {
        adminOnly();
        const next = { ...this.config };
        if (args.provider) {
          // Keep the saved key if the app didn't send a new one.
          const merged = { ...args.provider, apiKey: args.provider.apiKey || (this.config.provider?.provider === args.provider.provider ? this.config.provider.apiKey : '') };
          next.provider = cleanProviderConfig(merged);
        }
        if (args.budgetUsd != null) {
          const b = Number(args.budgetUsd);
          if (!Number.isFinite(b) || b < 0 || b > 10_000) throw new BrainError('Give a monthly budget in dollars');
          next.budgetUsd = b;
        }
        this.memory.setSetting('config', next);
        // A tiny call so a wrong key or model shows up right away.
        if (args.provider && args.test !== false) {
          const res = await this.llm(next.provider, { system: 'Reply with the word OK.', messages: [{ role: 'user', content: 'Test' }], maxTokens: 50 }, this.llmOptions);
          this.memory.spend(by, res.usd, this.now());
        }
        return this._rpcReply(msg, true, { ok: true });
      }
      case 'export':
        // Everything this person can see, as linked Markdown files ({ path: text }).
        return this._rpcReply(msg, true, exportMarkdown(this.memory.list({ by })));
      default:
        throw new BrainError('Unknown request');
    }
  }
}

export class BrainError extends Error {}

function pick(o, keys) {
  return Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));
}

function rawNote(text, by) {
  const t = String(text || '').trim();
  return { type: 'fact', title: t.split('\n')[0].slice(0, 60), body: by ? `${t}\n\n(from ${by})` : t, people: [], start: null, end: null, role: null };
}

function unmaskNote(n, s) {
  return { ...n, title: s.unmask(n.title), body: s.unmask(n.body), people: (n.people ?? []).map((p) => s.unmask(p)) };
}

/** Notes as Markdown files, one per note, for downloading before the agent is removed. */
export function exportMarkdown(notes) {
  const files = {};
  const safe = (t) => t.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'note';
  for (const n of notes) {
    const front = ['---', `type: ${n.type}`, n.start ? `start: ${n.start}` : null, n.end && n.end !== n.start ? `end: ${n.end}` : null, n.people.length ? `people: [${n.people.join(', ')}]` : null, '---', '']
      .filter((l) => l != null)
      .join('\n');
    let path = `${n.type}/${safe(n.title)}.md`;
    for (let i = 2; files[path]; i++) path = `${n.type}/${safe(n.title)} ${i}.md`;
    files[path] = `${front}# ${n.title}\n\n${n.body}\n`;
  }
  return files;
}
