// HomeCircle web client. All decryption happens here in the browser; the
// server only ever hands us ciphertext.
import * as L from '/vendor/leaflet/leaflet-src.esm.js';
import qrcode from '/vendor/qrcode.mjs';
import { ACCOUNT_KEY, CircleClient, EMOJI_GROUPS, QUICK_REACTIONS, isEmojiOnly } from '/core/index.js';

const root = document.getElementById('root');
const SERVER = location.origin;
const SHARE_KEY = 'homecircle.shareBrowser';
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
  const btn = h('button', { class: 'btn block', type: 'submit' }, 'Join in this browser');
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
        lockNote('Locations and messages here are end-to-end encrypted. Even this server can’t read them.'),
      ),
    ),
  );
}

function renderMessage(title, text) {
  mount(h('main', { class: 'onboard' }, h('div', { class: 'card' }, brandRow(), h('h1', {}, title), h('p', { class: 'muted' }, text))));
}

// --- main app ------------------------------------------------------------

const ui = { tab: 'people', unread: 0, pickPlace: false, invite: null, cooldownUntil: 0 };
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
  L.tileLayer(info.tileUrl, { maxZoom: 19, attribution: info.tileAttribution, referrerPolicy: 'no-referrer' }).addTo(map);
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
  client.on('circle', showTitle);
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
  client.on('newMessage', () => {
    if (ui.tab !== 'chat') {
      ui.unread++;
      renderTabs();
    }
  });
  client.on('locationRequest', () => {
    if (sharingEnabled()) sendBrowserLocation('requested', true);
  });
  client.on('removed', () => {
    if (circles.length > 1) {
      toast(`You’re no longer in ${client.circle.name}`);
      return setTimeout(() => switchCircle(circles.find((c) => c !== client).accountKey), 1500);
    }
    renderMessage('You were removed', 'You’re no longer in this circle (an admin removed you, or it was deleted), and this browser’s keys were deleted.');
  });

  setTab('people');
  try {
    await client.start();
  } catch (e) {
    if (e.status === 401) {
      await client.signOut();
      return renderMessage('Signed out', 'This browser is no longer part of the circle.');
    }
    toast(errorText(e));
  }
  showTitle();
  // Names for the circle picker.
  Promise.all(circles.filter((c) => c !== client).map((c) => c.refresh().catch(() => {}))).then(showTitle);
  renderPlaces();
  renderMarkers();
  renderPanel();
  if (sharingEnabled()) startSharing();
  setInterval(() => ui.tab === 'people' && renderPanel(), 30000);
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

async function requestLocations(targets) {
  try {
    const res = await client.requestLocations(targets);
    ui.cooldownUntil = Date.now() + res.cooldown * 1000;
    toast(res.requested ? `Asked ${res.requested === 1 ? 'their phone' : `${res.requested} phones`} for a fresh location` : 'No one else to ask yet');
  } catch (e) {
    toast(errorText(e));
  }
  renderPanel();
}

function peopleView() {
  const members = client.memberList();
  const cooling = Date.now() < ui.cooldownUntil;
  const list = members.map((m) => {
    const loc = client.locations.get(m.id);
    const place = placeAt(loc);
    const bits = [];
    if (loc) {
      bits.push(place ? `At ${place.name}` : `±${Math.round(loc.accuracy || 0)} m`);
      bits.push(timeAgo(loc.ts));
      if (loc.battery != null) bits.push(`${Math.round(loc.battery * 100)}%${loc.charging ? ' ⚡' : ''}`);
    } else {
      bits.push(m.isMe ? 'Not sharing from this browser' : 'No location yet');
    }
    return h(
      'div',
      {
        class: 'person',
        onclick: () => loc && map.flyTo([loc.lat, loc.lng], Math.max(map.getZoom(), 15), { duration: 0.6 }),
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
          m.keyChanged ? h('span', { class: 'tag warn', title: 'The server is showing different keys for this person than before' }, 'Keys changed') : null,
          !m.verified && !m.keyChanged ? h('span', { class: 'tag warn' }, 'Unverified') : null,
        ),
        h('div', { class: 'meta' }, bits.join(' · ')),
      ),
      !m.isMe
        ? h(
            'button',
            {
              class: 'btn small',
              disabled: cooling,
              title: 'Ask their phone for a fresh location',
              onclick: (e) => {
                e.stopPropagation();
                requestLocations([m.id]);
              },
            },
            'Locate',
          )
        : null,
    );
  });
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'panel-actions' },
      h('button', { class: 'btn primary', disabled: cooling || members.length < 2, onclick: () => requestLocations() }, cooling ? 'Requested' : 'Refresh everyone'),
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
        accuracy: L.circle([loc.lat, loc.lng], { radius: loc.accuracy || 0, stroke: false, fillColor: m.color, fillOpacity: 0.12, interactive: false }).addTo(map),
      };
      markers.set(m.id, entry);
    } else {
      entry.marker.setLatLng([loc.lat, loc.lng]).setIcon(icon);
      entry.accuracy.setLatLng([loc.lat, loc.lng]).setRadius(loc.accuracy || 0);
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
  const log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
  if (!client.messages.length) log.append(h('p', { class: 'muted small', style: 'text-align:center' }, 'No messages yet. Say hi 👋'));
  for (const m of client.messages) {
    const who = client.members.get(m.from);
    const name = who?.name || 'Former member';
    if (m.kind === 'event') {
      const b = m.body || {};
      const verb = b.action === 'left' ? 'left' : 'arrived at';
      log.append(h('div', { class: 'event-line' }, `${name} ${verb} ${b.placeName || 'a place'} · ${clock(m.ts)}`));
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
          mine ? null : h('div', { class: 'bubble-from', style: `color:${who?.color || 'inherit'}` }, name),
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
            await client.sendChat(text);
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
  }
  const form = ui.chatForm;
  const input = form.querySelector('input');
  const refocus = document.activeElement === input || ui.focusChat;
  ui.focusChat = false;
  if (refocus) setTimeout(() => input.focus(), 0);
  return h('div', { class: 'chat' }, log, form);
}

// --- places --------------------------------------------------------------

function placesView() {
  if (ui.pickPlace && ui.pickPlace !== true) {
    const at = ui.pickPlace;
    const name = h('input', { class: 'input', id: 'pname', maxlength: '40', placeholder: 'Home, School, Work…', required: true });
    const radius = h(
      'select',
      { class: 'input', id: 'pradius' },
      [100, 150, 250, 500, 1000].map((r) => h('option', { value: String(r), selected: r === 150 }, `${r} m`)),
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
            h('div', { class: 'info' }, h('div', { class: 'name' }, p.name), h('div', { class: 'meta' }, `${p.radius} m radius`)),
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
  if (circles.length) return startApp();
  if (!info.setup) return renderSetup();
  renderNoAccount();
}

boot();
