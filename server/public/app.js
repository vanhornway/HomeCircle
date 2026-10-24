// HomeCircle web client. All decryption happens here in the browser; the
// server only ever hands us ciphertext.
import * as L from '/vendor/leaflet/leaflet-src.esm.js';
import qrcode from '/vendor/qrcode.mjs';
import { ACCOUNT_KEY, CircleClient, EMOJI_GROUPS, QUICK_REACTIONS, isEmojiOnly } from '/core/index.js';

const root = document.getElementById('root');
const SERVER = location.origin;
const SHARE_KEY = 'homecircle.shareBrowser';
const PLACE_ALERTS_KEY = 'homecircle.showPlaceAlerts';
const showPlaceAlerts = () => {
  try {
    return localStorage.getItem(PLACE_ALERTS_KEY) !== '0';
  } catch {
    return true;
  }
};
const UPLOAD_EVERY_MS = 15 * 60 * 1000;
const MOVE_THRESHOLD_M = 500;

const storage = {
  async getItem(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  async setItem(k, v) {
    localStorage.setItem(k, v);
  },
  async removeItem(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

// A browser can be in several circles on this server. Each has its own
// account (keys) in localStorage; the page shows one at a time and reloads
// to switch.
const LIST_KEY = 'homecircle.circles';
const ACTIVE_KEY = 'homecircle.activeCircle';
const local = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};
// A rejoin request made with the setup code, waiting for a member to approve
// it. It holds this browser's new keys until it completes.
const PENDING_REJOIN_KEY = 'homecircle.pendingRejoin';
const pendingRejoin = {
  get() {
    try {
      return JSON.parse(local.get(PENDING_REJOIN_KEY) || 'null');
    } catch {
      return null;
    }
  },
  set(p) {
    local.set(PENDING_REJOIN_KEY, JSON.stringify(p));
  },
  clear() {
    storage.removeItem(PENDING_REJOIN_KEY);
  },
};
const makeClient = (accountKey) => new CircleClient({ storage, accountKey, onError: (e) => console.warn('[homecircle]', e.message) });
let circles = []; // loaded clients, in the order they were added
let client = makeClient(ACCOUNT_KEY); // the circle on screen
let info = null;

function saveCircles(activeKey = client.accountKey) {
  local.set(LIST_KEY, JSON.stringify(circles.map((c) => c.accountKey)));
  local.set(ACTIVE_KEY, activeKey);
}

/** A client for a circle this browser isn't in yet. */
function newCircleClient() {
  const used = new Set(circles.map((c) => c.accountKey));
  return makeClient(used.has(ACCOUNT_KEY) ? `${ACCOUNT_KEY}.${Date.now().toString(36)}` : ACCOUNT_KEY);
}

/** Remember a circle just created or joined, and open it. */
function openNewCircle(c) {
  circles.push(c);
  saveCircles(c.accountKey);
  history.replaceState(null, '', '/');
  location.reload();
}

function switchCircle(accountKey) {
  saveCircles(accountKey);
  location.reload();
}

// --- tiny DOM helpers ----------------------------------------------------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (typeof v === 'boolean') k in el ? (el[k] = v) : el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function mount(...nodes) {
  root.className = '';
  root.replaceChildren(...nodes);
}

let toastTimer;
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3500);
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const clock = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('') || '?';

function distanceM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function placeAt(loc) {
  if (!loc) return null;
  for (const p of client.places.values()) if (distanceM(loc, p) <= p.radius) return p;
  return null;
}

function errorText(e) {
  return e?.message || String(e);
}

function brandRow() {
  return h('div', { class: 'brand-row' }, h('img', { src: '/app/icon.svg', alt: '' }), 'HomeCircle');
}

function lockNote(text) {
  return h('div', { class: 'lock-note' }, h('span', { 'aria-hidden': 'true' }, '🔒'), h('span', {}, text));
}

// --- onboarding ----------------------------------------------------------

function renderSetup() {
  const err = h('p', { class: 'error', role: 'alert' });
  const name = h('input', { class: 'input', id: 'name', required: true, maxlength: '40', autocomplete: 'given-name', placeholder: 'e.g. Sam' });
  const circleName = h('input', { class: 'input', id: 'circle', maxlength: '40', placeholder: 'e.g. The Parkers' });
  const code = h('input', { class: 'input mono', id: 'code', required: true, autocomplete: 'off', spellcheck: 'false', placeholder: 'From your server logs' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Create my circle');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        err.textContent = '';
        try {
          const c = newCircleClient();
          await c.createCircle({ serverUrl: SERVER, setupToken: code.value, name: name.value, circleName: circleName.value });
          openNewCircle(c);
        } catch (ex) {
          err.textContent = errorText(ex);
          btn.disabled = false;
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'name' }, 'Your name'), name),
    h('div', { class: 'field' }, h('label', { for: 'circle' }, 'Circle name'), circleName),
    h('div', { class: 'field' }, h('label', { for: 'code' }, 'Setup code'), code),
    btn,
    err,
  );
  mount(
    h(
      'main',
      { class: 'onboard' },
      h(
        'div',
        { class: 'card' },
        brandRow(),
        h('h1', {}, 'Set up your server'),
        h('p', { class: 'muted' }, 'You’re the first one here. Create your family’s circle, then invite everyone with a link or QR code.'),
        form,
        lockNote('Your keys are created in this browser. The server only stores encrypted data it can’t read. For the best experience, set up from the HomeCircle phone app instead.'),
      ),
    ),
  );
  name.focus();
}

async function renderJoin(link) {
  const card = h('div', { class: 'card' }, brandRow(), h('p', { class: 'muted' }, 'Checking your invite…'));
  mount(h('main', { class: 'onboard' }, card));
  const joiner = newCircleClient();
  let preview;
  try {
    preview = await joiner.previewInvite(link);
  } catch (e) {
    card.replaceChildren(brandRow(), h('h1', {}, 'Invite not valid'), h('p', { class: 'muted' }, errorText(e)));
    if (circles.length) card.append(h('a', { class: 'btn block', href: '/' }, 'Back to your circles'));
    return;
  }
  const already = circles.find((c) => c.circleId === preview.circleId);
  if (already) {
    toast(`This browser is already in ${preview.circleName || 'that circle'}`);
    return switchCircle(already.accountKey);
  }
  const parsed = link.match(/#([\w-]+)\.([\w-]+)$/);
  const appLink = `homecircle://join?server=${encodeURIComponent(SERVER)}&i=${parsed[1]}&s=${parsed[2]}`;
  const err = h('p', { class: 'error', role: 'alert' });
  const name = h('input', { class: 'input', id: 'name', required: true, maxlength: '40', autocomplete: 'given-name', placeholder: 'Your name' });
  const btn = h('button', { class: 'btn block', type: 'submit', disabled: true }, 'Join in this browser');
  const agree = h('input', { type: 'checkbox', id: 'agree', onchange: () => (btn.disabled = !agree.checked) });
  card.replaceChildren(
    brandRow(),
    h('h1', {}, `Join ${preview.circleName || 'this circle'}`),
    h('p', { class: 'muted' }, preview.invitedBy ? `${preview.invitedBy} invited you to share locations and chat privately.` : 'You’ve been invited to share locations and chat privately.'),
    h('a', { class: 'btn primary block', href: appLink }, 'Open in the HomeCircle app'),
    h('p', { class: 'muted small', style: 'text-align:center;margin:14px 0' }, 'or'),
    h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          if (!agree.checked) return;
          btn.disabled = true;
          err.textContent = '';
          try {
            await joiner.joinWithInvite(link, { name: name.value });
            openNewCircle(joiner);
          } catch (ex) {
            err.textContent = errorText(ex);
            btn.disabled = false;
          }
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'name' }, 'Your name'), name),
      h(
        'label',
        { class: 'consent', for: 'agree' },
        agree,
        h(
          'span',
          {},
          `I agree that everyone in ${preview.circleName || 'this circle'} can see where I am and can ask for my current location at any time. If I pause sharing, they’ll see that I paused.`,
        ),
      ),
      btn,
      err,
    ),
    lockNote('Everything in this circle is end-to-end encrypted. Only its members can see locations and messages.'),
  );
}

