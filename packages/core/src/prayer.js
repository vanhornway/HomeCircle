// Prayer times: the five daily prayers for a place and day, from where the sun
// is. These are approximations meant to show the window for each prayer, not
// a timetable a mosque would publish (those add a few minutes of caution).
//
// What changes them:
// - The madhab sets Asr: Hanafi when a thing's shadow is twice its length
//   (plus its noon shadow), Shafi'i, Maliki, Hanbali and Shia when it equals
//   its length. Shia (Ja'fari) also waits for the redness in the east to go
//   after sunset (Maghrib at the sun 4° below the horizon) and counts midnight
//   from sunset to Fajr.
// - The region sets Fajr and Isha: how far below the horizon the sun is when
//   dawn breaks and dusk ends differs by authority (North America uses 15°,
//   South Asia 18°, Egypt 19.5°…; Makkah puts Isha 90 minutes after Maghrib).
//   The place's time zone picks its region's method.
// - Far north and south, where dusk can last all night in summer, Fajr and
//   Isha are kept within a share of the night (the angle-based rule).
// Methods and angles as Aladhan and PrayTimes.org publish them.

/** The madhabs a person can choose: Asr's shadow length, and Shia's own method. */
export const MADHABS = [
  { id: 'shafi', label: 'Shafi‘i' },
  { id: 'hanafi', label: 'Hanafi' },
  { id: 'maliki', label: 'Maliki' },
  { id: 'hanbali', label: 'Hanbali' },
  { id: 'shia', label: 'Shia (Ja‘fari)' },
];
export const DEFAULT_MADHAB = 'shafi';

// fajr/isha: the sun's angle below the horizon, or isha in minutes after
// maghrib; maghrib: an angle, or minutes after sunset (0 = at sunset).
export const METHODS = {
  MWL: { name: 'Muslim World League', fajr: 18, isha: 17 },
  ISNA: { name: 'ISNA (North America)', fajr: 15, isha: 15 },
  KARACHI: { name: 'University of Islamic Sciences, Karachi', fajr: 18, isha: 18 },
  EGYPT: { name: 'Egyptian General Authority of Survey', fajr: 19.5, isha: 17.5 },
  MAKKAH: { name: 'Umm al-Qura, Makkah', fajr: 18.5, ishaMinutes: 90 },
  GULF: { name: 'Gulf region', fajr: 19.5, ishaMinutes: 90 },
  KUWAIT: { name: 'Kuwait', fajr: 18, isha: 17.5 },
  QATAR: { name: 'Qatar', fajr: 18, ishaMinutes: 90 },
  SINGAPORE: { name: 'MUIS, Singapore', fajr: 20, isha: 18 },
  JAKIM: { name: 'JAKIM, Malaysia', fajr: 20, isha: 18 },
  KEMENAG: { name: 'Kemenag, Indonesia', fajr: 20, isha: 18 },
  TURKEY: { name: 'Diyanet, Türkiye', fajr: 18, isha: 17 },
  FRANCE: { name: 'UOIF, France', fajr: 12, isha: 12 },
  RUSSIA: { name: 'Spiritual Administration, Russia', fajr: 16, isha: 15 },
  TUNISIA: { name: 'Tunisia', fajr: 18, isha: 18 },
  ALGERIA: { name: 'Algeria', fajr: 18, isha: 17 },
  MOROCCO: { name: 'Morocco', fajr: 19, isha: 17 },
  JORDAN: { name: 'Jordan', fajr: 18, isha: 18, maghribMinutes: 5 },
  TEHRAN: { name: 'University of Tehran', fajr: 17.7, isha: 14, maghrib: 4.5, shia: true },
  JAFARI: { name: 'Leva Institute, Qum (Ja‘fari)', fajr: 16, isha: 14, maghrib: 4, shia: true },
};

