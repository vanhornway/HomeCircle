// Kinds of circles the swarm builds: who is in them, where they go, and what
// they talk about. Times are in simulated minutes (see --speed).

const pick = (a) => a[Math.floor(Math.random() * a.length)];

const FIRST = {
  adults: ['Elena', 'Marco', 'Priya', 'Daniel', 'Aisha', 'Tom', 'Mei', 'Jorge', 'Sara', 'Kwame', 'Nina', 'Omar', 'Hannah', 'Luis', 'Grace', 'Ben', 'Yuki', 'Ravi', 'Chloe', 'Sam', 'Fatima', 'Leo', 'Ingrid', 'Diego'],
  kids: ['Maya', 'Noah', 'Zoe', 'Eli', 'Ava', 'Kai', 'Lila', 'Max', 'Ruby', 'Theo', 'Ivy', 'Finn', 'Nora', 'Jonah', 'Aria', 'Leo'],
  elders: ['Grandma Rose', 'Grandpa Joe', 'Nana Lucia', 'Papa Raj', 'Aunt Carol', 'Uncle Ted', 'Oma Greta', 'Abuela Inés'],
};
const SURNAMES = ['Garcia', 'Parker', 'Nguyen', 'Okafor', 'Schmidt', 'Rossi', 'Kim', 'Patel', 'Johnson', 'Haddad', 'Silva', 'Novak'];

function uniqueNames(pool, n) {
  const a = [...pool].sort(() => Math.random() - 0.5);
  const out = [];
  for (let i = 0; i < n; i++) out.push(i < a.length ? a[i] : `${pick(pool)} ${i}`);
  return out;
}