function renderNoAccount() {
  mount(
    h(
      'main',
      { class: 'onboard' },
      h(
        'div',
        { class: 'card' },
        brandRow(),
        h('h1', {}, 'A private HomeCircle'),
        h('p', { class: 'muted' }, 'This server belongs to a family circle. To join, ask one of its admins for an invite link or QR code.'),
        info.recovery ? h('button', { class: 'btn block', onclick: () => renderRecover() }, 'I set up this server') : null,
        lockNote('Locations and messages here are end-to-end encrypted. Even this server can’t read them.'),
      ),
    ),
  );
}

// --- recovery with the setup code ------------------------------------------
// Whoever set up this server can always get back in with its setup code:
// rejoin a circle (a member approves it on their phone), start a new circle,
// or delete one nobody uses anymore.

const backHome = () => h('a', { class: 'btn block', href: '/', style: 'margin-top:10px' }, circles.length ? 'Back to your circles' : 'Back');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderRecover() {
  const pending = pendingRejoin.get();
  if (pending) return renderRejoinWait(pending);
  const err = h('p', { class: 'error', role: 'alert' });
  const code = h('input', { class: 'input mono', id: 'code', required: true, autocomplete: 'off', spellcheck: 'false', placeholder: 'From your server logs' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Continue');
  mount(
    h(
      'main',
      { class: 'onboard' },
      h(
        'div',
        { class: 'card' },
        brandRow(),
        h('h1', {}, 'I set up this server'),
        h('p', { class: 'muted' }, 'Enter this server’s setup code to get back into your circle, start a new one, or delete one nobody uses.'),
        h(
          'form',
          {
            onsubmit: async (e) => {
              e.preventDefault();
              btn.disabled = true;
              err.textContent = '';
              try {
                const { circles: list } = await CircleClient.recoverCircles(SERVER, code.value);
                renderRecoverCircles(code.value.trim(), list);
              } catch (ex) {
                err.textContent = errorText(ex);
                btn.disabled = false;
              }
            },
          },
          h('div', { class: 'field' }, h('label', { for: 'code' }, 'Setup code'), code),
          btn,
          err,
        ),
        h('p', { class: 'muted small' }, 'Find it in the server’s log, or where you host it: Render’s Environment tab (SETUP_TOKEN), or setup_code in Home Assistant.'),
        backHome(),
      ),
    ),
  );
  code.focus();
}

function renderRecoverCircles(code, list) {
  const err = h('p', { class: 'error', role: 'alert' });
  const reload = async () => {
    try {
      renderRecoverCircles(code, (await CircleClient.recoverCircles(SERVER, code)).circles);
    } catch (ex) {
      err.textContent = errorText(ex);
    }
  };
  const rows = list.map((c, i) => {
    const mine = circles.find((x) => x.circleId === c.id);
    const label = mine ? mine.circle.name : `Circle ${i + 1}`;
    const bits = [
      `created ${new Date(c.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`,
      plural(c.members, 'member'),
      c.lastSeenAt ? `active ${timeAgo(c.lastSeenAt)}` : 'never active',
    ];
    if (c.waiting) bits.push(`${c.waiting} waiting for approval`);
    return h(
      'div',
      { class: 'row', style: 'flex-wrap:wrap' },
      h('div', { class: 'grow' }, h('strong', {}, label), h('div', { class: 'muted small' }, bits.join(' · '))),
      mine
        ? h('button', { class: 'btn small', onclick: () => (history.replaceState(null, '', '/'), switchCircle(mine.accountKey)) }, 'Open')
        : h('button', { class: 'btn small', disabled: !c.members, onclick: () => renderRejoinForm(code, c, label, () => renderRecoverCircles(code, list)) }, 'Ask to rejoin'),
      h(
        'button',
        {
          class: 'btn small danger',
          onclick: async () => {
            if (!confirm(`Delete ${label}? Everyone in it is removed, and its messages, places and locations are deleted. This can’t be undone.`)) return;
            try {
              await CircleClient.recoverDeleteCircle(SERVER, code, c.id);
              toast(`${label} deleted`);
              await reload();
            } catch (ex) {
              err.textContent = errorText(ex);
            }
          },
        },
        'Delete',
      ),
    );
  });

  const name = h('input', { class: 'input', id: 'name', required: true, maxlength: '40', autocomplete: 'given-name', placeholder: 'e.g. Sam' });
  const circleName = h('input', { class: 'input', id: 'circle', maxlength: '40', placeholder: 'e.g. The Parkers' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Create circle');
  const createErr = h('p', { class: 'error', role: 'alert' });
  mount(
    h(
      'main',
      { class: 'onboard' },
      h(
        'div',
        { class: 'card' },
        brandRow(),
        h('h1', {}, 'Circles on this server'),
        h('p', { class: 'muted' }, 'Circle names are encrypted, so the server can’t show them. Tell them apart by when each was created and how many people are in it.'),
        list.length ? rows : h('p', { class: 'muted' }, 'There are no circles on this server.'),
        err,
        h('h3', { style: 'margin-top:18px' }, 'Start a new circle'),
        h(
          'form',
          {
            onsubmit: async (e) => {
              e.preventDefault();
              btn.disabled = true;
              createErr.textContent = '';
              try {
                const c = newCircleClient();
                await c.createCircle({ serverUrl: SERVER, setupToken: code, name: name.value, circleName: circleName.value });
                openNewCircle(c);
              } catch (ex) {
                createErr.textContent = errorText(ex);
                btn.disabled = false;
              }
            },
          },
          h('div', { class: 'field' }, h('label', { for: 'name' }, 'Your name'), name),
          h('div', { class: 'field' }, h('label', { for: 'circle' }, 'Circle name'), circleName),
          btn,
          createErr,
        ),
        lockNote('Rejoining needs someone still in that circle to approve you on their phone. The setup code alone can’t open a circle.'),
        backHome(),
      ),
    ),
  );
}

function renderRejoinForm(code, c, label, back) {
  const err = h('p', { class: 'error', role: 'alert' });
  const name = h('input', { class: 'input', id: 'name', required: true, maxlength: '40', autocomplete: 'given-name', placeholder: 'So they know it’s you' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Ask to rejoin');
  mount(
    h(
      'main',
      { class: 'onboard' },
      h(
        'div',
        { class: 'card' },
        brandRow(),
        h('h1', {}, `Rejoin ${label}`),
        h('p', { class: 'muted' }, `Someone still in it (${plural(c.members, 'member')}) approves you on their phone. You’ll come back as the circle’s owner; your old phone stays listed until you remove it.`),
        h(
          'form',
          {
            onsubmit: async (e) => {
              e.preventDefault();
              btn.disabled = true;
              err.textContent = '';
              try {
                const pending = await CircleClient.requestRejoin({ serverUrl: SERVER, setupToken: code, circleId: c.id, name: name.value });
                pendingRejoin.set(pending);
                renderRejoinWait(pending);
              } catch (ex) {
                err.textContent = errorText(ex);
                btn.disabled = false;
              }
            },
          },
          h('div', { class: 'field' }, h('label', { for: 'name' }, 'Your name'), name),
          btn,
          err,
        ),
        h('button', { class: 'btn block', style: 'margin-top:10px', onclick: back }, 'Back'),
      ),
    ),
  );
  name.focus();
}

let rejoinTimer;
function renderRejoinWait(pending) {
  const status = h('p', { class: 'muted', role: 'status' }, 'Waiting for approval…');
  const cancel = h(
    'button',
    {
      class: 'btn block',
      onclick: () => {
        clearTimeout(rejoinTimer);
        pendingRejoin.clear();
        location.href = '/';
      },
    },
    'Cancel request',
  );
  mount(
    h(
      'main',
      { class: 'onboard' },
      h(
        'div',
        { class: 'card' },
        brandRow(),
        h('h1', {}, 'Waiting for approval'),
        h('p', { class: 'muted' }, 'Ask someone in the circle to open HomeCircle. They’ll see your request at the top of People and can approve it.'),
        h('p', { class: 'muted small' }, 'They’ll be asked to check this safety number. Read it to them in person or on a call:'),
        h('p', { class: 'mono', style: 'font-size:18px' }, pending.safetyNumber),
        status,
        cancel,
      ),
    ),
  );
  const check = async () => {
    const joiner = newCircleClient();
    try {
      const result = await joiner.finishRejoin(pending);
      if (result === 'joined') {
        pendingRejoin.clear();
        return openNewCircle(joiner);
      }
      if (result === 'denied' || result === 'expired') {
        pendingRejoin.clear();
        status.textContent = result === 'denied' ? 'Your request was denied.' : 'Your request expired. Start again with the setup code.';
        cancel.textContent = 'Back';
        return;
      }
      status.textContent = 'Waiting for approval…';
    } catch (e) {
      status.textContent = errorText(e);
    }
    rejoinTimer = setTimeout(check, 5000);
  };
  check();
}

/** This server no longer knows this browser in the open circle. Deleting its keys can't be undone, so ask. */
function renderUnrecognized() {
  const name = client.circle.name;
  mount(
    h(
      'main',
      { class: 'onboard' },
      h(
        'div',
        { class: 'card' },
        brandRow(),
        h('h1', {}, 'This server doesn’t recognize this browser'),
        h(
          'p',
          { class: 'muted' },
          `In ${name}. You may have been removed, or the circle deleted. If the server lost its data, this browser still has the circle’s keys, so don’t remove it until you’re sure.`,
        ),
        h('button', { class: 'btn primary block', onclick: () => location.reload() }, 'Try again'),
        h(
          'button',
          {
            class: 'btn danger block',
            style: 'margin-top:10px',
            onclick: async () => {
              if (!confirm(`Remove ${name} from this browser? Its keys here are deleted, and you’ll need a new invite to come back.`)) return;
              await client.signOut();
              circles = circles.filter((c) => c !== client);
              if (circles.length) return switchCircle(circles[0].accountKey);
              local.set(LIST_KEY, '[]');
              location.reload();
            },
          },
          `Remove ${name} from this browser`,
        ),
        circles.length > 1
          ? h('button', { class: 'btn block', style: 'margin-top:10px', onclick: () => switchCircle(circles.find((c) => c !== client).accountKey) }, 'Open another circle')
          : null,
      ),
    ),
  );
}

function renderMessage(title, text) {
  mount(h('main', { class: 'onboard' }, h('div', { class: 'card' }, brandRow(), h('h1', {}, title), h('p', { class: 'muted' }, text))));
}

// --- main app ------------------------------------------------------------

// peer: the open conversation in Chat (null = the circle's group chat).
const ui = { tab: 'people', unread: 0, pickPlace: false, invite: null, asked: {}, peer: null, openRuns: new Set(), cheered: new Set(), addingTo: null };
/** More than this many arrived/left alerts in a row collapse into "Movement". */
const MOVEMENT_RUN = 5;
const FEET_PER_METER = 3.28084;
const feet = (m) => {
  const ft = m * FEET_PER_METER;
  return ft >= 5280 ? `${(ft / 5280).toFixed(1)} mi` : `${(Math.round(ft / 10) * 10).toLocaleString()} ft`;
};
const RETENTION_LABELS = { 1: '1 day', 7: '1 week', 30: '1 month', 90: '3 months', 365: '1 year' };
let map;
const markers = new Map();
const placeLayers = new Map();
let fitted = false;

/** The circle name, or a picker when this browser can see more than one circle. */
function circlePicker() {
  const canCreate = circles.some((c) => c.isServerAdmin);
  if (circles.length < 2 && !canCreate) return h('span', { class: 'title' }, client.circle.name);
  const select = h(
    'select',
    {
      class: 'title circle-picker',
      'aria-label': 'Circle',
      onchange: () => {
        if (select.value === '__new') {
          select.value = client.accountKey;
          setTab('settings');
          document.getElementById('new-circle-name')?.focus();
        } else {
          switchCircle(select.value);
        }
      },
    },
    circles.map((c) => h('option', { value: c.accountKey, selected: c === client }, c.circle.name)),
    canCreate ? h('option', { value: '__new' }, '＋ New circle…') : null,
  );
  return select;
}

async function startApp() {
  const status = h('span', { class: 'dot', title: 'Connecting' });
  const title = h('span', { class: 'title-wrap' }, h('span', { class: 'title' }, 'HomeCircle'));
  const tabs = ['people', 'chat', 'places', 'settings'].map((t) =>
    h('button', { class: 'tab', role: 'tab', 'data-tab': t, onclick: () => setTab(t) }, t[0].toUpperCase() + t.slice(1)),
  );
  const panel = h('div', { class: 'panel', id: 'panel' });
  const hint = h('div', { class: 'map-hint hidden' }, 'Click the map to drop the place');
  mount(
    h(
      'div',
      { class: 'shell' },
      h(
        'aside',
        { class: 'side' },
        h('div', { class: 'side-head' }, h('img', { src: '/app/icon.svg', alt: '' }), title, status),
        h('nav', { class: 'tabs', role: 'tablist' }, tabs),
        panel,
      ),
      h('section', { class: 'map' }, h('div', { id: 'map' }), hint),
    ),
  );
  ui.els = { status, title, tabs, panel, hint };

  map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([30, 0], 2);
  // OpenStreetMap blocks browser tile requests without a Referer, so tiles
  // send this server's origin (never the page path); the rest of the page sends none.
  L.tileLayer(info.tileUrl, { maxZoom: 19, attribution: info.tileAttribution, referrerPolicy: 'strict-origin' }).addTo(map);
  map.on('click', (e) => {
    if (!ui.pickPlace) return;
    ui.pickPlace = { lat: e.latlng.lat, lng: e.latlng.lng };
    hint.classList.add('hidden');
    renderPanel();
  });

  client.on('status', (s) => {
    status.className = `dot ${s}`;
    status.title = s === 'online' ? 'Live' : s === 'connecting' ? 'Connecting' : 'Offline';
  });
  const showTitle = () => title.replaceChildren(circlePicker());
  client.on('members', () => {
    showTitle();
    renderPanel();
    renderMarkers();
  });
  client.on('circle', () => {
    showTitle();
    if (ui.tab === 'settings') renderPanel();
  });
  client.on('locations', () => {
    renderMarkers();
    if (ui.tab === 'people') renderPanel();
  });
  client.on('places', () => {
    renderPlaces();
    if (ui.tab === 'places' || ui.tab === 'people') renderPanel();
  });
  client.on('messages', () => {
    if (ui.tab === 'chat') renderPanel();
  });
  client.on('newMessage', (m) => {
    if (m.kind === 'event' && !showPlaceAlerts()) return;
    const elsewhere = (m.peer ?? null) !== ui.peer;
    if (ui.tab !== 'chat' || elsewhere) {
      ui.unread++;
      renderTabs();
    }
    if (ui.tab === 'chat' && elsewhere) {
      const name = client.members.get(m.from)?.name || 'Someone';
      toast(m.peer ? `New direct message from ${name}` : `New message in ${client.circle.name}`);
    }
  });
  client.on('locationRequest', () => {
    if (sharingEnabled()) sendBrowserLocation('requested', true);
  });
  client.on('rejoinRequests', loadRejoins);
  client.on('removed', () => {
    if (circles.length > 1) {
      toast(`You’re no longer in ${client.circle.name}`);
      return setTimeout(() => switchCircle(circles.find((c) => c !== client).accountKey), 1500);
    }
    renderMessage('You were removed', 'You’re no longer in this circle (an admin removed you, or it was deleted), and this browser’s keys were deleted.');
  });

  client.on('unrecognized', renderUnrecognized);

  setTab('people');
  try {
    await client.start();
  } catch (e) {
    // The server doesn't know this browser in that circle: removed, deleted,
    // or the server lost its data. Keep the keys until the person decides.
    if (e.status === 401) return renderUnrecognized();
    toast(errorText(e));
  }
  showTitle();
  // Names for the circle picker.
  Promise.all(circles.filter((c) => c !== client).map((c) => c.refresh().catch(() => {}))).then(showTitle);
  renderPlaces();
  renderMarkers();
  renderPanel();
  if (sharingEnabled()) startSharing();
  loadRejoins();
  setInterval(() => (ui.tab === 'people' || (ui.tab === 'chat' && ui.pollDeadline)) && renderPanel(), 30000);
}

/** Requests to rejoin with the setup code, shown at the top of People. */
async function loadRejoins() {
  if (!info.recovery) return;
  try {
    ui.rejoins = await client.rejoinRequests();
  } catch {
    ui.rejoins = [];
  }
  if (ui.tab === 'people') renderPanel();
}

function rejoinCards() {
  return (ui.rejoins || []).map((q) =>
    h(
      'div',
      { class: 'rejoin-card' },
      h('strong', {}, `${q.name} asked to rejoin as the circle’s owner`),
      h('p', { class: 'muted small' }, 'They used this server’s setup code. Approve only if you know it’s them: ask them to read you their safety number, and check it matches this one.'),
      h('p', { class: 'mono' }, q.safetyNumber),
      h(
        'div',
        { class: 'panel-actions' },
        h(
          'button',
          {
            class: 'btn small primary',
            onclick: async () => {
              if (!confirm(`Let ${q.name} back into ${client.circle.name}? They’ll see everything in it and become its owner.`)) return;
              try {
                await client.approveRejoin(q);
                toast(`${q.name} can rejoin now`);
              } catch (e) {
                toast(errorText(e));
              }
              loadRejoins();
            },
          },
          'Approve',
        ),
        h(
          'button',
          {
            class: 'btn small danger',
            onclick: async () => {
              try {
                await client.denyRejoin(q.id);
              } catch (e) {
                toast(errorText(e));
              }
              loadRejoins();
            },
          },
          'Deny',
        ),
      ),
    ),
  );
}

function setTab(t) {
  ui.tab = t;
  if (t === 'chat') {
    ui.unread = 0;
    ui.focusChat = true;
  }
  if (t !== 'places' && ui.pickPlace) {
    ui.pickPlace = false;
    ui.els.hint.classList.add('hidden');
  }
  renderTabs();
  renderPanel();
}

function renderTabs() {
  for (const b of ui.els.tabs) {
    const t = b.dataset.tab;
    b.setAttribute('aria-selected', String(t === ui.tab));
    b.replaceChildren(t[0].toUpperCase() + t.slice(1), t === 'chat' && ui.unread ? h('span', { class: 'badge' }, ui.unread) : '');
  }
}

function renderPanel() {
  const panel = ui.els.panel;
  const scroll = panel.scrollTop;
  const oldLog = panel.querySelector('.chat-log');
  ui.chatFromBottom = oldLog ? oldLog.scrollHeight - oldLog.clientHeight - oldLog.scrollTop : 0;
  panel.style.padding = ui.tab === 'chat' ? '0' : '';
  const view = { people: peopleView, chat: chatView, places: placesView, settings: settingsView }[ui.tab]();
  panel.replaceChildren(view);
  if (ui.tab === 'chat') {
    const log = panel.querySelector('.chat-log');
    // Stay put if the reader scrolled up (e.g. to react); otherwise follow new messages.
    if (log) log.scrollTop = ui.chatFromBottom > 120 ? log.scrollHeight - log.clientHeight - ui.chatFromBottom : log.scrollHeight;
  } else {
    panel.scrollTop = scroll;
  }
}

// --- people --------------------------------------------------------------

// Locate one person, or refresh everyone: each has its own cooldown.
const LOCATE_COOLDOWN_MS = 60_000;
async function requestLocations(targets) {
  const key = targets ? targets[0] : '*';
  ui.asked = { ...(ui.asked || {}), [key]: Date.now() };
  renderPanel();
  try {
    const res = await client.requestLocations(targets);
    toast(res.requested ? `Asked ${res.requested === 1 ? 'their phone' : `${res.requested} phones`} for a fresh location` : 'No one else to ask yet');
  } catch (e) {
    delete ui.asked[key];
    toast(errorText(e));
  }
  renderPanel();
  setTimeout(() => ui.tab === 'people' && renderPanel(), LOCATE_COOLDOWN_MS + 100);
}

/** 'idle' | 'asking' | 'cooldown' for one person (or '*' for everyone). */
function locateState(id) {
  // Not you, and not someone who paused (they won't answer).
  if (id !== '*' && (id === client.account.memberId || client.paused.has(id))) return 'idle';
  const at = Math.max(ui.asked?.[id] || 0, id === '*' ? 0 : ui.asked?.['*'] || 0);
  if (!at || Date.now() - at > LOCATE_COOLDOWN_MS) return 'idle';
  const loc = id === '*' ? null : client.locations.get(id);
  if (loc && loc.receivedAt >= at) return 'cooldown';
  return 'asking';
}

const directionsUrl = (loc) => `https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`;

function peopleView() {
  const members = client.memberList();
  const everyone = locateState('*');
  const list = members.map((m) => {
    const loc = client.locations.get(m.id);
    const paused = client.paused.get(m.id);
    const place = loc && !loc.approximate ? placeAt(loc) : null;
    const state = locateState(m.id);
    const bits = [];
    if (paused) {
      bits.push(`Paused${paused.reason ? `: ${paused.reason}` : ''}`, timeAgo(paused.since));
    } else if (loc && Date.now() - loc.ts > 2 * 3600_000) {
      // No update for two hours: say since when, rather than an old position as if current.
      bits.push(`No signal since ${clock(loc.ts)}${Date.now() - loc.ts > 86400_000 ? ` (${timeAgo(loc.ts)})` : ''}`);
      if (loc.trigger === 'low_battery') bits.push(`battery was ${Math.round((loc.battery ?? 0) * 100)}%`);
    } else if (loc) {
      bits.push(loc.approximate ? 'Approximate area' : place ? `At ${place.name}` : `±${feet(loc.accuracy || 0)}`);
      bits.push(timeAgo(loc.ts));
      if (loc.battery != null) bits.push(`${Math.round(loc.battery * 100)}%${loc.charging ? ' ⚡' : ''}`);
      if (loc.perm === 'foreground') bits.push('Location set to While Using');
      else if (loc.precise === false) bits.push('Precise location off');
      if (loc.power === 'saver') bits.push('Battery saver on');
    } else {
      bits.push(m.isMe ? 'Not sharing from this browser' : 'No location yet');
    }
    const low = loc && (loc.trigger === 'low_battery' || (loc.battery != null && loc.battery <= 0.1 && !loc.charging));
    const iconBtn = (label, glyph, onclick, disabled) =>
      h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, disabled, onclick: (e) => (e.stopPropagation(), onclick()) }, glyph);
    return h(
      'div',
      {
        class: 'person',
        onclick: () => loc && map.flyTo([loc.lat, loc.lng], Math.max(map.getZoom(), loc.approximate ? 13 : 15), { duration: 0.6 }),
      },
      h('div', { class: 'avatar', style: `background:${m.color}` }, initials(m.name)),
      h(
        'div',
        { class: 'info' },
        h(
          'div',
          { class: 'name' },
          m.name,
          m.isMe ? h('span', { class: 'tag' }, 'You') : null,
          m.role !== 'member' ? h('span', { class: 'tag' }, m.role) : null,
          low ? h('span', { class: 'tag warn' }, 'Low battery') : null,
          m.keyChanged ? h('span', { class: 'tag warn', title: 'The server is showing different keys for this person than before' }, 'Keys changed') : null,
          !m.verified && !m.keyChanged ? h('span', { class: 'tag warn' }, 'Unverified') : null,
        ),
        h('div', { class: 'meta' }, state === 'asking' ? 'Asking for a fresh location…' : bits.join(' · ')),
      ),
      !m.isMe
        ? h(
            'div',
            { class: 'person-actions' },
            loc
              ? h('a', { class: 'icon-btn', href: directionsUrl(loc), target: '_blank', rel: 'noopener noreferrer', title: `Directions to ${m.name}`, 'aria-label': `Directions to ${m.name}`, onclick: (e) => e.stopPropagation() }, '➤')
              : null,
            iconBtn(`Message ${m.name}`, '💬', () => {
              ui.peer = m.id;
              setTab('chat');
            }),
            iconBtn(state === 'asking' ? `Asking ${m.name}…` : `Locate ${m.name}`, state === 'asking' ? '…' : '⌖', () => requestLocations([m.id]), !!paused || state !== 'idle'),
          )
        : null,
    );
  });
  return h(
    'div',
    {},
    rejoinCards(),
    h(
      'div',
      { class: 'panel-actions' },
      h('button', { class: 'btn primary', disabled: everyone !== 'idle' || members.length < 2, onclick: () => requestLocations() }, everyone !== 'idle' ? 'Asked everyone' : 'Refresh everyone'),
      client.isAdmin ? h('button', { class: 'btn', onclick: () => setTab('settings') }, 'Invite') : null,
    ),
    list,
    members.length < 2 ? h('p', { class: 'muted small' }, 'It’s just you so far. Invite your family from Settings.') : null,
  );
}

function renderMarkers() {
  if (!map) return;
  const seen = new Set();
  for (const m of client.memberList()) {
    const loc = client.locations.get(m.id);
    if (!loc) continue;
    seen.add(m.id);
    const stale = Date.now() - loc.ts > 2 * 3600_000;
    const el = h('div', { class: `marker${stale ? ' stale' : ''}`, style: `background:${m.color}` }, initials(m.name));
    const icon = L.divIcon({ html: el, className: '', iconSize: [40, 40], iconAnchor: [20, 20] });
    let entry = markers.get(m.id);
    if (!entry) {
      entry = {
        marker: L.marker([loc.lat, loc.lng], { icon, keyboard: false }).addTo(map),
        accuracy: L.circle([loc.lat, loc.lng], { radius: loc.accuracy || 0, stroke: !!loc.approximate, color: m.color, weight: 2, dashArray: '6 6', fillColor: m.color, fillOpacity: loc.approximate ? 0.08 : 0.12, interactive: false }).addTo(map),
      };
      markers.set(m.id, entry);
    } else {
      entry.marker.setLatLng([loc.lat, loc.lng]).setIcon(icon);
      entry.accuracy.setLatLng([loc.lat, loc.lng]).setRadius(loc.accuracy || 0);
      entry.accuracy.setStyle({ stroke: !!loc.approximate, fillOpacity: loc.approximate ? 0.08 : 0.12 });
    }
    // Leaflet treats string tooltips as HTML; pass an element so names stay plain text.
    entry.marker.unbindTooltip().bindTooltip(h('span', {}, `${m.name} · ${timeAgo(loc.ts)}`), { direction: 'top', offset: [0, -18] });
  }
  for (const [id, entry] of markers) {
    if (seen.has(id)) continue;
    entry.marker.remove();
    entry.accuracy.remove();
    markers.delete(id);
  }
  if (!fitted && markers.size) {
    fitted = true;
    const pts = [...markers.values()].map((e) => e.marker.getLatLng());
    if (pts.length === 1) map.setView(pts[0], 14);
    else map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 15 });
  }
}

function renderPlaces() {
  if (!map) return;
  for (const layer of placeLayers.values()) layer.remove();
  placeLayers.clear();
  for (const p of client.places.values()) {
    const c = L.circle([p.lat, p.lng], { radius: p.radius, color: '#2f7d6d', weight: 2, fillOpacity: 0.08, dashArray: '4 6', interactive: false }).addTo(map);
    c.bindTooltip(h('span', {}, p.name), { permanent: true, direction: 'center', className: 'place-label' });
    placeLayers.set(p.id, c);
  }
}

// --- chat ----------------------------------------------------------------

function chatView() {
  const me = client.account.memberId;
  if (ui.peer && !client.members.get(ui.peer)) ui.peer = null;
  // Group chat, or a direct conversation with one member.
  const others = client.memberList().filter((m) => !m.isMe);
  const peers = [...new Set([...client.directPeers(), ...others.map((m) => m.id)])];
  const picker = h(
    'select',
    {
      class: 'input conversation-picker',
      'aria-label': 'Conversation',
      onchange: () => {
        ui.peer = picker.value || null;
        ui.focusChat = true;
        ui.unread = 0;
        renderTabs();
        renderPanel();
      },
    },
    h('option', { value: '', selected: !ui.peer }, `👥 ${client.circle.name} (group)`),
    peers.map((id) => h('option', { value: id, selected: ui.peer === id }, `💬 ${client.members.get(id)?.name || 'Former member'} (direct)`)),
  );
  const shown = client.conversation(ui.peer).filter((m) => m.kind !== 'event' || showPlaceAlerts());
  // Re-draw every 30 s while a poll is counting down to its deadline.
  ui.pollDeadline = shown.some((m) => m.body?.poll?.closesAt && !client.pollState(m.id)?.closed);
  const peerName = ui.peer ? client.members.get(ui.peer)?.name || 'them' : null;
  const log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
  if (!shown.length) {
    log.append(
      h('p', { class: 'muted small', style: 'text-align:center' }, ui.peer ? `Only you and ${peerName} can read this conversation.` : 'No messages yet. Say hi 👋'),
    );
  }
  const eventLine = (m) => {
    const b = m.body || {};
    const verb = b.action === 'left' ? 'left' : 'arrived at';
    return h('div', { class: 'event-line' }, `${client.members.get(m.from)?.name || 'Former member'} ${verb} ${b.placeName || 'a place'} · ${clock(m.ts)}`);
  };
  for (let i = 0; i < shown.length; i++) {
    const m = shown[i];
    const who = client.members.get(m.from);
    const name = who?.name || 'Former member';
    if (m.kind === 'event') {
      // More than MOVEMENT_RUN arrived/left alerts in a row fold into one
      // "Movement" line, so they don't take over the chat. Click to open it.
      let end = i;
      while (end < shown.length && shown[end].kind === 'event') end++;
      if (end - i > MOVEMENT_RUN) {
        const run = shown.slice(i, end);
        const id = run[0].id;
        const open = ui.openRuns.has(id);
        log.append(
          h(
            'button',
            {
              class: 'event-line movement',
              type: 'button',
              'aria-expanded': String(open),
              onclick: () => {
                if (open) ui.openRuns.delete(id);
                else ui.openRuns.add(id);
                renderPanel();
              },
            },
            `${open ? '▴' : '▾'} Movement · ${run.length}`,
          ),
          ...(open ? run.map(eventLine) : []),
        );
        i = end - 1;
        continue;
      }
      log.append(eventLine(m));
    } else if (m.kind === 'chat' && (m.body?.pollResult || m.body?.pollSpin)) {
      // Poll results and spins read as a line across the chat, like alerts.
      log.append(h('div', { class: 'event-line strong' }, m.body.text));
    } else if (m.kind === 'chat' && m.body?.poll) {
      log.append(h('div', { class: `poll-row${m.from === me ? ' mine' : ''}` }, pollCard(m.id), h('div', { class: 'bubble-time' }, clock(m.ts))));
    } else if (m.kind === 'chat') {
      const mine = m.from === me;
      const big = isEmojiOnly(m.body.text);
      const reactions = client.reactionsFor(m.id);
      const react = (emoji) => {
        ui.reactingTo = null;
        client.react(m.id, emoji).catch((ex) => toast(errorText(ex)));
      };
      log.append(
        h(
          'div',
          { class: `bubble-row${mine ? ' mine' : ''}` },
          mine || ui.peer ? null : h('div', { class: 'bubble-from', style: `color:${who?.color || 'inherit'}` }, name),
          h(
            'div',
            { class: 'bubble-line' },
            h('div', { class: `bubble${big ? ' big' : ''}` }, m.body.text),
            h(
              'button',
              {
                class: 'react-btn',
                type: 'button',
                title: 'React',
                'aria-label': 'React to this message',
                onclick: () => {
                  ui.reactingTo = ui.reactingTo === m.id ? null : m.id;
                  renderPanel();
                },
              },
              '☺',
            ),
          ),
          ui.reactingTo === m.id
            ? h(
                'div',
                { class: 'react-bar', role: 'group', 'aria-label': 'Reactions' },
                QUICK_REACTIONS.map((e) =>
                  h('button', { type: 'button', class: reactions.some((r) => r.emoji === e && r.mine) ? 'on' : '', onclick: () => react(e), 'aria-label': `React ${e}` }, e),
                ),
              )
            : null,
          reactions.length
            ? h(
                'div',
                { class: 'chips' },
                reactions.map((r) =>
                  h(
                    'button',
                    { type: 'button', class: `chip${r.mine ? ' mine' : ''}`, title: r.names.join(', '), onclick: () => react(r.emoji) },
                    r.emoji,
                    r.count > 1 ? h('span', {}, r.count) : null,
                  ),
                ),
              )
            : null,
          m.body.checkin === 'request' && !mine && ui.peer
            ? shown.some((x) => x.from === me && x.body?.checkin === 'ok' && x.seq > m.seq)
              ? h('div', { class: 'checked-in' }, '✓ You checked in')
              : h(
                  'button',
                  {
                    class: 'btn small primary',
                    type: 'button',
                    onclick: () => client.checkIn(ui.peer).catch((ex) => toast(errorText(ex))),
                  },
                  'I’m OK',
                )
            : null,
          h('div', { class: 'bubble-time' }, clock(m.ts)),
        ),
      );
    } else {
      log.append(h('div', { class: 'event-line' }, '🔒 Encrypted before you joined'));
    }
  }
  if (!ui.chatForm) {
    // Created once so a re-render (new message, location update) never wipes a draft.
    const input = h('input', { class: 'input', placeholder: 'Message your circle', maxlength: '4000', 'aria-label': 'Message' });
    ui.chatForm = h(
      'form',
      {
        class: 'chat-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const text = input.value;
          if (!text.trim()) return;
          input.value = '';
          try {
            await client.sendChat(text, { to: ui.peer });
          } catch (ex) {
            input.value = text;
            toast(errorText(ex));
          }
          input.focus();
        },
      },
      h(
        'button',
        {
          class: 'btn emoji-toggle',
          type: 'button',
          title: 'Emoji',
          'aria-label': 'Emoji',
          onclick: () => picker.classList.toggle('hidden'),
        },
        '😊',
      ),
      h(
        'button',
        {
          class: 'btn emoji-toggle',
          type: 'button',
          title: 'New poll',
          'aria-label': 'New poll',
          onclick: () => {
            picker.classList.add('hidden');
            ui.pollForm.classList.toggle('hidden');
            if (!ui.pollForm.classList.contains('hidden')) ui.pollForm.querySelector('input').focus();
          },
        },
        '📊',
      ),
      input,
      h('button', { class: 'btn primary', type: 'submit' }, 'Send'),
    );
    // Emoji picker: inserts at the cursor and keeps the draft.
    const picker = h(
      'div',
      { class: 'emoji-picker hidden', role: 'dialog', 'aria-label': 'Emoji' },
      EMOJI_GROUPS.map((g) =>
        h(
          'div',
          {},
          h('div', { class: 'emoji-group' }, g.name),
          h(
            'div',
            { class: 'emoji-grid' },
            g.emojis.map((e) =>
              h(
                'button',
                {
                  type: 'button',
                  'aria-label': `Insert ${e}`,
                  onclick: () => {
                    const at = input.selectionStart ?? input.value.length;
                    input.setRangeText(e, at, input.selectionEnd ?? at, 'end');
                    input.focus();
                  },
                },
                e,
              ),
            ),
          ),
        ),
      ),
    );
    ui.chatForm.prepend(picker);
    ui.pollForm = newPollForm();
    ui.chatForm.prepend(ui.pollForm);
  }
  const form = ui.chatForm;
  const input = form.querySelector(':scope > input');
  input.placeholder = ui.peer ? `Message ${peerName}` : 'Message your circle';
  const refocus = document.activeElement === input || ui.focusChat;
  ui.focusChat = false;
  if (refocus) setTimeout(() => input.focus(), 0);
  const askBtn = ui.peer
    ? h(
        'button',
        {
          class: 'btn small',
          type: 'button',
          title: `Ask ${peerName} where they are`,
          onclick: () => client.askToCheckIn(ui.peer).then(() => toast(`Asked ${peerName} to check in`), (ex) => toast(errorText(ex))),
        },
        '📍 Where are you?',
      )
    : null;
  return h('div', { class: 'chat' }, h('div', { class: 'chat-top' }, picker, askBtn), log, form);
}

// --- polls ---------------------------------------------------------------

/** A poll in the chat: click an option to vote; live bars, add, spin and close. */
function pollCard(pollId) {
  const s = client.pollState(pollId);
  if (!s) return null;
  const fail = (ex) => toast(errorText(ex));
  const total = Math.max(1, s.voters);
  const winners = s.closed ? new Set(s.winners.map((w) => w.id)) : new Set();
  const vote = (o) => {
    const next = s.multi ? (o.mine ? s.myVote.filter((x) => x !== o.id) : [...s.myVote, o.id]) : o.mine ? [] : [o.id];
    client.vote(pollId, next).catch(fail);
  };
  const minutes = s.closesAt && !s.closed ? Math.max(1, Math.ceil((s.closesAt - Date.now()) / 60000)) : null;
  const footer = [
    `${s.voters} of ${s.eligible} voted`,
    s.multi ? 'pick any' : null,
    s.closed ? 'closed' : minutes == null ? null : minutes >= 60 ? `closes in ${Math.round(minutes / 60)} h` : `closes in ${minutes} min`,
  ].filter(Boolean);
  // The confetti plays once, the first time everyone has voted.
  const cheer = s.everyoneVoted && !s.closed;
  const pop = cheer && !ui.cheered.has(pollId);
  if (cheer) ui.cheered.add(pollId);
  const adding = ui.addingTo === pollId;
  const addInput = adding ? h('input', { class: 'input', maxlength: '60', placeholder: 'Another option', 'aria-label': 'Another option' }) : null;
  const add = () => {
    const label = addInput.value.trim();
    ui.addingTo = null;
    if (label) client.suggestOption(pollId, label).catch(fail);
    else renderPanel();
  };
  if (adding) {
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') add();
      if (e.key === 'Escape') ((ui.addingTo = null), renderPanel());
    });
    setTimeout(() => addInput.focus(), 0);
  }
  const wheel = h('span', { class: 'wheel', 'aria-hidden': 'true' }, '🎡');
  return h(
    'div',
    { class: 'poll' },
    h('div', { class: 'poll-head' }, `📊 Poll · ${s.creatorName}`),
    h('div', { class: 'poll-q' }, s.question),
    s.options.map((o) =>
      h(
        'button',
        {
          type: 'button',
          class: `poll-opt${o.mine ? ' mine' : ''}${winners.has(o.id) ? ' win' : ''}`,
          style: `--share:${Math.round((o.votes / total) * 100)}%`,
          disabled: s.closed,
          'aria-pressed': String(o.mine),
          title: o.voters.join(', '),
          onclick: () => vote(o),
        },
        h('span', { class: 'poll-label' }, winners.has(o.id) ? '🏆 ' : '', o.emoji ? `${o.emoji} ` : '', o.label),
        o.mine ? h('span', { class: 'poll-check' }, '✓') : null,
        h('span', { class: 'poll-count' }, o.votes),
        o.voters.length ? h('span', { class: 'poll-voters' }, o.voters.join(', ')) : null,
      ),
    ),
    cheer ? h('div', { class: `poll-cheer${pop ? ' pop' : ''}` }, '🎉 Everyone voted!') : null,
    s.spin ? h('div', { class: 'poll-spin' }, `🎡 ${s.spin.by} spun the wheel: ${s.spin.option.emoji ? `${s.spin.option.emoji} ` : ''}${s.spin.option.label}`) : null,
    adding ? h('div', { class: 'poll-add' }, addInput, h('button', { class: 'btn small primary', type: 'button', onclick: add }, 'Add')) : null,
    h('div', { class: 'muted small' }, footer.join(' · ')),
    !s.closed || s.winners.length > 1
      ? h(
          'div',
          { class: 'poll-actions' },
          !s.closed && s.allowAdd && !adding && s.options.length < 12
            ? h('button', { class: 'btn small', type: 'button', onclick: () => ((ui.addingTo = pollId), renderPanel()) }, '+ Add option')
            : null,
          h(
            'button',
            {
              class: 'btn small',
              type: 'button',
              onclick: (e) => {
                e.currentTarget.disabled = true;
                wheel.classList.add('spinning');
                setTimeout(() => client.spinWheel(pollId).catch(fail), 1200);
              },
            },
            wheel,
            ' Spin',
          ),
          s.mine && !s.closed
            ? h(
                'button',
                {
                  class: 'btn small',
                  type: 'button',
                  onclick: () => confirm('Close this poll? No more votes after this. Everyone sees the result.') && client.closePoll(pollId).catch(fail),
                },
                'Close poll',
              )
            : null,
        )
      : null,
  );
}