// The time zone's region → its usual method. Anything not listed: MWL.
const ZONES = [
  [/^Asia\/(Karachi|Kolkata|Calcutta|Dhaka|Dacca|Kabul|Kathmandu|Katmandu|Colombo|Thimphu)$/, 'KARACHI'],
  [/^Asia\/(Riyadh|Aden)$/, 'MAKKAH'],
  [/^Asia\/(Dubai|Muscat)$/, 'GULF'],
  [/^Asia\/Kuwait$/, 'KUWAIT'],
  [/^Asia\/(Qatar|Bahrain)$/, 'QATAR'],
  [/^Asia\/Amman$/, 'JORDAN'],
  [/^(Africa\/(Cairo|Khartoum|Tripoli|Juba)|Asia\/(Damascus|Beirut|Baghdad|Gaza|Hebron|Jerusalem))$/, 'EGYPT'],
  [/^Asia\/Tehran$/, 'TEHRAN'],
  [/^(Europe|Asia)\/Istanbul$/, 'TURKEY'],
  [/^Europe\/Paris$/, 'FRANCE'],
  [/^(Europe\/(Moscow|Kirov|Volgograd|Samara|Ulyanovsk|Astrakhan|Saratov)|Asia\/(Yekaterinburg|Omsk|Novosibirsk|Barnaul|Tomsk|Novokuznetsk|Krasnoyarsk|Irkutsk|Chita|Yakutsk|Vladivostok|Magadan|Kamchatka))$/, 'RUSSIA'],
  [/^Asia\/(Singapore|Brunei)$/, 'SINGAPORE'],
  [/^Asia\/(Kuala_Lumpur|Kuching)$/, 'JAKIM'],
  [/^Asia\/(Jakarta|Pontianak|Makassar|Jayapura)$/, 'KEMENAG'],
  [/^Africa\/Tunis$/, 'TUNISIA'],
  [/^Africa\/Algiers$/, 'ALGERIA'],
  [/^Africa\/(Casablanca|El_Aaiun)$/, 'MOROCCO'],
  // The US and Canada (Mexico and the rest of the Americas: MWL).
  [/^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Nome|Adak|Boise|Detroit|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+|Menominee|Toronto|Vancouver|Edmonton|Winnipeg|Regina|Halifax|St_Johns|Moncton|Glace_Bay|Whitehorse|Yellowknife|Iqaluit|Swift_Current)|Pacific\/Honolulu)$/, 'ISNA'],
];

/** The method for a time zone and madhab: Shia use Ja'fari (Tehran's in Iran); everyone else, their region's. */
export function methodFor(timezone, madhab = DEFAULT_MADHAB) {
  if (madhab === 'shia') return timezone === 'Asia/Tehran' ? 'TEHRAN' : 'JAFARI';
  for (const [re, id] of ZONES) if (re.test(timezone ?? '')) return id;
  return 'MWL';
}

// --- The sun --------------------------------------------------------------------
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const fix = (a, b) => ((a % b) + b) % b;

/** Declination and equation of time (hours) for a Julian day. */
function sun(jd) {
  const d = jd - 2451545.0;
  const g = fix(357.529 + 0.98560028 * d, 360);
  const q = fix(280.459 + 0.98564736 * d, 360);
  const l = fix(q + 1.915 * Math.sin(rad(g)) + 0.02 * Math.sin(rad(2 * g)), 360);
  const e = 23.439 - 0.00000036 * d;
  const ra = fix(deg(Math.atan2(Math.cos(rad(e)) * Math.sin(rad(l)), Math.cos(rad(l)))) / 15, 24);
  return { decl: deg(Math.asin(Math.sin(rad(e)) * Math.sin(rad(l)))), eqt: q / 15 - ra };
}

/**
 * Prayer times for one calendar day at a place, as instants (ms since 1970),
 * or null where the sun doesn't reach that angle (polar day or night).
 *   { fajr, sunrise, dhuhr, asr, maghrib, isha, midnight }
 * `date` is 'YYYY-MM-DD', the day as it is at that place.
 */
