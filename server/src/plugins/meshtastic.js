// Meshtastic trackers: trackers that work without a phone signal, through a
// home base at home (a Meshtastic node running HomeCircle; devices/meshtastic).
// The trackers and the home base are members of the circle; this plugin is
// the switch for all of it, and the settings the home base follows. The
// home base is an admin, reads them from here (GET /plugins/meshtastic/
// settings) and picks up changes within ten minutes.
//
// The fields in the 'trackers' section are every tracker's settings, unless
// an admin gives one tracker its own (its member record, `tracker.custom`):
// how often it sends its position and battery, which the home base sets on
// the tracker over the radio, and what each number of button presses says.
//
// With the plugin off, the server takes no mesh packets for the circle and
// passes no requests to its home base, and the home base stays idle.
import { fail } from '../http.js';

const DEFAULTS = { quietMinutes: '30', traceMinutes: '30', sosWords: 'SOS, help' };

/** What each number of presses on a tracker's button does (HomeCircle tracker firmware). */
export const PRESSES = [
  { n: 1, what: 'I’m OK', text: '✅ I’m OK', help: 'Answers “Ask to check in” when the tracker has beeped for one. On its own it sends nothing, so a bump in a pocket stays quiet.' },
  { n: 2, what: 'Here’s where I am', text: '📍 Here’s where I am', help: 'Sends this message and a fresh position to the circle.' },
  { n: 3, what: 'Come pick me up', text: '🚗 Please come pick me up', help: 'Sends this message and a fresh position, as an urgent alert.' },
  { n: 4, what: 'On my way home', text: '🏠 I’m on my way home', help: 'Sends this message and a fresh position.' },
  { n: 5, what: 'SOS', text: '🆘 I need help', help: 'Starts an SOS on everyone’s phone, with this message. 5 presses again send “I’m safe” and end it.' },
];
export const TRACKER_DEFAULTS = { movingMinutes: '2', stillMinutes: '15', batteryMinutes: '30', ...Object.fromEntries(PRESSES.map((p) => [`press${p.n}`, p.text])) };

function minutes(label, v, lo, hi) {
  if (v === '') return '';
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) fail(400, 'invalid', `${label}: a whole number from ${lo} to ${hi}`);
  return String(n);
}

/** A press's message: one line, at most 80 characters ('' for the default). */
export function pressText(v) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export const meshtastic = {
  id: 'meshtastic',
  feature: 'meshtastic',
  name: 'Meshtastic trackers',
  hosts: [],
  settings: [
    {
      id: 'quietMinutes',
      label: 'A phone counts as quiet after (minutes)',
      numeric: true,
      optional: true,
      placeholder: DEFAULTS.quietMinutes,
      help: 'Then the home base asks the tracker that person carries where it is, and the map shows them at the tracker. 10 to 720; 30 if empty.',
    },
    {
      id: 'traceMinutes',
      label: 'Check each tracker’s radio path every (minutes)',
      numeric: true,
      optional: true,
      placeholder: DEFAULTS.traceMinutes,
      help: 'Which nodes a tracker’s messages pass through to reach home, shown on its pin. 0 traces only when someone taps Locate. 0 or 10 to 720; 30 if empty.',
    },
    {
      id: 'sosWords',
      label: 'Words that start an SOS',
      optional: true,
      placeholder: DEFAULTS.sosWords,
      help: 'A tracker’s message with any of these (separated by commas) is an SOS from it; “ok” or “safe” ends it. The SenseCAP T1000-E with HomeCircle sends “SOS” on 5 presses.',
    },
    {
      id: 'movingMinutes',
      section: 'trackers',
      label: 'While moving, send its position every (minutes)',
      numeric: true,
      optional: true,
      placeholder: TRACKER_DEFAULTS.movingMinutes,
      help: 'At most this often while it moves (100 m or more). 1 to 60; 2 if empty.',
    },
    {
      id: 'stillMinutes',
      section: 'trackers',
      label: 'Otherwise, every (minutes)',
      numeric: true,
      optional: true,
      placeholder: TRACKER_DEFAULTS.stillMinutes,
      help: 'Less often saves its battery. 5 to 720; 15 if empty.',
    },
    {
      id: 'batteryMinutes',
      section: 'trackers',
      label: 'Report its battery every (minutes)',
      numeric: true,
      optional: true,
      placeholder: TRACKER_DEFAULTS.batteryMinutes,
      help: '0 for never. 0 or 5 to 720; 30 if empty.',
    },
    ...PRESSES.map((p) => ({
      id: `press${p.n}`,
      section: 'trackers',
      label: `${p.n} press${p.n === 1 ? '' : 'es'}: ${p.what}`,
      optional: true,
      placeholder: p.text,
      help: p.help,
    })),
  ],
  configure: async (values) => {
    const out = {
      quietMinutes: minutes('A phone counts as quiet after', values.quietMinutes, 10, 720),
      traceMinutes: values.traceMinutes === '0' ? '0' : minutes('Check each tracker’s radio path every', values.traceMinutes, 10, 720),
      sosWords: values.sosWords
        .split(',')
        .map((w) => w.trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ''))
        .filter((w) => w.length >= 2)
        .slice(0, 8)
        .join(', '),
      movingMinutes: minutes('While moving, send its position every', values.movingMinutes, 1, 60),
      stillMinutes: minutes('Otherwise, every', values.stillMinutes, 5, 720),
      batteryMinutes: values.batteryMinutes === '0' ? '0' : minutes('Report its battery every', values.batteryMinutes, 5, 720),
    };
    for (const p of PRESSES) out[`press${p.n}`] = pressText(values[`press${p.n}`]);
    return out;
  },
  routes: [],
};
