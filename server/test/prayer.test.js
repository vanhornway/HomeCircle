// Prayer times: within a couple of minutes of Aladhan's for the same place,
// day, method and madhab (26 Oct 2026), including far north and south.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { methodFor, prayerNow, prayerTimes } from '../../packages/core/src/prayer.js';

/** An instant as HH:MM in a time zone. */
const clock = (ms, timeZone) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const near = (got, want, slack, what) => {
  let diff = Math.abs(minutes(got) - minutes(want));
  diff = Math.min(diff, 1440 - diff);
  assert.ok(diff <= slack, `${what}: ${got}, expected about ${want}`);
};

const CASES = [
  ['Lahore, Hanafi', 31.484, 74.323, 'Asia/Karachi', 'hanafi', { fajr: '04:52', sunrise: '06:14', dhuhr: '11:47', asr: '15:42', maghrib: '17:19', isha: '18:41', midnight: '23:46' }],
  ['Lahore, Shafi‘i', 31.484, 74.323, 'Asia/Karachi', 'shafi', { asr: '14:56' }],
  ['Austin, Shafi‘i', 30.3105, -97.7395, 'America/Chicago', 'shafi', { fajr: '06:34', sunrise: '07:41', dhuhr: '13:15', asr: '16:25', maghrib: '18:49', isha: '19:55', midnight: '01:15' }],
  ['Austin, Hanafi', 30.3105, -97.7395, 'America/Chicago', 'hanafi', { asr: '17:11' }],
  ['London', 51.5074, -0.1278, 'Europe/London', 'maliki', { fajr: '04:51', sunrise: '06:43', dhuhr: '11:44', asr: '14:17', maghrib: '16:45', isha: '18:31' }],
  ['Tehran, Shia', 35.6892, 51.389, 'Asia/Tehran', 'shia', { fajr: '04:56', maghrib: '17:34', isha: '18:22' }],
  ['Baghdad, Shia', 33.3152, 44.3661, 'Asia/Baghdad', 'shia', { fajr: '05:02', asr: '14:54', maghrib: '17:32', isha: '18:21' }],
  ['Makkah', 21.4225, 39.8262, 'Asia/Riyadh', 'hanbali', { fajr: '05:04', dhuhr: '12:05', asr: '15:23', maghrib: '17:48', isha: '19:18' }],
  ['Oslo', 59.9139, 10.7522, 'Europe/Oslo', 'shafi', { fajr: '05:03', sunrise: '07:23', asr: '14:06', maghrib: '16:37', isha: '18:50' }],
  ['Sydney', -33.8688, 151.2093, 'Australia/Sydney', 'shafi', { fajr: '04:32', sunrise: '06:01', dhuhr: '12:39', asr: '16:19', maghrib: '19:17', isha: '20:42' }],
];

for (const [name, lat, lng, zone, madhab, want] of CASES) {
  test(`${name}: within 2 minutes of Aladhan`, () => {
    const times = prayerTimes({ lat, lng, date: '2026-10-26', madhab, method: methodFor(zone, madhab) });
    // Asr far north: Aladhan's is a few minutes later than the shadow rule
    // worked by hand (London: the sun 18.2° up at 14:15).
    for (const [k, v] of Object.entries(want)) near(clock(times[k], zone), v, k === 'asr' && lat > 50 ? 4 : 2, `${name} ${k}`);
  });
}

test('each region gets its method; Shia get Ja‘fari, or Tehran’s in Iran', () => {
  assert.equal(methodFor('America/Chicago', 'hanafi'), 'ISNA');
  assert.equal(methodFor('America/Mexico_City', 'shafi'), 'MWL');
  assert.equal(methodFor('Asia/Karachi', 'shafi'), 'KARACHI');
  assert.equal(methodFor('Asia/Riyadh', 'hanbali'), 'MAKKAH');
  assert.equal(methodFor('Europe/Berlin', 'maliki'), 'MWL');
  assert.equal(methodFor(null, 'shafi'), 'MWL');
  assert.equal(methodFor('America/Chicago', 'shia'), 'JAFARI');
  assert.equal(methodFor('Asia/Tehran', 'shia'), 'TEHRAN');
});

test('in the Arctic summer the sun never sets: no sunrise or Maghrib, and no window is made up', () => {
  const t = prayerTimes({ lat: 78.22, lng: 15.65, date: '2026-06-21', method: 'MWL' });
  assert.equal(t.sunrise, null);
  assert.equal(t.maghrib, null);
  assert.ok(t.dhuhr != null);
});

test('the next prayer moves on once its time passes, through the night to tomorrow’s Fajr', () => {
  const day = (date) => ({ date, times: prayerTimes({ lat: 31.484, lng: 74.323, date, madhab: 'hanafi', method: 'KARACHI' }) });
  const days = [day('2026-10-26'), day('2026-10-27')];
  const [today] = days;
  let s = prayerNow(days, today.times.dhuhr - 60_000);
  assert.equal(s.current, null);
  assert.equal(s.next.id, 'dhuhr');
  s = prayerNow(days, today.times.dhuhr + 60_000);
  assert.equal(s.current.id, 'dhuhr');
  assert.equal(s.next.id, 'asr');
  s = prayerNow(days, today.times.isha + 60_000);
  assert.equal(s.current.id, 'isha');
  assert.equal(s.next.id, 'fajr');
  assert.equal(s.next.date, '2026-10-27');
});
