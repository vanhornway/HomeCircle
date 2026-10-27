// The circle agent's thinking, for one circle. It handles what people send
// it, sealed for it: a question, Remember, Undo, a calendar to add, and the
// app's Memory screen. It looks things up in memory and works dates out in
// code; the AI is asked only for what needs words, with names swapped out,
// within the circle's monthly budget. Answers go to each person sealed for
// them: everyone in the group for a group question, only you for a direct one.
import { complete as llmComplete, cleanProviderConfig, LlmError, PROVIDERS } from './llm.js';
import { nameSwapper } from './names.js';
import { cleanTags, recipeIngredients } from './memory.js';
import { createHash, randomBytes } from 'node:crypto';
import { calendarUrl, fetchPublic, parseIcs, freeStretches, isDayOff } from './calendar.js';
import { isPdf, pdfText } from './pdf.js';
import { readFile } from './read-file.js';
import { addItems, createList, doneShopping, emptyLists, findList, itemKey, listText, parseListCommand, recipeWanted, recordBought, removeItems, shoppingName, splitItems, viewList } from './lists.js';
import { addReminder, cleanReminder, dueMessage, fmtDue, markDone, reminderLine } from './reminders.js';
import { exportVault, zipVault } from './export.js';

// A memory download goes up in parts under the server's 15 MB file limit, and
// is deleted an hour later (the phone fetches it straight away).
const EXPORT_PART_BYTES = 14 * 1024 * 1024;
const EXPORT_KEEP_MS = 60 * 60_000;

const DAY = 86400_000;
const iso = (d) => d.toISOString().slice(0, 10);
const URL_RE = /(?:https?|webcals?):\/\/[^\s<>"']+/i;
const GROUPS = { kids: /^(the )?(kids|children|boys|girls)$/i, everyone: /^(everyone|everybody|all of us|the family|family|us)$/i };
const MAX_NOTES_IN_PROMPT = 15;
// What the helper keeps of each chat: the last 10 messages to it and its 10 answers.
const CHAT_KEEP = 20;
// Bytes of an app request's answer per message (a message holds about 12 KB).
const RPC_PART = 8000;
const KID_RE = /^(?:my |our |the )?(?:kid|child|son|daughter)$/i;

const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
// "Nov 25–29", or "Dec 19–Jan 3" across months.
const fmtRange = (r) => (r.start === r.end ? fmtDay(r.start) : r.start.slice(0, 7) === r.end.slice(0, 7) ? `${fmtDay(r.start)}–${Number(r.end.slice(8))}` : `${fmtDay(r.start)}–${fmtDay(r.end)}`);
const names = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

// What the AI returns when it reads a message. Anthropic's structured output
// rejects type lists like ['string', 'null'] next to an enum, so anything
// that may be null is written as anyOf [that type, null].
const orNull = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const NOTE_ITEM = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['person', 'place', 'schedule', 'event', 'decision', 'fact', 'recipe'] },
    title: { type: 'string' },
    body: { type: 'string' },
    people: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    start: orNull({ type: 'string' }),
    end: orNull({ type: 'string' }),
    role: orNull({ type: 'string', enum: ['kid', 'adult'] }),
    // A recipe's serving size, time and ingredients (null for any other note).
    recipe: orNull({
      type: 'object',
      properties: { serves: orNull({ type: 'string' }), time: orNull({ type: 'string' }), ingredients: { type: 'array', items: { type: 'string' } } },
      required: ['serves', 'time', 'ingredients'],
      additionalProperties: false,
    }),
  },
  required: ['type', 'title', 'body', 'people', 'tags', 'start', 'end', 'role', 'recipe'],
  additionalProperties: false,
};
// How the AI is asked to tag a note, wherever notes are made.
const TAGS_RULE =
  'tags: 3 to 8 short lowercase words or two-word phrases to find the note by later: its topic (school, health, travel, money, sports…), other words people might search with (dentist → doctor, teeth, appointment), and the kind of thing (birthday, deadline, recipe). People and places go in people and [[links]], not tags.';
// How the AI is asked to keep a recipe, wherever notes are made: whole, never summed up.
const RECIPE_RULE =
  'A recipe (how to cook or bake something) is one note of type "recipe", kept whole and never summed up: title the dish ("Biryani"); body the recipe word for word as given, in Markdown: a line saying whose it is if said ("[[Person A]]’s recipe."), then "## Ingredients" with every ingredient as a "- " line with its amount, then "## Steps" with every step numbered "1.", "2.", then any tips or notes as given. people: whose recipe it is. recipe: serves and time as written (null when not said) and ingredients, one per entry with amounts, as in the body. For any other note recipe is null.';
export const UNDERSTAND = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['free_time', 'recall', 'remember', 'tidy', 'list', 'reminder', 'about_file', 'other'] },
    people: { type: 'array', items: { type: 'string' } },
    days: orNull({ type: 'integer' }),
    from: orNull({ type: 'string' }),
    to: orNull({ type: 'string' }),
    keywords: { type: 'array', items: { type: 'string' } },
    remember: { type: 'array', items: NOTE_ITEM },
    // A shopping list: which (store name), what to do, which items.
    list: orNull({ type: 'string' }),
    listAction: orNull({ type: 'string', enum: ['show', 'add', 'remove'] }),
    items: { type: 'array', items: { type: 'string' } },
    // A long-term reminder to set up.
    reminder: orNull({
      type: 'object',
      properties: { title: { type: 'string' }, due: { type: 'string' }, repeat: { type: 'string', enum: ['none', 'yearly'] } },
      required: ['title', 'due', 'repeat'],
      additionalProperties: false,
    }),
  },
  required: ['intent', 'people', 'days', 'from', 'to', 'keywords', 'remember', 'list', 'listAction', 'items', 'reminder'],
  additionalProperties: false,
};
// What a dream changes in a batch of shared notes (refs are n1, n2… in the batch).
const DREAM_NOTE = { ...NOTE_ITEM, properties: { ref: { type: 'string' }, ...NOTE_ITEM.properties }, required: ['ref', ...NOTE_ITEM.required] };
export const DREAM = {
  type: 'object',
  properties: {
    notes: { type: 'array', items: DREAM_NOTE },
    merges: {
      type: 'array',
      items: { type: 'object', properties: { keep: { type: 'string' }, drop: { type: 'array', items: { type: 'string' } } }, required: ['keep', 'drop'], additionalProperties: false },
    },
    create: { type: 'array', items: NOTE_ITEM },
  },
  required: ['notes', 'merges', 'create'],
  additionalProperties: false,
};
const DREAM_BATCH_CHARS = 30_000;
// "dream", "dreaming", "go dream", "start dreaming", "please dream now" (after the name is dropped).
const DREAM_RE = /^(?:please\s+|can you\s+|go\s+(?:and\s+)?|start\s+|time to\s+)*(?:dream|dreaming|re-?tag(?: everything)?)\b/i;

// What the AI makes of a file someone sent (a photo, a scan, a document, a sheet).
const EVENT_ITEM = {
  type: 'object',
  properties: { summary: { type: 'string' }, start: { type: 'string' }, end: orNull({ type: 'string' }), off: { type: 'boolean' } },
  required: ['summary', 'start', 'end', 'off'],
  additionalProperties: false,
};
export const UPLOAD = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    // A shop's receipt: the store and what was bought (for the shopping lists).
    receipt: orNull({
      type: 'object',
      properties: { store: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } },
      required: ['store', 'items'],
      additionalProperties: false,
    }),
    calendar: { type: 'boolean' },
    school: { type: 'boolean' },
    events: { type: 'array', items: EVENT_ITEM },
    notes: { type: 'array', items: NOTE_ITEM },
  },
  required: ['title', 'summary', 'receipt', 'calendar', 'school', 'events', 'notes'],
  additionalProperties: false,
};