// A thread is a list of [who, text]. who: 'parent' | 'kid' | 'any' | 'other'
// (anyone but the person before) | 'starter' (whoever started it).
// {kid} {parent} {any} {place} are filled in from the circle.
const FAMILY_THREADS = [
  [['parent', 'Who’s picking up {kid} from {place}?'], ['other', 'I can, leaving work at 5:15'], ['starter', '👍 thanks!']],
  [['kid', 'can I go to {any}’s after school?'], ['parent', 'Homework first, then yes'], ['kid', 'ok 🙄'], ['parent', 'Home by 7 please']],
  [['parent', 'Dinner at 6:30 tonight, tacos 🌮'], ['kid', 'YES'], ['other', 'I’ll grab tortillas on the way home']],
  [['kid', 'forgot my lunch 😬'], ['parent', 'I’ll drop it at the front office'], ['kid', 'thank youuu']],
  [['parent', 'Soccer practice moved to 4pm'], ['other', 'Got it, I’ll do the drop-off'], ['kid', 'can we get boba after?']],
  [['parent', 'Running 10 minutes late, traffic'], ['other', 'No worries']],
  [['kid', 'what’s the wifi password again'], ['parent', 'It’s on the fridge 😄']],
  [['parent', 'Reminder: dentist tomorrow at 9 for {kid}'], ['other', 'On the calendar']],
  [['kid', 'I’m at {place}'], ['parent', '👍 text me when you leave']],
  [['parent', 'Anyone need anything from the store?'], ['kid', 'cereal pls'], ['other', 'Milk and eggs'], ['starter', 'On it']],
];
const FRIENDS_THREADS = [
  [['any', 'Anyone up for {place} tonight?'], ['other', 'I’m in!'], ['other', 'Can’t tonight 😩 next time'], ['starter', '7pm?'], ['other', '👍']],
  [['any', 'Did you all see the game last night??'], ['other', 'That last minute goal 🤯'], ['other', 'I fell asleep at halftime lol']],
  [['any', 'Brunch Sunday? {place}?'], ['other', 'Yes please 🥞'], ['other', 'Only if it’s after 11']],
  [['any', 'Running late, save me a seat'], ['other', 'Got you']],
  [['any', 'Who has my charger 😂'], ['other', 'Not me'], ['other', '…maybe me']],
  [['any', 'Happy birthday {any}!! 🎂🎉'], ['other', 'HBD!! 🥳'], ['other', 'Happy birthday!!']],
  [['any', 'Hike this weekend? Weather looks great'], ['other', 'Saturday works'], ['other', 'I’ll drive'], ['starter', '🙌']],
  [['any', 'Just landed ✈️'], ['other', 'Welcome back!']],
];
const WORK_THREADS = [
  [['any', 'Standup in 5'], ['other', '👍'], ['other', 'Joining from the car, 2 min late']],
  [['any', 'Lunch at {place}?'], ['other', 'Yes, 12:30'], ['other', 'I brought food today']],
  [['any', 'Is anyone in the office today?'], ['other', 'Here till 4'], ['other', 'Remote today']],
  [['any', 'Traffic on the 101 is terrible, I’ll be late'], ['other', 'Same here 😩']],
  [['any', 'Cake in the kitchen 🎂'], ['other', 'On my way'], ['other', 'Save me a piece!']],
  [['any', 'Can someone review my doc before 3?'], ['other', 'I’ll take a look after lunch']],
  [['any', 'Leaving now, see you tomorrow'], ['other', 'Bye!']],
];
const PARTY_THREADS = [
  [['any', 'Party starts at 8! Address is in the place pin 🎉'], ['other', 'Can’t wait'], ['other', 'What should I bring?'], ['starter', 'Drinks or snacks!']],
  [['any', 'Where do I park?'], ['other', 'Street parking on the side road'], ['starter', 'Thanks!']],
  [['any', 'Leaving now, ETA 20 min'], ['other', '🙌']],
  [['any', 'Is anyone driving from downtown? Need a ride'], ['other', 'I can pick you up at 7:30'], ['starter', 'Lifesaver 🙏']],
  [['any', 'Who brought the speaker 🔊'], ['other', 'Me!'], ['other', 'Play something good 😂']],
  [['any', 'Group photo in 5 minutes on the patio 📸'], ['other', 'Coming'], ['other', 'Wait for me!']],
  [['any', 'Thanks for coming everyone ❤️'], ['other', 'Best party of the year'], ['other', 'Get home safe!']],
];
const ELDER_THREADS = [
  [['elder', 'Good morning everyone ☀️'], ['other', 'Morning Grandma ❤️'], ['other', 'Good morning!']],
  [['elder', 'How do I send a picture on here?'], ['other', 'Tap the + next to the message box'], ['elder', 'Thank you dear']],
  [['any', 'Sunday lunch at {place}?'], ['elder', 'Wonderful, I’ll make the pie'], ['other', 'We’ll be there']],
  [['elder', 'Doctor appointment went fine'], ['other', 'So glad to hear that ❤️']],
  [['any', 'Did you get home OK?'], ['elder', 'Yes, all good. Thank you']],
];

const REPLIES_TO_YOU = ['Haha yes', 'On my way!', '👍', 'Sounds good', 'Who else is coming?', 'Love it ❤️', 'Can’t right now, later?', 'Same 😂', 'Wait really?', 'Ok!'];
const DM_LINES = [
  ['Hey, got a sec?', 'Sure, what’s up?', 'Can you call me later?', 'Will do 👍'],
  ['Thanks for today ❤️', 'Anytime!'],
  ['Did you get my email?', 'Just saw it, replying now'],
  ['Are you coming tonight?', 'Yes! 8ish', 'Great'],
];

/** Most people the swarm puts in one circle (the server allows 50, and you may join too). */
export const MAX_PEOPLE = 49;
/** Most circles on one server (the server allows 100, and the HQ circle is one). */
export const MAX_CIRCLES = 99;

const EXTRA = {
  family: () => (Math.random() < 0.7 ? { pool: 'kids', role: 'kid', travel: Math.random() < 0.6 ? 'walk' : 'drive' } : { pool: 'adults', role: 'relative', travel: 'drive' }),
  friends: () => ({ pool: 'adults', role: 'friend', travel: 'drive' }),
  work: () => ({ pool: 'adults', role: 'colleague', travel: 'drive' }),
  party: () => ({ pool: Math.random() < 0.8 ? 'adults' : 'kids', role: 'guest', travel: 'drive' }),
  elders: () => (Math.random() < 0.25 ? { pool: 'elders', role: 'elder', travel: 'drive' } : { pool: 'adults', role: 'relative', travel: 'drive' }),
};