/** The "new poll" form above the composer: question, options, two switches and a deadline. */
function newPollForm() {
  const question = h('input', { class: 'input', maxlength: '200', placeholder: 'Ask anything', 'aria-label': 'Question' });
  const list = h('div', { class: 'poll-form-options' });
  const addOption = () => {
    if (list.children.length >= 8) return;
    const n = list.children.length + 1;
    list.append(h('input', { class: 'input', maxlength: '60', placeholder: `Option ${n}`, 'aria-label': `Option ${n}` }));
  };
  addOption();
  addOption();
  const multi = h('input', { type: 'checkbox' });
  const allowAdd = h('input', { type: 'checkbox', checked: true });
  const deadline = h(
    'select',
    { class: 'input', 'aria-label': 'Closes' },
    h('option', { value: '' }, 'No deadline'),
    h('option', { value: '30' }, 'Closes in 30 min'),
    h('option', { value: '60' }, 'Closes in 1 hour'),
    h('option', { value: '180' }, 'Closes in 3 hours'),
  );
  const form = h(
    'div',
    { class: 'poll-form hidden', role: 'dialog', 'aria-label': 'New poll' },
    h('div', { class: 'poll-head' }, '📊 New poll'),
    question,
    list,
    h('button', { class: 'btn small', type: 'button', onclick: addOption }, '+ Add option'),
    h('label', { class: 'check' }, multi, ' Pick more than one'),
    h('label', { class: 'check' }, allowAdd, ' Let others add options'),
    deadline,
    h(
      'div',
      { class: 'panel-actions' },
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: async () => {
            const options = [...list.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
            try {
              await client.createPoll(
                {
                  question: question.value.trim(),
                  options: options.map((label) => ({ label })),
                  multi: multi.checked,
                  allowAdd: allowAdd.checked,
                  closesAt: deadline.value ? Date.now() + Number(deadline.value) * 60000 : null,
                },
                { to: ui.peer },
              );
            } catch (ex) {
              toast(errorText(ex));
              return;
            }
            question.value = '';
            list.replaceChildren();
            addOption();
            addOption();
            form.classList.add('hidden');
          },
        },
        'Start poll',
      ),
      h('button', { class: 'btn', type: 'button', onclick: () => form.classList.add('hidden') }, 'Cancel'),
    ),
  );
  return form;
}

