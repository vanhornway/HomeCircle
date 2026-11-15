// The demo family: twenty made-up people in a made-up suburb, Alder Creek, on
// real Bay Area streets. Every place name is invented except Costco, a store
// the family shops at. Nothing here is anyone's real home or school.

export const CIRCLE_NAME = 'Demo family';
export const HELPER = 'Birdie';
export const TIME_ZONE = 'America/Los_Angeles';

// What a demo circle has on. Calls come in a later phase: nobody would answer.
// SOS stays off so nobody sets off an alarm in a family that isn't there.
export const FEATURES = {
  locationSharing: true,
  locate: true,
  placeAlerts: true,
  checkIns: true,
  frequentPlaces: true,
  lowBattery: true,
  groupChat: true,
  directMessages: true,
  polls: true,
  calls: false,
  photos: true,
  readReceipts: true,
  chirps: true,
  sos: false,
  circleHealth: true,
  agent: true,
  shoppingLists: true,
  reminders: true,
  uploads: false,
  weather: true,
  air: false,
  prayer: false,
  whatsapp: false,
  homeAssistant: false,
};

export const PLACES = {
  home: { name: 'Home', lat: 37.530377, lng: -121.946057, icon: 'home' },
  nani: { name: 'Nani’s house', lat: 37.52296, lng: -121.961609, icon: 'home' },
  sana: { name: 'Sana & Dev’s', lat: 37.514545, lng: -121.938303, icon: 'home' },
  lina: { name: 'Lina & Marco’s', lat: 37.554226, lng: -121.94933, icon: 'home' },
  maple: { name: 'Maple Grove Elementary', lat: 37.536378, lng: -121.960843, icon: 'school' },
  ridge: { name: 'Ridgeview Middle', lat: 37.525343, lng: -121.932841, icon: 'school' },
  alder: { name: 'Alder Creek High', lat: 37.548021, lng: -121.974482, icon: 'school' },
  office: { name: 'Bayline Offices', lat: 37.492712, lng: -121.944609, icon: 'work' },
  clinic: { name: 'Creekside Clinic', lat: 37.557369, lng: -121.978701, icon: 'work' },
  field: { name: 'Mission Fields', lat: 37.5175, lng: -121.981, radius: 200, icon: 'park' },
  market: { name: 'Fresh Valley Market', lat: 37.533119, lng: -121.91941, icon: 'store' },
  bazaar: { name: 'Spice Bazaar', lat: 37.5255, lng: -121.964, icon: 'store' },
  costco: { name: 'Costco', lat: 37.5014494, lng: -121.9729571, radius: 250, icon: 'store' },
  park: { name: 'Lakeside Park', lat: 37.5484, lng: -121.9618, radius: 250, icon: 'park' },
  library: { name: 'Alder Creek Library', lat: 37.5506, lng: -121.9712, icon: 'pin' },
};

// `at`: the place they start the day. `elder`: the Elderly Companion profile.
// `kid`: answers like a kid. `perm` and `power` show up in Circle health.
export const PEOPLE = {
  maya: { name: 'Maya', at: 'home', battery: 0.92, tone: 'parent', note: 'Physical therapist at Creekside Clinic. Mom of Zara, Leo and Noor.' },
  omar: { name: 'Omar', at: 'home', battery: 0.85, tone: 'parent', note: 'Works at Bayline Offices. Dad of Zara, Leo and Noor.' },
  zara: { name: 'Zara', at: 'home', battery: 0.66, tone: 'teen', note: 'Zara is 16 and goes to Alder Creek High.' },
  leo: { name: 'Leo', at: 'home', battery: 0.91, tone: 'kid', perm: 'foreground', note: 'Leo is 10 and goes to Maple Grove Elementary.' },
  noor: { name: 'Noor', at: 'home', battery: 0.97, tone: 'kid', note: 'Noor is 6, goes to Maple Grove Elementary, and has a kids’ watch.' },
  dada: { name: 'Dada', at: 'home', battery: 0.58, tone: 'elder', note: 'Omar’s father. Lives with Maya and Omar.' },
  nani: { name: 'Nani', at: 'nani', battery: 0.44, tone: 'elder', elder: true, power: 'saver', note: 'Maya’s and Sana’s mother, on the simple Elderly Companion screens.' },
  nana: { name: 'Nana', at: 'nani', battery: 0.71, tone: 'elder', note: 'Maya’s and Sana’s father. Drives Nani to her appointments.' },
  tariq: { name: 'Uncle Tariq', at: 'nani', battery: 0.63, tone: 'parent', note: 'Maya’s younger brother. Lives upstairs at Nani’s and works from home.' },
  sana: { name: 'Aunt Sana', at: 'sana', battery: 0.81, tone: 'parent', note: 'Maya’s sister. Librarian at Alder Creek Library.' },
  dev: { name: 'Uncle Dev', at: 'sana', battery: 0.77, tone: 'parent', note: 'Sana’s husband. Works at Bayline Offices.' },
  ayaan: { name: 'Ayaan', at: 'sana', battery: 0.31, tone: 'teen', note: 'Ayaan is 14, a cousin, at Alder Creek High.' },
  priya: { name: 'Priya', at: 'sana', battery: 0.74, tone: 'teen', note: 'Priya is 12, a cousin, at Ridgeview Middle.' },
  kabir: { name: 'Kabir', at: 'sana', battery: 0.88, tone: 'kid', note: 'Kabir is 8, a cousin, at Maple Grove Elementary.' },
  lina: { name: 'Aunt Lina', at: 'lina', battery: 0.69, tone: 'parent', note: 'Omar’s sister. Runs the bakery counter at Fresh Valley Market.' },
  marco: { name: 'Uncle Marco', at: 'lina', battery: 0.83, tone: 'parent', note: 'Lina’s husband. Works at Bayline Offices.' },
  hana: { name: 'Hana', at: 'lina', battery: 0.52, tone: 'teen', note: 'Hana is 20, a cousin, home from college and studying at the library.' },
  sofia: { name: 'Sofia', at: 'lina', battery: 0.61, tone: 'teen', note: 'Sofia is 17, a cousin, at Alder Creek High. She has her license.' },
  nico: { name: 'Nico', at: 'lina', battery: 0.9, tone: 'kid', note: 'Nico is 9, a cousin, at Maple Grove Elementary.' },
  mateo: { name: 'Mateo', at: 'lina', battery: 0.95, tone: 'kid', note: 'Mateo is 5, a cousin, in kindergarten at Maple Grove Elementary.' },
};