// What the AI lists from a calendar PDF.
export const PDF_EVENTS = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    school: { type: 'boolean' },
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: { summary: { type: 'string' }, start: { type: 'string' }, end: orNull({ type: 'string' }), off: { type: 'boolean' } },
        required: ['summary', 'start', 'end', 'off'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'school', 'events'],
  additionalProperties: false,
};
export const NOTES_ONLY = { type: 'object', properties: { notes: { type: 'array', items: NOTE_ITEM } }, required: ['notes'], additionalProperties: false };

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
    return this.enqueue(() => this._handle(msg));
  }

  /** Run something in turn with the messages (so lists and reminders aren't changed twice at once). */
  enqueue(fn) {
    this.queue = this.queue.then(fn).catch((e) => this.log('agent: handling failed', e?.message ?? e));
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
    // Where the family is, so reminders come in the morning there.
    if (typeof body.tz === 'string' && body.tz !== this.config.tz && validTimeZone(body.tz)) this.memory.setSetting('config', { ...this.config, tz: body.tz });
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
    this._log(msg, null, text);
    const body = { text, ...extra };
    if (msg.body.thread === 'group') {
      for (const p of this.agent.people()) await this.agent.send(p.id, { ...body, thread: 'group', replyTo: msg.body.replyTo ?? null }).catch((e) => this.log('agent: send failed', e.message));
    } else {
      await this.agent.send(msg.from, { ...body, thread: 'dm' });
    }
  }

  /**
   * The answer to an app request. A message holds about 12 KB, so a bigger
   * answer (a whole memory) goes in parts the app puts back together.
   */
  async _rpcReply(msg, ok, data) {
    const id = msg.body.rpc.id;
    const result = { ok, ...(ok ? { data } : { error: data }) };
    const json = JSON.stringify(result);
    if (json.length <= RPC_PART) return this.agent.send(msg.from, { rpcResult: { id, ...result }, thread: 'dm', agentCopy: true });
    const parts = [];
    for (let i = 0; i < json.length; ) {
      // Escapes and characters past ASCII take more room: shrink a part until it fits.
      let end = Math.min(json.length, i + RPC_PART);
      while (Buffer.byteLength(JSON.stringify(json.slice(i, end))) > RPC_PART) end = i + Math.floor((end - i) * 0.8);
      parts.push(json.slice(i, end));
      i = end;
    }
    for (const [part, chunk] of parts.entries()) {
      await this.agent.send(msg.from, { rpcResult: { id, part, parts: parts.length, chunk }, thread: 'dm', agentCopy: true });
    }
  }

  // --- the conversation so far ---------------------------------------------
  // Each chat (someone's DM, or the group) keeps its last messages to the
  // helper and its answers, sealed like the rest of memory, so a follow-up
  // ("this is my kid’s school calendar", "and the week after?") is read with
  // what came before.

  _chatKey(msg) {
    return msg.body?.thread === 'group' ? 'chat:group' : `chat:${msg.from}`;
  }

  /** The conversation so far in this chat, oldest first: [{ by (a member id, or null for the helper), text, at }]. */
  _chat(msg) {
    return this.memory.getSetting(this._chatKey(msg)) ?? [];
  }

  _log(msg, by, text) {
    if (!text) return;
    const key = this._chatKey(msg);
    const chat = (this.memory.getSetting(key) ?? []).concat({ by, text: String(text).slice(0, 1500), at: this.now().getTime() });
    this.memory.setSetting(key, chat.slice(-CHAT_KEEP));
  }

  /** The conversation as text for the AI (names still in it: mask the result). */
  _chatText(chat) {
    if (!chat.length) return '';
    const lines = chat.map((m) => `${m.by ? this._nameOf(m.by) : this.name}: ${m.text}`);
    return `Our conversation so far (oldest first):\n${lines.join('\n')}\n\n`;
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
      // What came before this message, then this message, so the answer can follow on.
      const chat = this._chat(msg);
      this._log(msg, msg.from, said(b));
      if (b.undo) return await this._undo(msg, b.undo);
      if (b.saveFound) return await this._saveFound(msg, b.saveFound);
      if (b.upload) return await this._readUpload(msg, chat);
      if (b.fileChoice) return await this._fileChoice(msg, b.fileChoice);
      if (b.reminderDone) return await this._reminderDone(msg, b.reminderDone);
      if (b.remember) return await this._remember(msg);
      if (typeof b.ask === 'string') return await this._ask(msg, chat);
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
    return items.map((n) => {
      const data = n.type === 'recipe' ? { serves: n.recipe?.serves ?? null, time: n.recipe?.time ?? null, ingredients: n.recipe?.ingredients ?? [] } : n.role ? { role: n.role } : null;
      return this.memory.add({ ...n, data, start: /^\d{4}-\d{2}-\d{2}$/.test(n.start ?? '') ? n.start : null, end: /^\d{4}-\d{2}-\d{2}$/.test(n.end ?? '') ? n.end : null }, { scope, by, now: this.now().getTime() });
    });
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

  async _ask(msg, chat = []) {
    // "/Chirya/dream", "Chirya, dream", "/dream" all mean "dream": drop the name and slashes first.
    const name = this.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const text = msg.body.ask
      .trim()
      .replace(new RegExp(`^/?(?:${name}|agent)\\b[\\s/,:]*`, 'i'), '')
      .replace(/^\/+/, '')
      .trim();
    // Plain commands, no AI needed.
    const url = text.match(URL_RE)?.[0];
    if (url) return this._addSource(msg, url, text.replace(url, ' '));
    if (/^(?:it'?s|its|that'?s|this is)?\s*for\s+(.+)$/i.test(text) && this._waitingFor(msg.from)) return this._aboutLast(msg, [text.match(/for\s+(.+)$/i)[1]], text);
    if (/^(list|show)( (me|my|the))? (sources|calendars)\b/i.test(text)) return this._listSources(msg);
    if (/^(usage|budget|spending|how much)\b/i.test(text)) return this._usage(msg);
    if (/^undo\b/i.test(text)) return this._undo(msg, this.memory.getSetting(`last:${msg.from}`) ?? []);
    if (/^forget (the )?(.+)$/i.test(text)) return this._forget(msg, text.match(/^forget (?:the )?(.+)$/i)[1]);
    if (DREAM_RE.test(text)) return this._dream(msg);
    if (this.agent.feature('shoppingLists')) {
      const cmd = parseListCommand(text);
      // "add X to Y" without the word list only for a list that exists ("add the dentist to my calendar" isn't one).
      if (cmd && (cmd.action === 'lists' || findList(this._lists(), cmd.list) || /\blist\b/i.test(text))) return this._listCommand(msg, cmd);
    }
    if (this.agent.feature('reminders') && /^(?:(?:show|list)\s+)?(?:my |our |the |all )?reminders$/i.test(text)) return this._listReminders(msg);

    const s = this._swapper(msg.from);
    const asker = this._nameOf(msg.from);
    const u = await this._ai(msg.from, {
      system: this._readerPrompt(),
      messages: [{ role: 'user', content: s.mask(`${this._chatText(chat)}${asker} now says: ${text}`) }],
      schema: UNDERSTAND,
      maxTokens: 2000,
    });
    const plan = u.json ?? { intent: 'other', people: [], days: null, from: null, to: null, keywords: [], remember: [] };
    const wanted = (plan.people ?? []).map((p) => s.unmask(p));
    // "This is my kid’s school calendar": about what they just sent, still waiting for Save.
    if (plan.intent === 'about_file' && this._waitingFor(msg.from)) return this._aboutLast(msg, wanted, text);
    const remember = (plan.remember ?? []).map((n) => unmaskNote(n, s));
    const saved = remember.length ? this._save(remember, { scope: this._scopeFor(msg), by: msg.from }) : [];
    if (saved.length) this.memory.setSetting(`last:${msg.from}`, saved.map((n) => n.id));
    // "Can you tidy up your memory?", "re-tag everything": the same as dream.
    if (plan.intent === 'tidy') return this._dream(msg);
    if (plan.intent === 'list' && plan.list && this.agent.feature('shoppingLists')) {
      return this._listCommand(msg, { action: plan.listAction ?? 'show', list: s.unmask(plan.list), items: (plan.items ?? []).map((i) => s.unmask(i)) });
    }
    if (plan.intent === 'reminder' && plan.reminder && this.agent.feature('reminders')) return this._addReminderFromChat(msg, { ...plan.reminder, title: s.unmask(plan.reminder.title) });
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
      messages: [{ role: 'user', content: s.mask(this._context(notes, worked, asker, text, { chat, found: this._lastFound(msg.from) })) }],
      // Room for a whole recipe when one may be the answer.
      maxTokens: notes.slice(0, MAX_NOTES_IN_PROMPT).some((n) => n.type === 'recipe') ? 4000 : 1500,
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
      'Our conversation so far may come first: use it to understand the new message (what “it”, “that” or “this” is, a follow-up question, a correction), but read only the new message for what to do.',
      'intent: "free_time" when they ask when people are free or available (days = how many days in a row, null if not said); "recall" for a question to answer from what was kept before (like asking for a recipe); "remember" when they tell you something to keep (a fact, a decision, a date, a schedule, who someone is, a recipe); "tidy" when they ask you to dream, or to tidy, sort, organize, clean up or re-tag what you remember; "list" for a shopping list (what’s on it, add to it, take off it); "reminder" when they ask to be reminded of something far ahead (a registration, renewal, payment, appointment); "about_file" when they say whose or what the file, photo, PDF or calendar they just sent is (“this is my kid’s school calendar”, “it’s for Person B”), and then remember is empty; "other" for anything else.',
      'list: the store or list name ("Costco", "desi store"), else null. listAction: show, add or remove, else null. items: the things to add or remove, one per entry. To add a recipe’s ingredients (“add what I need for the biryani to Costco”), items is one entry: "ingredients for" and the recipe as they named it ("ingredients for Person A’s biryani").',
      'reminder: for a reminder, its title (short, like "Car registration"), due (YYYY-MM-DD, the next time it falls) and repeat ("yearly" if it comes every year, like a registration or renewal, else "none"); else null.',
      'people: who the message is about, as written ("Person B"), or a group word as written ("kids", "everyone", "kid" for one child not named).',
      'from/to: a date range the question is about, YYYY-MM-DD, or null. keywords: a few words to search notes with.',
      'remember: notes to keep, only for things stated as facts or decisions (never for questions). One note per thing; title short; body one or two sentences (a recipe: all of it, as below) that link people and places as [[Person A]] or [[Place 1]]. For "Person B and Person C are our kids", one person note each with role "kid". Dates as YYYY-MM-DD.',
      RECIPE_RULE,
      TAGS_RULE,
    ].join('\n');
  }

  _answerPrompt() {
    return [
      `You are ${this.name}, a helper for one family. Answer briefly (a few sentences), in the language the question is asked in, using only the notes, results and conversation given.`,
      'Our conversation so far is there so you can follow on from it: answer the new message, not the earlier ones.',
      'If they don’t answer the question, say so plainly and say what to add (for example, which calendar to share). Never invent dates or facts.',
      'Asked for a recipe, give all of it from its note, not a summary: every ingredient and every step as written, keeping its lists.',
      'People and places are stand-ins (Person A, Place 1): use them exactly as written. Write dates like "Nov 25–29".',
    ].join('\n');
  }

  _context(notes, worked, asker, question, { chat = [], found = null } = {}) {
    const lines = [];
    if (chat.length) lines.push(this._chatText(chat).trim(), '');
    if (found) {
      // Sent but not saved yet: not in the notes, but likely what the conversation is about.
      lines.push(`Just read from what ${asker} sent, not saved yet: ${found.title}`);
      for (const e of (found.events ?? []).slice(0, 80)) lines.push(`- ${fmtRange(e)}: ${e.summary}${e.off ? ' (off)' : ''}`);
      for (const n of (found.notes ?? []).slice(0, 20)) lines.push(`- ${n.type}: ${n.title}: ${(n.body || '').slice(0, 300)}`);
      lines.push('');
    }
    lines.push('Notes:');
    for (const n of notes.slice(0, MAX_NOTES_IN_PROMPT)) {
      const when = n.start ? ` (${n.start === n.end || !n.end ? fmtDay(n.start) : `${fmtDay(n.start)}–${fmtDay(n.end)}`})` : '';
      const role = n.data?.role ? ` [${n.data.role}]` : '';
      // A recipe goes in whole, so it can be given back whole.
      lines.push(`- ${n.type}: ${n.title}${role}${when}: ${(n.body || '').slice(0, n.type === 'recipe' ? 8000 : 600)}`);
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
    if (isPdf(doc.bytes, doc.type)) return this._readPdf(msg, link.url, doc.bytes, rest);
    const text = doc.bytes.toString('utf8');
    if (!/BEGIN:VCALENDAR/.test(text)) throw new BrainError('That link isn’t a calendar I can read. Share its iCal (.ics) or webcal address, or a PDF of the calendar.');
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

  async _storeSource(msg, src, who) {
    const forNames = who
      .split(/,|\band\b|&/i)
      .map((s) => s.trim().replace(/^(the|my|our)\s+/i, ''))
      .filter(Boolean)
      .slice(0, 8);
    const offDays = src.events.filter((e) => e.off ?? isDayOff(e.summary));
    const kind = src.school || offDays.length >= 3 ? 'school' : 'calendar';
    const label = `${names(forNames)}’s ${kind === 'school' ? 'school calendar' : 'calendar'}`;
    const note = this.memory.add(
      {
        type: 'source',
        title: label,
        body: `${kind === 'school' ? 'School calendar' : 'Calendar'} for ${forNames.map((n) => `[[${n}]]`).join(', ')}.`,
        people: forNames,
        data: {
          url: src.url ?? null,
          kind,
          for: forNames,
          events: src.events,
          fetchedAt: src.fetchedAt,
          ...(src.pdf ? { format: 'pdf', hash: src.hash, name: src.title } : {}),
          // From a file someone sent: nothing to check again later.
          ...(src.file ? { format: 'file', name: src.file.name } : {}),
        },
        source: src.file ? `file: ${src.file.name}` : src.pdf ? 'calendar PDF' : 'calendar link',
      },
      { scope: src.scope, by: msg.from, now: this.now().getTime() },
    );
    const next = (kind === 'school' ? offDays : src.events).find((e) => e.end >= this.today());
    const detail = kind === 'school' ? `${offDays.length} days off listed` : `${src.events.length} events`;
    const back = { ...msg, body: { ...msg.body, thread: src.thread, replyTo: src.replyTo } };
    await this.reply(back, `📅 Added ${label}: ${detail}${next ? `; next: ${next.summary} (${fmtRange(next)})` : ''}.${src.url ? ' I’ll check it for changes every 6 hours.' : ''}`, {
      undo: [note.id],
    });
    if (src.file) await this._askAboutFile(back, src.file, [note.id], msg.from);
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
        if (d.format === 'pdf') {
          await this._refreshPdf(src, doc.bytes, now);
          continue;
        }
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

  // --- dreaming ------------------------------------------------------------
  // Like sleep for the memory: go over every shared note and tidy it. Each
  // note gets the right kind (person, place, event, schedule, decision,
  // fact), a clear title, its dates, and [[links]] to the people and places it
  // mentions; duplicates are merged; people and places mentioned but missing
  // get a note. Admins start it; one Undo takes the whole dream back.

  async _dream(msg) {
    if (!this.agent.isAdmin(msg.from)) throw new BrainError('Only circle admins can start a dream.');
    if (!this._provider()) throw new BrainError(`Dreaming needs the AI: an admin can add a provider in the ${this.name} settings.`);
    // Shared notes only (never anyone's private ones); calendars and files keep their data as is.
    const notes = this.memory
      .list({ by: msg.from })
      .filter((n) => n.scope === 'circle' && n.type !== 'source')
      .sort((a, b) => a.title.localeCompare(b.title));
    if (notes.length < 2) return this.reply(msg, '💤 Nothing to sort yet: there’s hardly anything in memory.');
    await this.reply(msg, `💤 Dreaming over ${notes.length} notes… I’ll say when I’m done.`);
    const s = this._swapper(msg.from);
    const by = msg.from;
    const now = this.now().getTime();
    const counts = { tagged: 0, sorted: 0, merged: 0, added: 0 };
    const touched = new Set();
    const known = new Set(notes.filter((n) => n.type === 'person' || n.type === 'place').map((n) => n.title.toLowerCase()));
    for (const batch of dreamBatches(notes)) {
      const refs = new Map(batch.map((n, i) => [`n${i + 1}`, n]));
      const text = batch
        .map((n, i) => {
          const when = n.start ? ` | ${n.start}${n.end && n.end !== n.start ? `..${n.end}` : ''}` : '';
          const role = n.data?.role ? ` | ${n.data.role}` : '';
          return `[n${i + 1}] ${n.type} | ${n.title}${when}${role} | people: ${n.people.join(', ') || '-'} | tags: ${(n.tags ?? []).join(', ') || '-'}\n${n.body.slice(0, 1500)}`;
        })
        .join('\n\n');
      const res = await this._ai(by, { system: this._dreamPrompt(), messages: [{ role: 'user', content: s.mask(text) }], schema: DREAM, maxTokens: 8000 });
      const out = res.json ?? { notes: [], merges: [], create: [] };
      const dropped = new Set();
      for (const m of out.merges ?? []) {
        const keep = refs.get(m.keep);
        if (!keep) continue;
        for (const ref of new Set(m.drop ?? [])) {
          const gone = refs.get(ref);
          if (!gone || gone === keep || dropped.has(ref) || touched.has(gone.id)) continue;
          this.memory.remove(gone.id, { by, now });
          dropped.add(ref);
          touched.add(gone.id);
          counts.merged++;
        }
      }
      for (const fix of out.notes ?? []) {
        const old = refs.get(fix.ref);
        if (!old || dropped.has(fix.ref) || touched.has(old.id)) continue;
        const next = unmaskNote(fix, s);
        const patch = {};
        // A recipe stays whole: the dream sees only the start of a long note.
        const recipe = old.type === 'recipe';
        if (!recipe && NOTE_TYPES_DREAM.includes(next.type) && next.type !== old.type) patch.type = next.type;
        if (next.title?.trim() && next.title.trim() !== old.title) patch.title = next.title.trim();
        if (!recipe && next.body?.trim() && next.body.trim() !== old.body) patch.body = next.body.trim();
        const people = [...new Set((next.people ?? []).map((p) => p.trim()).filter(Boolean))];
        if (people.join('|') !== old.people.join('|')) patch.people = people;
        for (const k of ['start', 'end']) if (/^\d{4}-\d{2}-\d{2}$/.test(next[k] ?? '') && next[k] !== old[k]) patch[k] = next[k];
        if ((next.type ?? old.type) === 'person' && ['kid', 'adult'].includes(next.role) && next.role !== old.data?.role) patch.data = { ...(old.data ?? {}), role: next.role };
        const tags = cleanTags(next.tags);
        const retagged = tags.length > 0 && tags.join('|') !== (old.tags ?? []).join('|');
        if (!Object.keys(patch).length && !retagged) continue;
        this.memory.update(old.id, retagged ? { ...patch, tags } : patch, { by, now });
        touched.add(old.id);
        if (retagged) counts.tagged++;
        if (Object.keys(patch).length) counts.sorted++;
      }
      for (const c of out.create ?? []) {
        const n = unmaskNote(c, s);
        if (!['person', 'place'].includes(n.type) || !n.title?.trim() || known.has(n.title.trim().toLowerCase())) continue;
        const [added] = this._save([n], { scope: 'circle', by });
        known.add(added.title.toLowerCase());
        touched.add(added.id);
        counts.added++;
      }
    }
    const done = [
      counts.tagged && `${counts.tagged} tagged`,
      counts.sorted && `${counts.sorted} sorted or tidied`,
      counts.merged && `${counts.merged} duplicate${counts.merged === 1 ? '' : 's'} merged`,
      counts.added && `${counts.added} new ${counts.added === 1 ? 'note' : 'notes'} for people and places`,
    ].filter(Boolean);
    if (!done.length) return this.reply(msg, '💤 Dream done: everything was already in order.');
    this.memory.setSetting(`last:${by}`, [...touched]);
    await this.reply(msg, `💤 Dream done: ${done.join(', ')}. Every change is in each note’s history in Memory.`, { undo: [...touched] });
  }

  _dreamPrompt() {
    return [
      `You tidy the shared memory of a family's helper, ${this.name}, the way sleep sorts the day's memories. Today is ${this.today()}.`,
      'Each note is "[ref] type | title | dates | role | people", then its text. People and places appear as stand-ins (Person A, Place 1): copy them exactly as written.',
      'The point is that every note can be found again later: right kind, clear title, good tags, links to the people and places in it.',
      'notes: return only the notes you change, each in full (ref, type, title, body, people, tags, start, end, role). A note with no tags or poor tags always needs changing. Fix:',
      '- type: person (someone), place (a location: a home, school, shop, restaurant, address), event (happens on a date), schedule (repeats, like practice every Tuesday, or a school year), decision (something the family decided), recipe (how to cook or bake something), fact (anything else).',
      '- title: short and clear; a person or place note is titled with its name.',
      '- body: one to three sentences, keeping every fact; link people and places it mentions as [[Person A]] or [[Place 1]]. Never invent anything or drop a fact. A recipe note’s body stays as it is.',
      '- people: who the note is about. start/end: YYYY-MM-DD when it has a date (end for a range), else null. role: kid or adult for a person note when the notes say so, else null. recipe: null.',
      `- ${TAGS_RULE}`,
      'merges: notes that say the same thing: keep the best (give its tidied version in notes, with anything the others add) and drop the rest. Only true duplicates.',
      'create: a person or place note for someone or somewhere several notes mention that has no note of its own. Never for anyone or anywhere that already has one.',
    ].join('\n');
  }

  // --- calendar PDFs --------------------------------------------------------
  // The text is read here; the AI lists the dates (names swapped out). The
  // person who added it sees the list and saves it, or discards it.

  async _pdfEvents(by, bytes) {
    if (!this._provider()) throw new BrainError(`Reading a PDF needs the AI: an admin can add a provider in the ${this.name} settings.`);
    let doc;
    try {
      doc = await pdfText(bytes);
    } catch (e) {
      throw new BrainError(e.message);
    }
    if (doc.text.replace(/--- page \d+ ---/g, '').trim().length < 40) {
      throw new BrainError('That PDF has no text in it (it’s probably a scan or a picture), so I can’t read its dates. A calendar link (.ics), or a PDF made from a document, works.');
    }
    const s = this._swapper(by);
    const res = await this._ai(by, {
      system: [
        `You read a calendar from a PDF (a school calendar, a sports or activity schedule) and list its dated entries. Today is ${this.today()}.`,
        'People and places appear as stand-ins (Person A, Place 1): copy them exactly as written.',
        'Each entry: summary (short, as written), start as YYYY-MM-DD, end as YYYY-MM-DD for a range (inclusive) or null for one day, and off: true when there is no school or activity that day for students (holidays, breaks, no school, teacher work or staff development days). Early release and half days are not off.',
        'Work the year out from the calendar (in a 2026–27 school year, August to December are 2026 and January to July are 2027). Always include the first and last day of school if listed. Skip anything without a date.',
        'title: the calendar’s name as printed. school: true for a school calendar.',
      ].join('\n'),
      messages: [{ role: 'user', content: s.mask(doc.text) }],
      schema: PDF_EVENTS,
      maxTokens: 8000,
    });
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const events = (res.json?.events ?? [])
      .filter((e) => day.test(e.start ?? '') && e.summary)
      .map((e) => {
        const summary = s.unmask(String(e.summary)).slice(0, 120);
        const end = day.test(e.end ?? '') && e.end >= e.start ? e.end : e.start;
        return { uid: `pdf:${summary}@${e.start}`, summary, start: e.start, end, time: null, allDay: true, off: !!e.off };
      })
      .sort((a, b) => a.start.localeCompare(b.start));
    if (!events.length) throw new BrainError('I couldn’t find any dates in that PDF.');
    return { title: s.unmask(String(res.json?.title || 'Calendar')).slice(0, 80), school: !!res.json?.school, events, truncated: doc.truncated };
  }

  /** The list the person who added a PDF checks before it's saved. */
  _foundText(title, events, { truncated = false, changed = false } = {}) {
    const shown = events.slice(0, 40).map((e) => `• ${fmtRange(e)}: ${e.summary}${e.off ? ' (off)' : ''}`);
    return [
      changed ? `📄 ${title} changed. This is what it says now:` : `📄 ${title}: I found ${events.length} date${events.length === 1 ? '' : 's'}.`,
      ...shown,
      events.length > shown.length ? `…and ${events.length - shown.length} more.` : null,
      truncated ? 'It’s long, so I only read the first part.' : null,
      changed ? 'Save to use the new dates, or Discard to keep the old ones.' : 'Check them, then Save (you can fix any later in Memory) or Discard.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async _readPdf(msg, url, bytes, rest) {
    const found = await this._pdfEvents(msg.from, bytes);
    const id = randomBytes(6).toString('base64url');
    this.memory.setSetting(`found:${id}`, {
      url,
      pdf: true,
      hash: createHash('sha256').update(bytes).digest('hex'),
      title: found.title,
      school: found.school,
      events: found.events,
      fetchedAt: this.now().getTime(),
      thread: msg.body.thread,
      replyTo: msg.body.replyTo ?? null,
      scope: this._scopeFor(msg),
      by: msg.from,
      forWho: rest.match(/\bfor\s+([^.?!]+)/i)?.[1]?.trim() || null,
    });
    this.memory.setSetting(`lastFound:${msg.from}`, id);
    await this.reply(msg, this._foundText(found.title, found.events, found), { save: { id, by: msg.from } });
  }

  /** Save or Discard on a list: only the person it was shown to. */
  async _saveFound(msg, { id, ok }) {
    const key = `found:${String(id)}`;
    const found = this.memory.getSetting(key);
    if (!found || found.by !== msg.from) return this.reply(msg, 'That list is gone, or isn’t yours to save.');
    this.memory.setSetting(key, null);
    if (this.memory.getSetting(`lastFound:${msg.from}`) === String(id)) this.memory.setSetting(`lastFound:${msg.from}`, null);
    const back = { ...msg, body: { ...msg.body, thread: found.thread, replyTo: found.replyTo } };
    if (!ok) {
      // A file whose reading was discarded isn't worth keeping.
      if (found.file) await this.agent.deleteFile(found.file.id).catch(() => {});
      return this.reply(back, found.replaces ? `Kept the dates I had for ${found.title}.` : found.file ? 'Discarded, and deleted the file from the server.' : 'Discarded.');
    }
    if (found.receipt) {
      // What was bought: counted for that store's list (made if it's new), and off the list.
      const state = this._lists();
      const now = this.now().getTime();
      const list = findList(state, found.receipt.store) ?? createList(state, found.receipt.store, msg.from, now);
      recordBought(state, list, found.receipt.items, now);
      const gone = removeItems(list, found.receipt.items);
      this._saveLists(state);
      await this.reply(back, `🧾 Counted ${found.receipt.items.length} items as bought at ${list.name}${gone.length ? `, and took ${gone.map((i) => i.name).join(', ')} off the list` : ''}. Your usual ${list.name} items now go first.`);
      return this._askAboutFile(back, found.file, [], msg.from);
    }
    if (found.file && !found.calendar) {
      const saved = this._save(found.notes, { scope: found.scope, by: msg.from });
      this.memory.setSetting(`last:${msg.from}`, saved.map((n) => n.id));
      await this.reply(back, `📌 Saved: ${saved.map((n) => n.title).join('; ')}`, { undo: saved.map((n) => n.id) });
      return this._askAboutFile(back, found.file, saved.map((n) => n.id), msg.from);
    }
    if (found.replaces) {
      const src = this.memory.get(found.replaces, { by: msg.from });
      if (!src) return this.reply(back, 'That calendar was removed in the meantime.');
      this.memory.update(src.id, { data: { ...src.data, events: found.events, hash: found.hash, fetchedAt: found.fetchedAt } }, { by: msg.from, now: this.now().getTime() });
      return this.reply(back, `📅 Updated ${src.title}: ${found.events.length} dates.`, { undo: [src.id] });
    }
    if (found.forWho) return this._storeSource(back, found, found.forWho);
    this.memory.setSetting(`pending:${msg.from}`, found);
    await this.reply(back, `Whose calendar is it? Answer “/${this.name} for Kid” (or “for Kid and Sam”).`);
  }

  /** The list shown last to this person and still waiting for Save, if any. */
  _lastFound(by) {
    const id = this.memory.getSetting(`lastFound:${by}`);
    const found = id ? this.memory.getSetting(`found:${id}`) : null;
    // A day later it's no longer what the conversation is about (it can still be saved).
    if (!found || found.by !== by || (found.fetchedAt && this.now().getTime() - found.fetchedAt > DAY)) return null;
    return { id, ...found };
  }

  /** Whether something they sent is waiting to be told whose it is. */
  _waitingFor(by) {
    const found = this._lastFound(by);
    return !!(this.memory.getSetting(`pending:${by}`) || (found && !found.receipt));
  }

  /** Names for "my kid", "the kids", "Sam and Alex"; null when "my kid" can't be told apart. */
  _whose(wanted, by) {
    const persons = this.memory.list({ by, type: 'person' });
    const kids = persons.filter((n) => n.data?.role === 'kid').map((n) => n.title);
    const known = new Set([...persons.map((n) => n.title), ...Object.values(this.people())]);
    const out = [];
    for (const raw of wanted.flatMap((w) => String(w).split(/,|\band\b|&/i))) {
      const w = raw.trim().replace(/^(?:the|my|our)\s+/i, '').replace(/[’']s$/, '').trim();
      if (!w) continue;
      // Someone's name first, as written (a kid may be called Kid; "kid" is any one of them).
      if (known.has(w)) out.push(w);
      else if (KID_RE.test(w)) {
        if (kids.length !== 1) return null;
        out.push(kids[0]);
      } else if (GROUPS.kids.test(w)) out.push(...kids);
      else out.push(w);
    }
    return out.length ? [...new Set(out)] : null;
  }

  /** "This is my kid’s school calendar": whose (and what) the thing they just sent is. */
  async _aboutLast(msg, wanted, text) {
    const who = this._whose(wanted, msg.from);
    const school = /\bschool\b/i.test(text);
    if (!who) {
      const kids = this.memory.list({ by: msg.from, type: 'person' }).filter((n) => n.data?.role === 'kid').map((n) => n.title);
      return this.reply(msg, `Whose is it? Answer “/${this.name} for ${kids[0] ?? 'Kid'}”${kids.length > 1 ? ` (or “for ${names(kids.slice(0, 2))}”)` : ''}.`);
    }
    const pending = this.memory.getSetting(`pending:${msg.from}`);
    if (pending) {
      // Saved already, and waiting to hear whose it is.
      this.memory.setSetting(`pending:${msg.from}`, null);
      return this._storeSource(msg, { ...pending, school: pending.school || school }, who.join(', '));
    }
    const { id, ...found } = this._lastFound(msg.from);
    if (found.pdf || found.calendar) {
      this.memory.setSetting(`found:${id}`, { ...found, forWho: who.join(', '), school: found.school || school });
      return this.reply(msg, `Got it: ${names(who)}’s ${found.school || school ? 'school calendar' : 'calendar'}. Tap Save to add it.`, { save: { id, by: msg.from } });
    }
    // Notes from a file: each one is about them too.
    const notes = (found.notes ?? []).map((n) => ({ ...n, people: [...new Set([...(n.people ?? []), ...who])] }));
    this.memory.setSetting(`found:${id}`, { ...found, notes });
    return this.reply(msg, `Got it: it’s about ${names(who)}. Tap Save to keep it.`, { save: { id, by: msg.from } });
  }

  // --- shopping lists -------------------------------------------------------

  _lists() {
    return this.memory.getSetting('shopping') ?? emptyLists();
  }

  _saveLists(state) {
    this.memory.setSetting('shopping', state);
  }

  /** The recipe note best matching "Nani's biryani" that this person can see, or null. */
  _recipe(dish, by) {
    return this.memory.lookup({ text: dish, by, archived: true, limit: 40 }).find((n) => n.type === 'recipe') ?? null;
  }

  /** "what's on the Costco list", "add milk to Costco", "remove eggs from Costco", "shopping lists". */
  async _listCommand(msg, { action, list: name, items, recipe: wanted = null }) {
    const state = this._lists();
    const now = this.now().getTime();
    // "Add the ingredients for Nani's biryani to Costco": the items come from the recipe note.
    const dish = action === 'add' ? wanted ?? recipeWanted(items) : null;
    let recipe = null;
    if (dish) {
      recipe = this._recipe(dish, msg.from);
      if (!recipe) return this.reply(msg, `I don’t have a recipe for ${dish}. Tell me the recipe (or send a photo of it) and I’ll keep it.`);
      const seen = new Set();
      items = (recipe.data?.ingredients ?? []).map(shoppingName).filter((i) => {
        const k = itemKey(i);
        if (!k || k === 'water' || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (!items.length) return this.reply(msg, `${recipe.title} has no ingredients list. Open it in Memory to add one under “## Ingredients”.`);
    }
    if (action === 'lists') {
      if (!state.lists.length) return this.reply(msg, '🛒 No shopping lists yet. Say “/' + this.name + ' add milk to the Costco list” or open Shopping lists in the app.');
      return this.reply(msg, `🛒 Shopping lists:\n${state.lists.map((l) => `• ${l.name}: ${l.items.filter((i) => !i.ticked).length} to get`).join('\n')}`);
    }
    let list = findList(state, name);
    if (!list) {
      if (action !== 'add') return this.reply(msg, `There’s no ${name} list yet.${state.lists.length ? ` Lists: ${state.lists.map((l) => l.name).join(', ')}.` : ''}`);
      list = createList(state, name.replace(/\b(list|shopping)\b/gi, '').trim() || name, msg.from, now);
    }
    if (action === 'add' && items.length) {
      const added = addItems(state, list, items, msg.from, now);
      this._saveLists(state);
      const from = recipe ? ` for ${recipe.title}` : '';
      return this.reply(msg, added.length ? `🛒 Added to ${list.name}${from}: ${added.map((i) => i.name).join(', ')}.` : `🛒 Already on ${list.name}${from}.`);
    }
    if (action === 'remove' && items.length) {
      const gone = removeItems(list, items);
      this._saveLists(state);
      return this.reply(msg, gone.length ? `🛒 Took off ${list.name}: ${gone.map((i) => i.name).join(', ')}.` : `🛒 That wasn’t on ${list.name}.`);
    }
    return this.reply(msg, listText(state, list));
  }

  // --- long-term reminders ----------------------------------------------------

  _reminders() {
    return this.memory.getSetting('reminders') ?? [];
  }

  _saveReminders(list) {
    this.memory.setSetting('reminders', list);
  }

  async _listReminders(msg) {
    const list = this._reminders().filter((r) => !r.done);
    if (!list.length) return this.reply(msg, `⏰ No reminders yet. Say “/${this.name} remind us about car registration on Nov 30 every year”, or add one in the app.`);
    return this.reply(msg, `⏰ Reminders:\n${list.sort((a, b) => a.due.localeCompare(b.due)).map(reminderLine).join('\n')}`);
  }

  async _addReminderFromChat(msg, r) {
    const list = this._reminders();
    const rem = addReminder(list, r, msg.from, this.now().getTime());
    this._saveReminders(list);
    await this.reply(
      msg,
      `⏰ I’ll remind every admin about ${rem.title}: 30, 7 and 1 days before ${fmtDue(rem.due)}, on the day, then every few days until someone taps Done.${rem.repeat === 'yearly' ? ' It comes back every year.' : ''}`,
    );
  }

  /** Today where the family is (the time zone their phones sent), and the hour there. */
  _localNow() {
    const tz = this.config.tz || 'UTC';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(this.now()).map((p) => [p.type, p.value]));
    return { today: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  }

  /**
   * From 9 in the morning (their time): tell every admin, and whoever added
   * it, about reminders that are coming up or overdue. Each reminder keeps
   * what it already said, so checking every half hour sends each once.
   */
  async checkReminders() {
    if (!this.agent.feature('reminders')) return;
    const { today, hour } = this._localNow();
    if (hour < 9) return;
    const list = this._reminders();
    const admins = this.agent.people().filter((p) => this.agent.isAdmin(p.id)).map((p) => p.id);
    for (const r of list) {
      const text = dueMessage(r, today);
      if (!text) continue;
      const to = new Set([...admins, r.createdBy].filter((id) => this.agent.people().some((p) => p.id === id)));
      for (const id of to) await this.agent.send(id, { text, thread: 'dm', reminder: { id: r.id } }).catch(() => {});
    }
    this._saveReminders(list);
  }

  async _reminderDone(msg, { id }) {
    const list = this._reminders();
    const r = list.find((x) => x.id === id);
    if (!r) return this.reply(msg, 'That reminder is gone.');
    if (r.done) return this.reply(msg, `${r.title} was already marked done.`);
    markDone(r, msg.from, this.now().getTime());
    this._saveReminders(list);
    await this.reply(msg, r.done ? `✅ ${r.title} is done.` : `✅ ${r.title} is done. Next one: ${fmtDue(r.due)}; I’ll remind you again before then.`);
  }

  // --- files people send --------------------------------------------------
  // A photo, scan, document or sheet, encrypted for the agent. It's read
  // (text here with names swapped out; a photo by the AI as it is), and what
  // matters is listed for the sender to check: Save or Discard. After a Save
  // they choose to delete the file from the server or keep it with the notes.

  async _readUpload(msg, chat = []) {
    const u = msg.body.upload ?? {};
    if (typeof u.id !== 'string' || typeof u.key !== 'string') throw new BrainError('That file didn’t come through. Try sending it again.');
    const file = { id: u.id, key: u.key, name: String(u.name || 'file').slice(0, 120), mime: String(u.mime || '').slice(0, 100), size: Number(u.size) || 0 };
    if (!this._provider()) {
      await this.agent.deleteFile(file.id).catch(() => {});
      throw new BrainError(`Reading files needs the AI: an admin can add a provider in the ${this.name} settings.`);
    }
    let read;
    try {
      read = await readFile(await this.agent.readFile(file), file);
    } catch (e) {
      await this.agent.deleteFile(file.id).catch(() => {});
      throw new BrainError(e instanceof BrainError ? e.message : /couldn’t|can’t|too big|isn’t/.test(e.message) ? e.message : 'I couldn’t open that file. Try sending it again.');
    }
    const s = this._swapper(msg.from);
    const intro = `${this._chatText(chat)}${this._nameOf(msg.from)} now sent ${read.kind === 'image' ? 'a photo' : read.kind === 'pdf' ? 'a scanned PDF' : read.what} named “${file.name}”.${msg.body.ask ? ` They said: ${msg.body.ask}` : ''}`;
    const content =
      read.kind === 'text'
        ? s.mask(`${intro}\n\n${read.text}`)
        : [
            { type: 'text', text: s.mask(intro) },
            read.kind === 'image' ? { type: 'image', mime: read.mime, data: read.data } : { type: 'pdf', data: read.data },
          ];
    const res = await this._ai(msg.from, { system: this._uploadPrompt(), messages: [{ role: 'user', content }], schema: UPLOAD, maxTokens: 8000 });
    const out = res.json ?? {};
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const events = (out.events ?? [])
      .filter((e) => day.test(e.start ?? '') && e.summary)
      .map((e) => {
        const summary = s.unmask(String(e.summary)).slice(0, 120);
        return { uid: `file:${summary}@${e.start}`, summary, start: e.start, end: day.test(e.end ?? '') && e.end >= e.start ? e.end : e.start, time: null, allDay: true, off: !!e.off };
      })
      .sort((a, b) => a.start.localeCompare(b.start));
    const notes = (out.notes ?? []).filter((n) => n.title || n.body).map((n) => ({ ...unmaskNote(n, s), source: `file: ${file.name}` }));
    // A receipt: what was bought feeds the shopping lists.
    const receiptItems = (out.receipt?.items ?? []).map((i) => s.unmask(String(i)).slice(0, 60)).filter(Boolean);
    if (receiptItems.length && this.agent.feature('shoppingLists')) {
      const store = s.unmask(String(out.receipt.store || 'Store')).slice(0, 40);
      const id = randomBytes(6).toString('base64url');
      this.memory.setSetting(`found:${id}`, { file, title: store, receipt: { store, items: receiptItems }, thread: msg.body.thread, replyTo: msg.body.replyTo ?? null, scope: this._scopeFor(msg), by: msg.from });
      this.memory.setSetting(`lastFound:${msg.from}`, id);
      const shown = receiptItems.slice(0, 25).join(', ');
      return this.reply(
        msg,
        `🧾 ${store} receipt: ${receiptItems.length} item${receiptItems.length === 1 ? '' : 's'}: ${shown}${receiptItems.length > 25 ? ', …' : ''}.\nSave to count these as bought at ${store}, so your usual items go first on that list (and anything bought comes off it). Or Discard.`,
        { save: { id, by: msg.from } },
      );
    }
    const calendar = !!out.calendar && events.length >= 3;
    if (!calendar && !notes.length) {
      await this.agent.deleteFile(file.id).catch(() => {});
      return this.reply(msg, `I read “${file.name}” but found nothing to keep${out.summary ? `: ${s.unmask(out.summary)}` : '.'} I deleted the file.`);
    }
    const title = s.unmask(String(out.title || file.name)).slice(0, 80);
    const summary = s.unmask(String(out.summary || '')).slice(0, 400);
    const id = randomBytes(6).toString('base64url');
    this.memory.setSetting(`found:${id}`, {
      file,
      title,
      calendar,
      school: !!out.school,
      events,
      notes,
      fetchedAt: this.now().getTime(),
      thread: msg.body.thread,
      replyTo: msg.body.replyTo ?? null,
      scope: this._scopeFor(msg),
      by: msg.from,
      forWho: String(msg.body.ask || '').match(/\bfor\s+([^.?!]+)/i)?.[1]?.trim() || null,
    });
    this.memory.setSetting(`lastFound:${msg.from}`, id);
    const text = calendar
      ? this._foundText(title, events, { truncated: read.truncated })
      : [
          `📄 ${title}${summary ? `: ${summary}` : ''}`,
          'I’d keep:',
          ...notes.slice(0, 15).map((n) => {
            if (n.type === 'recipe') return `• ${n.title}: ${recipeSize(n)}`;
            const body = n.body.replace(/\[\[([^\]]+)\]\]/g, '$1').slice(0, 160);
            const when = n.start ? ` (${fmtRange({ start: n.start, end: n.end || n.start })})` : '';
            // "Coach Dana: 555-0100" rather than "Coach Dana: Coach Dana: 555-0100".
            return body.toLowerCase().startsWith(n.title.toLowerCase()) ? `• ${body}${when}` : `• ${n.title}${when}: ${body}`;
          }),
          notes.length > 15 ? `…and ${notes.length - 15} more.` : null,
          read.truncated ? 'It’s long, so I only read the first part.' : null,
          'Does this look right? Save it (you can fix anything later in Memory) or Discard.',
        ]
          .filter(Boolean)
          .join('\n');
    await this.reply(msg, text, { save: { id, by: msg.from } });
  }

  _uploadPrompt() {
    return [
      `You read a file a family sent their helper, ${this.name}: a photo, a scan, a document or a spreadsheet. Today is ${this.today()}.`,
      'Read all of it, including handwriting and text in pictures. People and places in text appear as stand-ins (Person A, Place 1): copy them exactly as written.',
      'title: what the file is, short ("Lincoln Elementary 2026–27 calendar", "Soccer team contacts"). summary: one or two sentences on what it says.',
      'If it is a shop’s receipt: receipt with the store’s name ("Costco") and every item bought, in plain words a family would put on a shopping list ("milk", "paper towels", not codes or prices); then events and notes are empty. Otherwise receipt null.',
      'If it is a calendar or schedule with many dates (a school calendar, a season schedule): calendar true, and events with summary, start and end (YYYY-MM-DD, end null for one day) and off: true for days without school or activity. school: true for a school calendar.',
      'Otherwise notes: one note per thing worth remembering (a date, a deadline, contact details, a decision, a list, a recipe), each with type, a short title, a body of one to three sentences linking people and places as [[Person A]] (a recipe: all of it, as below), people, start/end when dated, and role null. Skip what isn’t worth keeping.',
      RECIPE_RULE,
      TAGS_RULE,
    ].join('\n');
  }

  /** After a Save: delete the file from the server, or keep it with its notes. Only the sender is asked. */
  async _askAboutFile(msg, file, noteIds, by) {
    const id = randomBytes(6).toString('base64url');
    this.memory.setSetting(`file:${id}`, { file, noteIds, by, thread: msg.body.thread, replyTo: msg.body.replyTo ?? null });
    await this.reply(msg, `Delete “${file.name}” from the server? What I read stays either way. If you keep it, it’s in Memory with the notes, where you can open or delete it later.`, { fileChoice: { id, by } });
  }

  async _fileChoice(msg, { id, keep }) {
    const key = `file:${String(id)}`;
    const ask = this.memory.getSetting(key);
    if (!ask || ask.by !== msg.from) return this.reply(msg, 'That question is gone, or isn’t yours to answer.');
    this.memory.setSetting(key, null);
    const back = { ...msg, body: { ...msg.body, thread: ask.thread, replyTo: ask.replyTo } };
    if (!keep) {
      await this.agent.deleteFile(ask.file.id).catch(() => {});
      return this.reply(back, `🗑️ Deleted “${ask.file.name}” from the server. What I read stays.`);
    }
    try {
      await this.agent.keepFile(ask.file.id);
    } catch {
      return this.reply(back, `“${ask.file.name}” is already gone from the server (files nobody keeps are deleted after 7 days). What I read stays.`);
    }
    const now = this.now().getTime();
    for (const noteId of ask.noteIds) {
      const n = this.memory.get(noteId, { by: msg.from });
      if (n) this.memory.update(n.id, { data: { ...(n.data ?? {}), file: ask.file } }, { by: msg.from, now });
    }
    await this.reply(back, `📎 Kept “${ask.file.name}”. It’s in Memory with the notes.`);
  }

  /**
   * "Download memory": what this person can see, as an Obsidian vault zipped
   * in parts, each encrypted and put on the server for them to fetch. Answers
   * [{ id, key, name, size }] per part, and what couldn't be included.
   */
  async _exportZip(by) {
    const notes = this.memory.list({ by });
    const files = [];
    const missing = [];
    const seen = new Set();
    for (const f of notes.map((n) => n.data?.file).filter(Boolean)) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      try {
        const bytes = await this.agent.readFile(f);
        if (bytes.length > EXPORT_PART_BYTES - 1024) missing.push(f.name);
        else files.push({ id: f.id, name: f.name, bytes });
      } catch {
        missing.push(f.name);
      }
    }
    const state = this._lists();
    const now = this.now().getTime();
    const vault = exportVault({
      notes,
      lists: state.lists.map((l) => viewList(state, l)),
      reminders: this._reminders(),
      files,
      missing,
      who: this._nameOf(by),
      helper: this.name,
      now,
    });
    const { parts } = zipVault(vault, { partBytes: EXPORT_PART_BYTES, name: `${this.name} memory ${new Date(now).toISOString().slice(0, 10)}` });
    const out = [];
    for (const p of parts) out.push({ ...(await this.agent.sendFile(p.bytes)), name: p.name, size: p.bytes.length });
    // Fetched straight away by the phone; gone from the server within the hour.
    setTimeout(() => out.forEach((p) => this.agent.deleteFile(p.id).catch(() => {})), EXPORT_KEEP_MS).unref?.();
    return { parts: out, notes: notes.length, files: files.length, missing };
  }

  /** Delete a kept file from the server (from Memory), and from every note it's attached to. */
  async _deleteKeptFile(noteId, by) {
    const n = this.memory.get(noteId, { by });
    const file = n?.data?.file;
    if (!file) throw new BrainError('That note has no file');
    await this.agent.deleteFile(file.id).catch((e) => {
      if (e?.status !== 404) throw e;
    });
    const now = this.now().getTime();
    for (const other of this.memory.list({ by })) {
      if (other.data?.file?.id !== file.id) continue;
      const { file: _gone, ...rest } = other.data;
      this.memory.update(other.id, { data: Object.keys(rest).length ? rest : null }, { by, now });
    }
  }

  /** A PDF is read again only when the file changed; whoever added it checks the new list. */
  async _refreshPdf(src, bytes, now) {
    const d = src.data;
    const hash = createHash('sha256').update(bytes).digest('hex');
    const by = src.createdBy;
    const as = src.scope === 'circle' ? by : src.scope;
    this.memory.update(src.id, { data: { ...d, fetchedAt: now, ...(hash === d.hash ? {} : { seenHash: hash }) } }, { by: as, now });
    if (hash === d.hash || hash === d.seenHash) return;
    let found;
    try {
      found = await this._pdfEvents(by, bytes);
    } catch (e) {
      return this.log('agent: calendar PDF re-read failed', e.message);
    }
    const id = randomBytes(6).toString('base64url');
    this.memory.setSetting(`found:${id}`, { ...found, title: src.title, hash, fetchedAt: now, replaces: src.id, by, thread: 'dm', replyTo: null });
    await this.agent.send(by, { text: this._foundText(src.title, found.events, { ...found, changed: true }), thread: 'dm', save: { id, by } }).catch(() => {});
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
        return this._rpcReply(msg, true, brief(this.memory.update(args.id, pick(args.patch, ['title', 'body', 'people', 'tags', 'start', 'end', 'type']), { by, now })));
      case 'add':
        return this._rpcReply(msg, true, brief(this.memory.add(pick(args.note, ['title', 'body', 'people', 'tags', 'start', 'end', 'type']), { scope: args.private ? by : 'circle', by, now })));
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
        // A tiny call so a wrong key or model shows up right away, before it
        // replaces settings that work.
        if (args.provider && args.test !== false) {
          const res = await this.llm(next.provider, { system: 'Reply with the word OK.', messages: [{ role: 'user', content: 'Test' }], maxTokens: 50 }, this.llmOptions);
          this.memory.spend(by, res.usd, this.now());
        }
        this.memory.setSetting('config', next);
        return this._rpcReply(msg, true, { ok: true });
      }
      // Shopping lists (the app's Shopping lists screen): anyone in the circle.
      case 'lists':
      case 'listCreate':
      case 'listRename':
      case 'listDelete':
      case 'itemAdd':
      case 'itemTick':
      case 'itemRemove':
      case 'doneShopping': {
        if (!this.agent.feature('shoppingLists')) throw new BrainError('Shopping lists are turned off in this circle');
        const state = this._lists();
        const list = op === 'lists' || op === 'listCreate' ? null : (state.lists.find((l) => l.id === args.listId) ?? null);
        if (op !== 'lists' && op !== 'listCreate' && !list) throw new BrainError('That list is gone');
        if (op === 'listCreate') createList(state, args.name, by, now);
        if (op === 'listRename') list.name = String(args.name || '').trim().slice(0, 40) || list.name;
        if (op === 'listDelete') {
          if (list.createdBy !== by && !this.agent.isAdmin(by)) throw new BrainError('Only whoever made the list, or an admin, can delete it');
          state.lists = state.lists.filter((l) => l !== list);
          delete state.bought[list.id];
        }
        if (op === 'itemAdd') addItems(state, list, (Array.isArray(args.names) ? args.names : splitItems(args.names)).map(String), by, now);
        if (op === 'itemTick') {
          const item = list.items.find((i) => i.id === args.itemId);
          if (item) item.ticked = !!args.ticked;
        }
        if (op === 'itemRemove') list.items = list.items.filter((i) => i.id !== args.itemId);
        if (op === 'doneShopping') doneShopping(state, list, now);
        if (op !== 'lists') this._saveLists(state);
        return this._rpcReply(msg, true, state.lists.map((l) => viewList(state, l)));
      }
      // Reminders (the app's Reminders screen): anyone adds; every admin is reminded.
      case 'reminders':
      case 'reminderAdd':
      case 'reminderUpdate':
      case 'reminderDone':
      case 'reminderRemove': {
        if (!this.agent.feature('reminders')) throw new BrainError('Reminders are turned off in this circle');
        const list = this._reminders();
        const r = op === 'reminders' || op === 'reminderAdd' ? null : (list.find((x) => x.id === args.id) ?? null);
        if (op !== 'reminders' && op !== 'reminderAdd' && !r) throw new BrainError('That reminder is gone');
        if (op === 'reminderAdd') addReminder(list, args, by, now);
        if (op === 'reminderUpdate') {
          const next = cleanReminder({ ...r, ...pick(args, ['title', 'due', 'repeat', 'note']) });
          if (next.due !== r.due) Object.assign(r, { sent: [], lastNag: null, done: false });
          Object.assign(r, next);
        }
        if (op === 'reminderDone') markDone(r, by, now);
        if (op === 'reminderRemove') list.splice(list.indexOf(r), 1);
        if (op !== 'reminders') this._saveReminders(list);
        return this._rpcReply(msg, true, list.map((x) => ({ ...x, createdByName: this._nameOf(x.createdBy) })).sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due)));
      }
      case 'deleteFile':
        await this._deleteKeptFile(String(args.id), by);
        return this._rpcReply(msg, true, null);
      case 'export':
        // Everything this person can see, as linked Markdown files ({ path: text }).
        return this._rpcReply(msg, true, exportMarkdown(this.memory.list({ by })));
      case 'exportZip':
        return this._rpcReply(msg, true, await this._exportZip(by));
      default:
        throw new BrainError('Unknown request');
    }
  }
}

export class BrainError extends Error {}

/** What someone's message to the helper says, for the conversation log. */
function said(b) {
  if (b.upload) return `[sent a file: “${String(b.upload.name || 'file').slice(0, 120)}”]${b.ask ? ` ${b.ask}` : ''}`;
  if (typeof b.ask === 'string') return b.ask;
  if (b.saveFound) return b.saveFound.ok ? '[tapped Save]' : '[tapped Discard]';
  if (b.fileChoice) return b.fileChoice.keep ? '[tapped Keep the file]' : '[tapped Delete the file]';
  if (b.reminderDone) return '[tapped Done on a reminder]';
  if (b.undo) return '[tapped Undo]';
  if (b.remember) return `[asked you to remember a message] ${String(b.remember.text ?? '').slice(0, 500)}`;
  return null;
}

function pick(o, keys) {
  return Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));
}