// --- places --------------------------------------------------------------

function placesView() {
  if (ui.pickPlace && ui.pickPlace !== true) {
    const at = ui.pickPlace;
    const name = h('input', { class: 'input', id: 'pname', maxlength: '40', placeholder: 'Home, School, Work…', required: true });
    const radius = h(
      'select',
      { class: 'input', id: 'pradius' },
      [250, 500, 1000, 2000].map((ft) => h('option', { value: String(Math.round(ft / FEET_PER_METER)), selected: ft === 500 }, `${ft.toLocaleString()} ft`)),
    );
    setTimeout(() => name.focus(), 0);
    return h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await client.savePlace({ name: name.value, lat: at.lat, lng: at.lng, radius: Number(radius.value), icon: 'pin' });
            ui.pickPlace = false;
            renderPlaces();
            renderPanel();
          } catch (ex) {
            toast(errorText(ex));
          }
        },
      },
      h('h2', { style: 'margin-bottom:12px' }, 'New place'),
      h('div', { class: 'field' }, h('label', { for: 'pname' }, 'Name'), name),
      h('div', { class: 'field' }, h('label', { for: 'pradius' }, 'Alert radius'), radius),
      h('div', { class: 'panel-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save place'), h('button', { class: 'btn', type: 'button', onclick: () => ((ui.pickPlace = false), renderPanel()) }, 'Cancel')),
      h('p', { class: 'muted small' }, 'Phones get arrive/leave alerts for places. Detection happens on each phone, never on the server.'),
    );
  }
  const places = [...client.places.values()];
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'panel-actions' },
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () => {
            ui.pickPlace = true;
            ui.els.hint.classList.remove('hidden');
            renderPanel();
          },
        },
        ui.pickPlace ? 'Click the map…' : 'Add a place',
      ),
    ),
    places.length
      ? places.map((p) =>
          h(
            'div',
            { class: 'person', onclick: () => map.flyTo([p.lat, p.lng], 16, { duration: 0.6 }) },
            h('div', { class: 'avatar', style: 'background:var(--brand)' }, '⌂'),
            h('div', { class: 'info' }, h('div', { class: 'name' }, p.name), h('div', { class: 'meta' }, [`${feet(p.radius)} radius`, p.address].filter(Boolean).join(' · '))),
            h(
              'button',
              {
                class: 'btn small danger',
                onclick: async (e) => {
                  e.stopPropagation();
                  if (!confirm(`Delete “${p.name}”?`)) return;
                  try {
                    await client.deletePlace(p.id);
                    renderPlaces();
                  } catch (ex) {
                    toast(errorText(ex));
                  }
                },
              },
              'Delete',
            ),
          ),
        )
      : h('p', { class: 'muted small' }, 'Add places like Home or School to get alerts when people arrive or leave.'),
  );
}