/** Someone new for a circle of this kind, with a name nobody in it has yet. */
export function newPerson(key, takenNames) {
  const { pool, role, travel } = EXTRA[key]();
  const free = FIRST[pool].filter((n) => !takenNames.has(n));
  let name = free.length ? pick(free) : null;
  for (let tries = 0; !name && tries < 50; tries++) {
    const n = `${pick(FIRST[pool])} ${pick(SURNAMES)[0]}.`;
    if (!takenNames.has(n)) name = n;
  }
  name ??= `${pick(FIRST[pool])} ${takenNames.size + 1}`;
  return { name, role, travel };
}

export const SCALES = {
  small: { family: 1, friends: 1, work: 1, party: 1, elders: 1 },
  medium: { family: 3, friends: 2, work: 2, party: 1, elders: 1 },
  large: { family: 8, friends: 5, work: 5, party: 3, elders: 3 },
  xl: { family: 18, friends: 10, work: 10, party: 6, elders: 6 },
};

/**
 * Each scenario: how a circle of that kind is built and behaves.
 * rates are per simulated minute.
 */
export const SCENARIOS = {
  family: {
    label: 'Family with kids',
    threads: FAMILY_THREADS,
    threadEvery: 25, // a new conversation about every 25 min
    reactChance: 0.25,
    dmEvery: 120,
    locateEvery: 90, // a parent Locates someone
    checkinEvery: 240,
    appOpenEvery: [20, 90],
    appOpenFor: [1, 6],
    build() {
      const surname = pick(SURNAMES);
      const kids = 1 + Math.floor(Math.random() * 3);
      const [p1, p2] = uniqueNames(FIRST.adults, 2);
      const people = [
        { name: p1, role: 'parent', travel: 'drive' },
        { name: p2, role: 'parent', travel: 'drive' },
        ...uniqueNames(FIRST.kids, kids).map((name, i) => ({ name, role: 'kid', travel: i === 0 && kids > 1 ? 'drive' : 'walk' })),
      ];
      return {
        circleName: `The ${surname}s`,
        people,
        places: [
          { key: 'home', name: 'Home', km: 0 },
          { key: 'school', name: pick(['Lincoln Elementary', 'Oakwood Middle', 'Westview High']), km: 1.2 },
          { key: 'work1', name: `${p1}’s work`, km: 9 },
          { key: 'work2', name: `${p2}’s work`, km: 6 },
          { key: 'soccer', name: 'Soccer field', km: 2.5 },
          { key: 'store', name: 'Grocery store', km: 1.8 },
        ],
      };
    },
    next(p) {
      if (p.role === 'kid') return pickWeighted({ school: 5, home: 5, soccer: 2, store: 1 });
      return pickWeighted({ [p.index === 0 ? 'work1' : 'work2']: 5, home: 5, school: 2, store: 2, soccer: 1 });
    },
    dwell: [30, 240],
  },
  friends: {
    label: 'Friends',
    threads: FRIENDS_THREADS,
    threadEvery: 12,
    reactChance: 0.35,
    dmEvery: 45,
    locateEvery: 240,
    checkinEvery: 0,
    appOpenEvery: [10, 60],
    appOpenFor: [1, 8],
    build() {
      const n = 6 + Math.floor(Math.random() * 7);
      const people = uniqueNames(FIRST.adults, n).map((name) => ({ name, role: 'friend', travel: 'drive' }));
      return {
        circleName: pick(['Weekend crew', 'College friends', 'Book club', 'Climbing gang', 'Brunch club', 'Neighbors', 'Run club', 'Board game night', 'Soccer moms', 'Trivia team', 'Ski trip', 'Dog park pals']),
        people,
        places: [
          { key: 'cafe', name: pick(['Blue Bottle', 'Corner café', 'Sightglass']), km: 3 },
          { key: 'gym', name: 'Gym', km: 4 },
          { key: 'bar', name: pick(['The Tap Room', 'Rooftop bar', 'Sports bar']), km: 5 },
          { key: 'park', name: 'Dolores Park', km: 6 },
        ],
        homes: true,
      };
    },
    next: () => pickWeighted({ home: 6, work: 4, cafe: 2, gym: 2, bar: 1, park: 1 }),
    dwell: [40, 300],
  },
  work: {
    label: 'Coworkers',
    threads: WORK_THREADS,
    threadEvery: 18,
    reactChance: 0.2,
    dmEvery: 60,
    locateEvery: 0,
    checkinEvery: 0,
    appOpenEvery: [30, 120],
    appOpenFor: [1, 4],
    build() {
      const n = 8 + Math.floor(Math.random() * 13);
      const people = uniqueNames(FIRST.adults, n).map((name) => ({ name, role: 'colleague', travel: 'drive' }));
      return {
        circleName: pick(['Design team', 'Platform eng', 'Sales West', 'Ops on-call', 'Marketing', 'Field techs', 'Support crew', 'Leadership', 'Night shift', 'Warehouse', 'Clinic staff', 'Delivery drivers']),
        people,
        places: [
          { key: 'office', name: 'Office', km: 8 },
          { key: 'lunch', name: pick(['Taqueria', 'Poke place', 'Food trucks']), km: 8.4 },
          { key: 'gym', name: 'Gym', km: 7 },
        ],
        homes: true,
      };
    },
    next: () => pickWeighted({ office: 6, home: 5, lunch: 2, gym: 1 }),
    dwell: [45, 300],
  },
  party: {
    label: 'Party meetup',
    threads: PARTY_THREADS,
    threadEvery: 5,
    reactChance: 0.3,
    dmEvery: 30,
    locateEvery: 60,
    checkinEvery: 0,
    appOpenEvery: [8, 40],
    appOpenFor: [1, 6],
    build() {
      const n = 15 + Math.floor(Math.random() * 21);
      const people = uniqueNames([...FIRST.adults, ...FIRST.kids], n).map((name) => ({ name, role: 'guest', travel: 'drive' }));
      return {
        circleName: pick(['Sam’s 30th 🎉', 'Halloween party 🎃', 'Graduation bash 🎓', 'Housewarming 🏠', 'Game night 🎲', 'Wedding weekend 💍', 'Block party 🎈', 'Super Bowl party 🏈', 'New Year’s Eve 🎆', 'Beach day 🏖️']),
        people,
        places: [
          { key: 'venue', name: 'Party venue', km: 5 },
          { key: 'parking', name: 'Parking lot', km: 5.2 },
        ],
        homes: true,
      };
    },
    // Everyone converges on the venue every 4 simulated hours.
    next(p, simMin) {
      const phase = simMin % 240;
      if (phase < 150) return Math.random() < 0.85 ? 'venue' : 'home';
      return 'home';
    },
    dwell: [20, 90],
  },
  elders: {
    label: 'Extended family',
    threads: ELDER_THREADS,
    threadEvery: 60,
    reactChance: 0.4,
    dmEvery: 180,
    locateEvery: 180,
    checkinEvery: 360,
    appOpenEvery: [60, 240],
    appOpenFor: [1, 4],
    build() {
      const elders = uniqueNames(FIRST.elders, 2).map((name) => ({ name, role: 'elder', travel: 'drive' }));
      const rest = uniqueNames(FIRST.adults, 3 + Math.floor(Math.random() * 4)).map((name) => ({ name, role: 'relative', travel: 'drive' }));
      return {
        circleName: pick(['Family 💛', 'Grandma & the gang', 'Cousins', 'Big family', 'The in-laws', 'Sunday dinner', 'Abuela’s crew', 'Family reunion']),
        people: [...elders, ...rest],
        places: [
          { key: 'grandma', name: 'Grandma’s house', km: 12 },
          { key: 'clinic', name: 'Clinic', km: 13 },
          { key: 'church', name: 'Community center', km: 11 },
        ],
        homes: true,
      };
    },
    next: (p) => (p.role === 'elder' ? pickWeighted({ grandma: 8, clinic: 1, church: 2 }) : pickWeighted({ home: 6, work: 4, grandma: 1 })),
    dwell: [60, 360],
  },
};

function pickWeighted(weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  let r = Math.random() * entries.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of entries) if ((r -= w) <= 0) return k;
  return entries[0][0];
}

export { REPLIES_TO_YOU, DM_LINES, pick };