function rawNote(text, by) {
  const t = String(text || '').trim();
  // Ingredients and steps: a recipe, kept as written.
  const recipe = /\bingredients\b/i.test(t) && /\b(?:steps|method|directions|instructions)\b/i.test(t);
  return { type: recipe ? 'recipe' : 'fact', title: t.split('\n')[0].slice(0, 60), body: by ? `${t}\n\n(from ${by})` : t, people: [], tags: [], start: null, end: null, role: null, recipe: null };
}

/** "recipe, serves 4, 45 min: 12 ingredients and 8 steps" (from a note as the AI gave it, or as kept). */
function recipeSize(n) {
  const d = n.recipe ?? n.data ?? {};
  const body = n.body || '';
  const ingredients = d.ingredients?.length || recipeIngredients(body).length;
  const steps = (body.split(/^(?:#{1,4}\s*)?(?:steps|method|directions|instructions)\b/im)[1] ?? '').match(/^\s*\d+[.)]\s/gm)?.length ?? 0;
  const about = [d.serves && `serves ${String(d.serves).replace(/^serves\s+/i, '')}`, d.time].filter(Boolean).join(', ');
  return `recipe${about ? `, ${about}` : ''}: ${ingredients} ingredient${ingredients === 1 ? '' : 's'}${steps ? ` and ${steps} step${steps === 1 ? '' : 's'}` : ''}`;
}

const NOTE_TYPES_DREAM = ['person', 'place', 'schedule', 'event', 'decision', 'fact', 'recipe'];

/** Notes in groups that fit one AI call; sorted by title, so duplicates land together. */
function dreamBatches(notes) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const n of notes) {
    const len = n.title.length + Math.min(n.body.length, 1500) + 80;
    if (cur.length && size + len > DREAM_BATCH_CHARS) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(n);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

function unmaskNote(n, s) {
  const recipe = n.recipe && { ...n.recipe, ingredients: (n.recipe.ingredients ?? []).map((i) => s.unmask(String(i))) };
  return { ...n, title: s.unmask(n.title), body: s.unmask(n.body), people: (n.people ?? []).map((p) => s.unmask(p)), tags: (n.tags ?? []).map((t) => s.unmask(t)), recipe };
}

/** Notes as Markdown files, one per note, for downloading before the agent is removed. */
export function exportMarkdown(notes) {
  const files = {};
  const safe = (t) => t.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'note';
  for (const n of notes) {
    const front = ['---', `type: ${n.type}`, n.start ? `start: ${n.start}` : null, n.end && n.end !== n.start ? `end: ${n.end}` : null, n.people.length ? `people: [${n.people.join(', ')}]` : null, n.tags?.length ? `tags: [${n.tags.join(', ')}]` : null, '---', '']
      .filter((l) => l != null)
      .join('\n');
    let path = `${n.type}/${safe(n.title)}.md`;
    for (let i = 2; files[path]; i++) path = `${n.type}/${safe(n.title)} ${i}.md`;
    files[path] = `${front}# ${n.title}\n\n${n.body}\n`;
  }
  return files;
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