// --- settings ------------------------------------------------------------

function qrImage(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return h('div', { class: 'qr' }, h('img', { src: qr.createDataURL(6, 2), alt: 'Invite QR code' }));
}

function copyButton(text) {
  return h(
    'button',
    {
      class: 'btn small',
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast('Copied');
        } catch {
          toast('Copy failed — select the link and copy it manually');
        }
      },
    },
    'Copy',
  );
}

function settingsView() {
  const me = client.me;
  const sections = [];

  const nameInput = h('input', { class: 'input', value: me?.name || '', maxlength: '40', 'aria-label': 'Your name' });
  sections.push(
    h(
      'div',
      { class: 'section' },
      h('h3', {}, 'You'),
      h(
        'form',
        {
          class: 'row',
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await client.setName(nameInput.value);
              toast('Name updated');
            } catch (ex) {
              toast(errorText(ex));
            }
          },
        },
        h('div', { class: 'grow' }, nameInput),
        h('button', { class: 'btn', type: 'submit' }, 'Save'),
      ),
      h(
        'label',
        { class: 'switch row' },
        h('input', {
          type: 'checkbox',
          checked: sharingEnabled(),
          onchange: (e) => (e.target.checked ? startSharing(true) : stopSharing()),
        }),
        h('span', {}, 'Share this browser’s location while it’s open'),
      ),
      h(
        'label',
        { class: 'switch row' },
        h('input', {
          type: 'checkbox',
          checked: showPlaceAlerts(),
          onchange: (e) => {
            local.set(PLACE_ALERTS_KEY, e.target.checked ? '1' : '0');
            toast(e.target.checked ? 'Place alerts shown in chat' : 'Place alerts hidden in this browser');
          },
        }),
        h('span', {}, 'Show place alerts (“arrived at Home”) in chat'),
      ),
    ),
  );

  if (client.isAdmin) {
    const inviteBox = h('div', {});
    const showInvite = (inv) =>
      inviteBox.replaceChildren(
        qrImage(inv.link),
        h('div', { class: 'link-box' }, h('input', { class: 'input mono', readonly: true, value: inv.link, onfocus: (e) => e.target.select() }), copyButton(inv.link)),
        h('p', { class: 'muted small' }, `Works once and expires ${new Date(inv.expiresAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}. Share it privately — anyone with this link can join.`),
      );
    if (ui.invite && ui.invite.expiresAt > Date.now()) showInvite(ui.invite);
    sections.push(
      h(
        'div',
        { class: 'section' },
        h('h3', {}, 'Invite someone'),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              try {
                ui.invite = await client.createInvite();
                showInvite(ui.invite);
              } catch (ex) {
                toast(errorText(ex));
              }
            },
          },
          ui.invite ? 'New invite link' : 'Create invite link',
        ),
        inviteBox,
      ),
    );
  }

  const members = client.memberList();
  sections.push(
    h(
      'div',
      { class: 'section' },
      h('h3', {}, 'Members'),
      members.map((m) =>
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'avatar', style: `background:${m.color};width:32px;height:32px;font-size:13px` }, initials(m.name)),
          h(
            'div',
            { class: 'grow' },
            h('div', {}, m.name, m.isMe ? ' (you)' : ''),
            h('details', {}, h('summary', { class: 'muted small' }, `${m.role} · safety number`), h('div', { class: 'mono' }, m.safetyNumber)),
          ),
          me?.role === 'owner' && !m.isMe && m.role !== 'owner'
            ? h('button', { class: 'btn small', onclick: () => client.setRole(m.id, m.role === 'admin' ? 'member' : 'admin').catch((e) => toast(errorText(e))) }, m.role === 'admin' ? 'Make member' : 'Make admin')
            : null,
          client.isAdmin && !m.isMe && m.role !== 'owner' && (m.role !== 'admin' || me.role === 'owner')
            ? h(
                'button',
                {
                  class: 'btn small danger',
                  onclick: async () => {
                    if (!confirm(`Remove ${m.name}? They’ll lose access immediately and the circle key will be changed.`)) return;
                    try {
                      await client.removeMember(m.id);
                      toast(`${m.name} was removed and the key was rotated`);
                    } catch (ex) {
                      toast(errorText(ex));
                    }
                  },
                },
                'Remove',
              )
            : null,
        ),
      ),
      h('p', { class: 'muted small' }, 'Compare safety numbers in person to be sure no one has been swapped in.'),
    ),
  );

  const retention = client.retention;
  if (retention.choices.length) {
    sections.push(
      h(
        'div',
        { class: 'section' },
        h('h3', {}, 'Message history'),
        h(
          'label',
          { class: 'small', for: 'retention' },
          'Delete messages after ',
          h(
            'select',
            {
              class: 'input inline',
              id: 'retention',
              disabled: !client.isAdmin,
              onchange: (e) => client.setRetention(Number(e.target.value)).catch((ex) => toast(errorText(ex))),
            },
            retention.choices.map((d) => h('option', { value: String(d), selected: d === retention.days }, RETENTION_LABELS[d] || `${d} days`)),
          ),
        ),
        h(
          'p',
          { class: 'muted small' },
          client.isAdmin
            ? 'Applies to group and direct messages in this circle. Nothing is kept longer than a year.'
            : 'Set by the circle’s admins. Nothing is kept longer than a year.',
        ),
      ),
    );
  }

  sections.push(circlesSection());

  sections.push(
    h(
      'div',
      { class: 'section' },
      h('h3', {}, 'This server'),
      h('div', { class: 'small' }, SERVER),
      h('div', { class: 'muted small' }, `HomeCircle ${info.version} · key version ${client.account.epoch} · ${client.status}`),
    ),
  );

  sections.push(
    h(
      'div',
      { class: 'section' },
      h('h3', {}, 'Leave'),
      h(
        'div',
        { class: 'panel-actions' },
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              if (!confirm(`Sign out of ${client.circle.name} in this browser? Its keys will be deleted and you’ll need a new invite to come back.`)) return;
              stopSharing();
              await client.signOut();
              location.reload();
            },
          },
          'Sign out of this browser',
        ),
        me?.role !== 'owner'
          ? h(
              'button',
              {
                class: 'btn danger',
                onclick: async () => {
                  if (!confirm(`Leave ${client.circle.name}? Your location will stop being shared and your data removed.`)) return;
                  stopSharing();
                  try {
                    await client.leave();
                    location.reload();
                  } catch (ex) {
                    toast(errorText(ex));
                  }
                },
              },
              'Leave circle',
            )
          : h(
              'button',
              {
                class: 'btn danger',
                onclick: async () => {
                  const name = client.circle.name;
                  if (!confirm(`Delete ${name}? Everyone is removed and its messages, places and locations are deleted. This can’t be undone. Other circles aren’t affected.`)) return;
                  stopSharing();
                  try {
                    await client.deleteCircle();
                    location.reload();
                  } catch (ex) {
                    toast(errorText(ex));
                  }
                },
              },
              'Delete circle',
            ),
      ),
    ),
  );
  return h('div', {}, sections);
}

