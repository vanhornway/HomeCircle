// Calendars: addresses, iCalendar parsing (repeats too), public-only
// fetching, and finding stretches when everyone's free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarUrl, parseIcs, isPublicHost, fetchPublic, freeStretches, isDayOff } from '../src/agent/calendar.js';

test('calendar addresses: webcal, Google share links, and what doesn’t work', () => {
  assert.equal(calendarUrl('webcal://p01-calendars.icloud.com/published/2/abc').url, 'https://p01-calendars.icloud.com/published/2/abc');
  const id = 'lincoln.elementary@gmail.com';
  const share = `https://calendar.google.com/calendar/u/0?cid=${Buffer.from(id).toString('base64')}`;
  assert.equal(calendarUrl(share).url, 'https://calendar.google.com/calendar/ical/lincoln.elementary%40gmail.com/public/basic.ics');
  assert.equal(calendarUrl(`https://calendar.google.com/calendar/embed?src=${encodeURIComponent(id)}`).url, calendarUrl(share).url);
  assert.throws(() => calendarUrl('https://calendar.google.com/calendar/u/0/r'), /iCal format/);
  assert.throws(() => calendarUrl('ftp://example.com/cal.ics'), /http/);
  // Shared files: the file itself, not the page about it.
  assert.equal(calendarUrl('https://drive.google.com/file/d/1AbC-dEf_9/view?usp=sharing').url, 'https://drive.google.com/uc?export=download&id=1AbC-dEf_9');
  assert.equal(calendarUrl('https://www.dropbox.com/scl/fi/xyz/cal.pdf?rlkey=k&dl=0').url, 'https://www.dropbox.com/scl/fi/xyz/cal.pdf?rlkey=k&dl=1');
});

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:thanks@lincoln
DTSTART;VALUE=DATE:20261125
DTEND;VALUE=DATE:20261128
SUMMARY:Thanksgiving Break - No School
END:VEVENT
BEGIN:VEVENT
UID:winter@lincoln
DTSTART;VALUE=DATE:20261221
DTEND;VALUE=DATE:20270102
SUMMARY:Winter Recess
END:VEVENT
BEGIN:VEVENT
UID:first@lincoln
DTSTART;VALUE=DATE:20260819
SUMMARY:First Day of School
END:VEVENT
BEGIN:VEVENT
UID:last@lincoln
DTSTART;VALUE=DATE:20270611
SUMMARY:Last Day of School
END:VEVENT
BEGIN:VEVENT
UID:soccer@club
DTSTART;TZID=America/Los_Angeles:20261003T090000
DTEND;TZID=America/Los_Angeles:20261003T103000
RRULE:FREQ=WEEKLY;BYDAY=SA;COUNT=4
EXDATE;TZID=America/Los_Angeles:20261010T090000
SUMMARY:Soccer practice\\, U10
END:VEVENT
BEGIN:VEVENT
UID:gone@club
DTSTART;VALUE=DATE:20261101
STATUS:CANCELLED
SUMMARY:Cancelled game
END:VEVENT
END:VCALENDAR`;

test('iCalendar: all-day ends are inclusive, repeats expand, exceptions and cancellations drop', () => {
  const ev = parseIcs(ICS);
  const by = (uid) => ev.filter((e) => e.uid === uid);
  assert.deepEqual(
    by('thanks@lincoln').map((e) => [e.start, e.end, e.allDay]),
    [['2026-11-25', '2026-11-27', true]],
  );
  assert.deepEqual(
    by('soccer@club').map((e) => [e.start, e.time, e.summary]),
    [
      ['2026-10-03', '09:00', 'Soccer practice, U10'],
      ['2026-10-17', '09:00', 'Soccer practice, U10'],
      ['2026-10-24', '09:00', 'Soccer practice, U10'],
    ],
  );
  assert.equal(by('gone@club').length, 0);
  assert.deepEqual(
    parseIcs(ICS, { from: '2026-12-01', to: '2026-12-31' }).map((e) => e.uid),
    ['winter@lincoln'],
  );
});

test('which school-calendar days are days off', () => {
  assert.ok(isDayOff('Thanksgiving Break - No School'));
  assert.ok(isDayOff('Teacher Work Day (no students)'));
  assert.ok(!isDayOff('First Day of School'));
  assert.ok(!isDayOff('Minimum Day - Early Release'));
});

test('free stretches: everyone off school and not booked, for N days in a row', () => {
  const school = parseIcs(ICS);
  const kid = { school, busy: [] };
  const sam = { school, busy: [{ start: '2026-11-28', end: '2026-11-28', summary: 'Recital' }] };
  // From Nov 10: Thanksgiving Wed–Fri + the weekend is 5 days for Kid alone…
  assert.deepEqual(freeStretches([kid], { days: 5, from: '2026-11-10', limit: 1 }), [{ start: '2026-11-25', end: '2026-11-29' }]);
  // …but Sam has a recital on Saturday, so together the next 5 days come at winter break.
  assert.deepEqual(freeStretches([kid, sam], { days: 5, from: '2026-11-10', limit: 1 }), [{ start: '2026-12-19', end: '2027-01-03' }]);
  // Outside the school year (summer) every day is free.
  assert.deepEqual(freeStretches([kid], { days: 10, from: '2027-06-10', limit: 1 })[0].start, '2027-06-12');
});

test('free stretches: a PDF’s dates count as off when marked off, whatever they’re called', () => {
  const day = (summary, start, end, off) => ({ summary, start, end: end ?? start, allDay: true, off });
  const school = [day('First day', '2026-08-19', null, false), day('Fall recess', '2026-10-12', '2026-10-16', true), day('Last day', '2027-06-11', null, false)];
  assert.deepEqual(freeStretches([{ school, busy: [] }], { days: 9, from: '2026-10-01', limit: 1 }), [{ start: '2026-10-10', end: '2026-10-18' }]);
  // Not marked off: a school week like any other.
  const notOff = school.map((e) => ({ ...e, off: false }));
  assert.notDeepEqual(freeStretches([{ school: notOff, busy: [] }], { days: 9, from: '2026-10-01', limit: 1 }), [{ start: '2026-10-10', end: '2026-10-18' }]);
});

test('only public addresses are fetched (never the home network)', async () => {
  assert.equal(await isPublicHost('127.0.0.1'), false);
  assert.equal(await isPublicHost('192.168.1.20'), false);
  assert.equal(await isPublicHost('10.0.0.5'), false);
  assert.equal(await isPublicHost('[::1]'), false);
  assert.equal(await isPublicHost('169.254.169.254'), false);
  assert.equal(await isPublicHost('8.8.8.8'), true);
  await assert.rejects(() => fetchPublic('http://127.0.0.1:8080/api/v1/state'), /private network/);
  // A public address that redirects into the home network is stopped too.
  const fakeFetch = async () => new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/admin' } });
  await assert.rejects(() => fetchPublic('http://8.8.8.8/cal.ics', { fetchImpl: fakeFetch }), /private network/);
});