export function prayerTimes({ lat, lng, date, madhab = DEFAULT_MADHAB, method }) {
  const m = METHODS[method] ?? METHODS.MWL;
  const [y, mo, d] = date.split('-').map(Number);
  // Julian day of that date's midnight, shifted to the place's longitude.
  const jy = mo <= 2 ? y - 1 : y;
  const jm = mo <= 2 ? mo + 12 : mo;
  const century = Math.floor(jy / 100);
  const jd = Math.floor(365.25 * (jy + 4716)) + Math.floor(30.6001 * (jm + 1)) + d + 2 - century + Math.floor(century / 4) - 1524.5 - lng / 360;

  // Times below are hours of local solar time; each is worked out from the
  // sun's position at a guess of itself, made twice (the second from the first).
  const noon = (t) => fix(12 - sun(jd + t / 24).eqt, 24);
  /** When the sun is `angle`° below the horizon, before (ccw) or after noon. */
  const at = (angle, t, ccw) => {
    const { decl } = sun(jd + t / 24);
    const c = (-Math.sin(rad(angle)) - Math.sin(rad(decl)) * Math.sin(rad(lat))) / (Math.cos(rad(decl)) * Math.cos(rad(lat)));
    if (c < -1 || c > 1) return NaN;
    const h = deg(Math.acos(c)) / 15;
    return noon(t) + (ccw ? -h : h);
  };
  /** Asr: when a thing's shadow is `factor` times its length, plus its shadow at noon. */
  const asrAt = (factor, t, noonT) => {
    const { decl } = sun(jd + noonT / 24);
    return at(-deg(Math.atan(1 / (factor + Math.tan(rad(Math.abs(lat - decl)))))), t, false);
  };

  let g = { fajr: 5, sunrise: 6, dhuhr: 12, asr: 13, sunset: 18, maghrib: 18, isha: 18 };
  for (let pass = 0; pass < 2; pass++) {
    const next = {
      fajr: at(m.fajr, g.fajr, true),
      sunrise: at(0.833, g.sunrise, true),
      dhuhr: noon(g.dhuhr),
      asr: asrAt(madhab === 'hanafi' ? 2 : 1, g.asr, g.dhuhr),
      sunset: at(0.833, g.sunset, false),
      maghrib: m.maghrib ? at(m.maghrib, g.maghrib, false) : NaN,
      isha: m.ishaMinutes ? NaN : at(m.isha, g.isha, false),
    };
    // Where the sun never gets there, the next guess stays as it was.
    g = Object.fromEntries(Object.entries(next).map(([k, v]) => [k, Number.isFinite(v) || pass === 1 ? v : g[k]]));
  }
  const { sunrise, sunset, dhuhr, asr } = g;
  let { fajr } = g;
  let isha = m.ishaMinutes ? sunset + m.ishaMinutes / 60 : g.isha;
  const maghrib = m.maghrib ? g.maghrib : sunset + (m.maghribMinutes ?? 0) / 60;

  // Far from the equator: dawn no earlier, and dusk no later, than a share of the night.
  const night = 24 - (sunset - sunrise);
  if (Number.isFinite(night)) {
    const share = (angle) => (angle / 60) * night;
    if (!(sunrise - fajr <= share(m.fajr))) fajr = sunrise - share(m.fajr);
    if (!m.ishaMinutes && !(isha - sunset <= share(m.isha))) isha = sunset + share(m.isha);
  }
  // Midnight: halfway from sunset to sunrise (Shia: to Fajr), tomorrow's taken as today's.
  const midnight = sunset + ((m.shia ? fajr : sunrise) + 24 - sunset) / 2;

  const base = Date.UTC(y, mo - 1, d);
  const instant = (h) => (Number.isFinite(h) ? Math.round(base + (h - lng / 15) * 3_600_000) : null);
  return {
    fajr: instant(fajr),
    sunrise: instant(sunrise),
    dhuhr: instant(dhuhr),
    asr: instant(asr),
    maghrib: instant(maghrib),
    isha: instant(isha),
    midnight: instant(midnight),
  };
}

/** The five prayers in order, each from its time until the next one's window closes. */
export const PRAYERS = [
  { id: 'fajr', name: 'Fajr', until: 'sunrise' },
  { id: 'dhuhr', name: 'Dhuhr', until: 'asr' },
  { id: 'asr', name: 'Asr', until: 'maghrib' },
  { id: 'maghrib', name: 'Maghrib', until: 'isha' },
  { id: 'isha', name: 'Isha', until: 'midnight' },
];

/**
 * Where things stand at `now` over a few days of times: the prayer whose
 * window is open (or null), and the next one to start.
 *   days: [{ date, times }] in order, as the prayer plugin sends them
 */
export function prayerNow(days, now = Date.now()) {
  const all = days.flatMap((day) => PRAYERS.map((p) => ({ ...p, date: day.date, start: day.times[p.id], end: day.times[p.until] }))).filter((p) => p.start != null);
  const current = all.find((p) => p.start <= now && p.end != null && now < p.end) ?? null;
  const next = all.find((p) => p.start > now) ?? null;
  return { current, next };
}
