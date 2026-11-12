// Meshtastic trackers: trackers that work without a phone signal, through a
// home base at home (a Meshtastic node running HomeCircle; devices/meshtastic).
// The trackers and the home base are members of the circle; this plugin is
// the switch for all of it, and the settings the home base follows. The
// home base is an admin, reads them from here (GET /plugins/meshtastic/
// settings) and picks up changes within ten minutes.
//
// With the plugin off, the server takes no mesh packets for the circle and
// passes no requests to its home base, and the home base stays idle.
import { fail } from '../http.js';

const DEFAULTS = { quietMinutes: '30', traceMinutes: '30', sosWords: 'SOS, help' };

function minutes(label, v, lo, hi) {
  if (v === '') return '';
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) fail(400, 'invalid', `${label}: a whole number from ${lo} to ${hi}`);
  return String(n);
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
    };
    return out;
  },
  routes: [],
};