/** Who is in the family (Maya makes the circle). */
export const OWNER = 'maya';

// A day squeezed into the hour: 7 am at minute 0, about 9 pm at minute 60.
// Each trip: who goes, from where to where, at which minute, for how many,
// and the speed their phones report (m/s). Times are minutes of a 60-minute
// demo; a shorter demo scales them.
const ride = (who, from, to, at, mins, speed = 12) => ({ who, from, to, at, mins, speed });

export const TRIPS = [
  // The school run and the commutes.
  ride(['omar', 'zara'], 'home', 'alder', 1.5, 3.5),
  ride(['maya', 'leo', 'noor'], 'home', 'maple', 2, 3),
  ride(['sana', 'priya', 'kabir'], 'sana', 'ridge', 3, 2.5),
  ride(['dev', 'ayaan'], 'sana', 'alder', 3, 4),
  ride(['sofia'], 'lina', 'alder', 2.5, 3),
  ride(['lina', 'nico', 'mateo'], 'lina', 'maple', 3.5, 3),
  ride(['marco'], 'lina', 'office', 4, 6, 18),
  ride(['omar'], 'alder', 'office', 5.5, 6, 18),
  ride(['maya'], 'maple', 'clinic', 5.5, 3.5),
  ride(['sana', 'kabir'], 'ridge', 'maple', 6, 3.5),
  ride(['lina'], 'maple', 'market', 7, 5),
  ride(['dev'], 'alder', 'office', 7.5, 6, 18),
  ride(['sana'], 'maple', 'library', 10, 3),
  ride(['hana'], 'lina', 'library', 9, 3),
  // Nani's doctor visit, and the spice shop on the way home.
  ride(['nani', 'nana'], 'nani', 'clinic', 13, 4),
  ride(['nani', 'nana'], 'clinic', 'bazaar', 21, 4),
  ride(['nani', 'nana'], 'bazaar', 'nani', 26, 2),
  // A walk in the park.
  ride(['dada'], 'home', 'park', 28, 6, 1.4),
  ride(['dada'], 'park', 'home', 37, 6, 1.4),
  // School's out: pickups, practice, the grocery stop.
  ride(['lina'], 'market', 'maple', 31, 5),
  ride(['lina', 'nico', 'mateo', 'kabir'], 'maple', 'sana', 37, 3),
  ride(['lina', 'nico', 'mateo'], 'sana', 'lina', 41, 4),
  ride(['sofia', 'zara', 'ayaan'], 'alder', 'library', 32, 1.5, 8),
  ride(['sana'], 'library', 'ridge', 32, 4.5),
  ride(['sana', 'priya'], 'ridge', 'sana', 37, 2.5),
  ride(['maya'], 'clinic', 'costco', 33, 5, 15),
  ride(['maya'], 'costco', 'maple', 39, 4),
  ride(['maya', 'leo', 'noor'], 'maple', 'field', 43, 3),
  ride(['maya', 'noor'], 'field', 'home', 46.5, 3.5),
  ride(['sofia', 'zara'], 'library', 'home', 45, 3),
  ride(['sofia'], 'home', 'lina', 48.5, 2.5),
  ride(['hana', 'ayaan'], 'library', 'sana', 46, 4),
  ride(['omar'], 'office', 'home', 44, 5, 18),
  ride(['dev'], 'office', 'sana', 46, 4, 18),
  ride(['marco'], 'office', 'lina', 46, 6, 18),
  // Dinner at Nani's: everyone comes.
  ride(['maya'], 'home', 'field', 51, 3),
  ride(['maya', 'leo'], 'field', 'nani', 54, 2.5),
  ride(['omar', 'zara', 'noor', 'dada'], 'home', 'nani', 52, 3),
  ride(['sana', 'dev', 'ayaan', 'priya', 'kabir'], 'sana', 'nani', 52, 3.5),
  ride(['hana'], 'sana', 'nani', 52.5, 3.5),
  ride(['lina', 'marco', 'sofia', 'nico', 'mateo'], 'lina', 'nani', 52, 4.5),
];

export const routeKey = (from, to) => `${from}>${to}`;