function circlesSection() {
  const admin = circles.find((c) => c.isServerAdmin);
  const err = h('p', { class: 'error', role: 'alert' });
  const circleName = h('input', { class: 'input', id: 'new-circle-name', maxlength: '40', placeholder: 'e.g. Parents & siblings', required: true });
  const name = h('input', { class: 'input', id: 'new-circle-me', maxlength: '40', value: admin?.me?.name || client.me?.name || '', required: true });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Create circle');
  return h(
    'div',
    { class: 'section' },
    h('h3', {}, 'Circles'),
    circles.map((c) =>
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'grow' }, c.circle.name, c === client ? h('span', { class: 'muted small' }, ' · open now') : null),
        c === client ? null : h('button', { class: 'btn small', onclick: () => switchCircle(c.accountKey) }, 'Open'),
      ),
    ),
    h('p', { class: 'muted small' }, 'Each circle is separate: its own people, map, chat and encryption key. To join another circle, open its invite link in this browser.'),
    info.recovery
      ? h(
          'p',
          { class: 'muted small' },
          'Set up this server? ',
          h('a', { href: '/#recover', onclick: () => setTimeout(() => location.reload()) }, 'Manage its circles with the setup code'),
          '.',
        )
      : null,
    admin
      ? h(
          'form',
          {
            class: 'new-circle',
            onsubmit: async (e) => {
              e.preventDefault();
              btn.disabled = true;
              err.textContent = '';
              try {
                const c = newCircleClient();
                await c.createCircle({ serverUrl: SERVER, admin, name: name.value, circleName: circleName.value });
                openNewCircle(c);
              } catch (ex) {
                err.textContent = errorText(ex);
                btn.disabled = false;
              }
            },
          },
          h('h4', {}, 'New circle'),
          h('div', { class: 'field' }, h('label', { for: 'new-circle-name' }, 'Circle name'), circleName),
          h('div', { class: 'field' }, h('label', { for: 'new-circle-me' }, 'Your name in it'), name),
          btn,
          err,
        )
      : null,
  );
}

