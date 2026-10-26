// Every feature a circle can have. Its admins choose which are on, when they
// make the circle and any time after; a circle made before this existed has
// everything on. Each new feature gets an entry here with whether a new
// circle starts with it (`on`); `needs` names a feature it depends on.

export const FEATURES = [
  { id: 'locationSharing', group: 'Location', label: 'Location sharing', detail: 'Everyone’s place on the map, about every 15 minutes.', on: true },
  { id: 'locate', group: 'Location', label: 'Locate', detail: 'Ask someone’s phone for a fresh location right now.', on: false, needs: 'locationSharing' },
  { id: 'placeAlerts', group: 'Location', label: 'Place alerts', detail: 'Arrived and left alerts for places like Home or School.', on: false, needs: 'locationSharing' },
  { id: 'checkIns', group: 'Location', label: 'Check-ins', detail: '“Where are you?” with a one-tap “I’m OK”.', on: true },
  { id: 'frequentPlaces', group: 'Location', label: 'Most visited places', detail: 'Each person’s top places, shared with the circle.', on: false, needs: 'locationSharing' },
  { id: 'lowBattery', group: 'Location', label: 'Low-battery handoff', detail: 'A last location at 10% and 5% battery.', on: true, needs: 'locationSharing' },
  { id: 'groupChat', group: 'Chat', label: 'Group chat', detail: 'The circle’s shared chat.', on: true },
  { id: 'directMessages', group: 'Chat', label: 'Direct messages', detail: 'One-to-one chats inside the circle.', on: true },
  { id: 'polls', group: 'Chat', label: 'Polls', detail: 'Ask the group with options to vote on.', on: false },
  { id: 'readReceipts', group: 'Chat', label: 'Read receipts', detail: 'Read ticks (each person can still turn theirs off).', on: true },
  { id: 'chirps', group: 'Alerts', label: 'Chirps', detail: 'A short bird sound or flash on someone’s phone.', on: false },
  { id: 'sos', group: 'Alerts', label: 'SOS', detail: 'Hold to alert everyone, with your location every minute.', on: false },
  { id: 'circleHealth', group: 'Alerts', label: 'Circle health', detail: 'Admins see how each phone is set up and can nudge.', on: true },
  { id: 'agent', group: 'Helper', label: 'Circle helper (AI)', detail: 'An AI helper admins can add, with its own memory.', on: false },
  { id: 'shoppingLists', group: 'Helper', label: 'Shopping lists', detail: 'Shared lists per store, usual items first.', on: true, needs: 'agent' },
  { id: 'reminders', group: 'Helper', label: 'Long-term reminders', detail: 'Car registration and the like, to every admin.', on: true, needs: 'agent' },
  { id: 'uploads', group: 'Helper', label: 'Photos and files to the helper', detail: 'Send it a photo, PDF, document or sheet to read.', on: false, needs: 'agent' },
  // Plugins: parts of the server a circle can add (0.14+).
  { id: 'weather', group: 'Plugins', label: 'Weather', detail: 'The weather where the person you select is, in the corner of the map.', on: false },
  { id: 'air', group: 'Plugins', label: 'Air and pollen', detail: 'Air quality and pollen where the person you select is, next to the weather (swipe the tile).', on: false },
  { id: 'homeAssistant', group: 'Plugins', label: 'Home Assistant', detail: 'Everyone’s location in your Home Assistant, to start automations. Each person can turn theirs off.', on: false, needs: 'locationSharing' },
];

export const FEATURE_GROUPS = ['Location', 'Chat', 'Alerts', 'Helper', 'Plugins'];
const IDS = new Set(FEATURES.map((f) => f.id));

/** What a new circle starts with: { id: true | false }. */
export const defaultFeatures = () => Object.fromEntries(FEATURES.map((f) => [f.id, f.on]));

/** Everything on (circles from before features could be chosen). */
export const allFeatures = () => Object.fromEntries(FEATURES.map((f) => [f.id, true]));

/** Only known features, as true/false. */
export function cleanFeatures(input) {
  const out = {};
  if (input && typeof input === 'object') for (const [k, v] of Object.entries(input)) if (IDS.has(k) && typeof v === 'boolean') out[k] = v;
  return out;
}

/** A circle's features as stored, with any newer feature at its default. */
export const resolveFeatures = (stored) => ({ ...defaultFeatures(), ...cleanFeatures(stored) });

/** Whether a feature works in a circle: it's on, and so is whatever it needs. */
export function hasFeature(features, id) {
  if (!features) return true;
  const f = FEATURES.find((x) => x.id === id);
  if (!f || features[id] === false) return false;
  return f.needs ? hasFeature(features, f.needs) : true;
}