// --- browser location sharing -------------------------------------------

let watchId = null;
let lastSent = 0;
let lastSentPos = null;

function sharingEnabled() {
  try {
    return localStorage.getItem(SHARE_KEY) === '1';
  } catch {
    return false;
  }
}

function startSharing(fromToggle = false) {
  if (!('geolocation' in navigator)) return toast('This browser can’t share location');
  try {
    localStorage.setItem(SHARE_KEY, '1');
  } catch {
    /* ignore */
  }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => maybeSend(pos, 'update'),
    (err) => {
      toast(`Location unavailable: ${err.message}`);
      if (err.code === err.PERMISSION_DENIED) stopSharing();
    },
    { enableHighAccuracy: false, maximumAge: 60000, timeout: 30000 },
  );
  if (fromToggle) sendBrowserLocation('manual', true);
}

function stopSharing() {
  try {
    localStorage.removeItem(SHARE_KEY);
  } catch {
    /* ignore */
  }
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function sendBrowserLocation(trigger, force) {
  navigator.geolocation.getCurrentPosition(
    (pos) => maybeSend(pos, trigger, force),
    (err) => toast(`Location unavailable: ${err.message}`),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
}

async function maybeSend(pos, trigger, force = false) {
  const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  const moved = !lastSentPos || distanceM(lastSentPos, here) > MOVE_THRESHOLD_M;
  if (!force && !moved && Date.now() - lastSent < UPLOAD_EVERY_MS) return;
  let battery = null;
  let charging = false;
  try {
    const b = await navigator.getBattery?.();
    if (b) {
      battery = b.level;
      charging = b.charging;
    }
  } catch {
    /* not available */
  }
  try {
    await client.shareLocation({ ...here, accuracy: pos.coords.accuracy, battery, charging, speed: pos.coords.speed, trigger, ts: pos.timestamp });
    lastSent = Date.now();
    lastSentPos = here;
  } catch (e) {
    toast(errorText(e));
  }
}

// --- boot ----------------------------------------------------------------

async function boot() {
  try {
    info = await CircleClient.serverInfo(SERVER);
  } catch (e) {
    return renderMessage('Server unavailable', errorText(e));
  }
  if (info.loadTest) {
    document.body.append(h('div', { class: 'loadtest-bar', role: 'note' }, 'Load-test server: simulated people only. Don’t put your family on it.'));
  }
  let keys = [];
  try {
    keys = JSON.parse(local.get(LIST_KEY) || '[]');
  } catch {
    keys = [];
  }
  if (!keys.includes(ACCOUNT_KEY)) keys.unshift(ACCOUNT_KEY); // browsers from before multiple circles
  for (const key of keys) {
    const c = makeClient(key);
    if (await c.load()) circles.push(c);
  }
  const active = local.get(ACTIVE_KEY);
  client = circles.find((c) => c.accountKey === active) || circles[0] || client;
  if (circles.length) saveCircles();

  const invite = location.pathname.startsWith('/join') && location.hash.length > 1 ? `${SERVER}/join${location.hash}` : null;
  if (invite) return renderJoin(invite);
  if (info.recovery && (location.hash === '#recover' || (!circles.length && pendingRejoin.get()))) return renderRecover();
  if (circles.length) return startApp();
  if (!info.setup) return renderSetup();
  renderNoAccount();
}

boot();
