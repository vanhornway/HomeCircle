// Kinds of circles the swarm builds: who is in them, where they go, and what
// they talk about. Times are in simulated minutes (see --speed). Each circle
// lives in a city (world.mjs): names come from that region and people visit
// the city's landmark as well as their own places.
import { region } from './world.mjs';

const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** n different names: first names from the pool, then "Name K." with a surname initial. */
function uniqueNames(pool, n, surnames = ['A', 'B', 'C', 'D', 'K', 'M', 'R', 'S', 'T']) {
  const a = [...pool].sort(() => Math.random() - 0.5);
  const out = new Set(a.slice(0, n));
  for (let tries = 0; out.size < n && tries < 1000; tries++) out.add(`${pick(pool)} ${pick(surnames)[0]}.`);
  for (let i = out.size; out.size < n; i++) out.add(`${pick(pool)} ${i}`);
  return [...out];
}

// A thread is a list of [who, text]. who: a role ('parent', 'kid', 'elder'…),
// 'any', 'other' (anyone but the person before) or 'starter'. Placeholders:
// {kid} {parent} {any} {place} {landmark} {city} {greet} {emoji}.
const GREETING = [['any', '{greet}'], ['other', '{greet}'], ['other', '{emoji}']];

const FAMILY_THREADS = [
  [['parent', 'Who’s picking up {kid} from {place}? 🚗'], ['other', 'I can, leaving work at 5:15'], ['starter', '👍 thanks!']],
  [['kid', 'can I go to {any}’s after school? 🙏'], ['parent', 'Homework first, then yes'], ['kid', 'ok 🙄'], ['parent', 'Home by 7 please ⏰']],
  [['parent', 'Dinner at 6:30 tonight 🌮🌮'], ['kid', 'YESSS 🙌'], ['other', 'I’ll grab tortillas on the way home']],
  [['kid', 'forgot my lunch 😬'], ['parent', 'I’ll drop it at the front office'], ['kid', 'thank youuu ❤️❤️']],
  [['parent', 'Soccer practice moved to 4pm ⚽'], ['other', 'Got it, I’ll do drop-off'], ['kid', 'can we get boba after? 🧋']],
  [['parent', 'Running 10 minutes late, traffic 😩🚦'], ['other', 'No worries']],
  [['kid', 'what’s the wifi password again 😅'], ['parent', 'It’s on the fridge 😄']],
  [['parent', 'Saturday: picnic at {landmark}? 🧺☀️'], ['kid', 'yes!! 🥳'], ['other', 'I’ll make sandwiches 🥪']],
  [['kid', 'I’m at {place} 📍'], ['parent', '👍 text me when you leave']],
  [['parent', 'Anyone need anything from the store? 🛒'], ['kid', 'cereal pls 🥣'], ['other', 'Milk and eggs 🥚'], ['starter', 'On it ✅']],
  GREETING,
];

const POLITICS_THREADS = [
  [['any', 'Did anyone watch the debate last night? 🗳️📺'], ['other', 'Both of them dodged the housing question 🙄'], ['other', 'I thought the challenger was way more convincing 💪'], ['other', 'Seriously? The incumbent actually had numbers 📊'], ['other', 'Numbers can say anything 😤'], ['other', 'That’s… not how numbers work 😂'], ['starter', 'Ok ok, agree to disagree 🤝']],
  [['any', 'City council approved the new bike lanes 🚲'], ['other', 'Finally! Safer streets 🙌'], ['other', 'They took half the parking on the main street 😤'], ['other', 'Fewer cars is kind of the point'], ['other', 'Tell that to the bakery that’s losing customers 🥖'], ['other', 'Foot traffic usually goes up with bike lanes 📈'], ['other', 'Usually 🙄'], ['starter', 'Let’s see in six months 🤷']],
  [['any', 'The school funding measure is on the ballot again 🏫'], ['other', 'Voting yes, the buildings are falling apart'], ['other', 'Audit the budget first, then ask for more 💸'], ['other', 'Both can be true 🤔'], ['other', 'Every year it’s “for the kids” and nothing changes 😒'], ['other', 'Class sizes did go down last time'], ['other', 'Fair point 👍']],
  [['any', 'Thoughts on ranked-choice voting? 🗳️🔢'], ['other', 'Love it. No more “lesser evil” voting'], ['other', 'Too confusing, people will spoil their ballots 😬'], ['other', 'It worked fine in the last city election'], ['other', 'Results took a week though ⏳'], ['other', 'I’d rather wait and get it right'], ['starter', 'Good debate everyone 😄']],
  [['any', 'Hot take: we need more nuclear power ⚛️'], ['other', 'Agreed, clean and reliable'], ['other', 'And the waste? ☢️'], ['other', 'Storage is solved technically'], ['other', 'Technically ≠ politically 😅'], ['other', 'Solar and batteries are cheaper now ☀️🔋'], ['other', 'Not at night they’re not 🌙'], ['other', 'That’s literally what the batteries are for 🙃']],
  [['any', 'Should AI be regulated like medicine? 🤖💊'], ['other', 'Some of it, yes'], ['other', 'Regulation always lags behind tech'], ['other', 'Doesn’t mean we shouldn’t try'], ['other', 'Over-regulate and innovation moves elsewhere 🌍'], ['other', 'Under-regulate and we find out the hard way 😬']],
  [['any', 'Should the city keep funding downtown if everyone works remote? 🏙️'], ['other', 'Downtown is dead, move on 💀'], ['other', 'Downtown belongs to everyone, worth saving ❤️'], ['other', 'Turn offices into housing 🏠 problem solved'], ['other', 'Easier said than done, the plumbing alone 🔧'], ['other', 'Other cities managed it'], ['other', 'And it cost a fortune 💸']],
  [['any', 'Rent went up 15% again 😡🏠'], ['other', 'Rent control now!'], ['other', 'Rent control means fewer new apartments get built'], ['other', 'So what, we wait 20 years? 😤'], ['other', 'Build more and prices come down 🏗️'], ['other', 'When has that ever happened here 🙄'], ['starter', 'This group chat is better than the news 😂']],
  [['any', 'Reminder: voter registration closes Friday ✅🗳️'], ['other', 'Done!'], ['other', 'Mailed my ballot 📬'], ['other', 'Thanks for the reminder 🙏']],
  [['any', 'Lowering the voting age to 16 — yes or no? 🤔'], ['other', 'Yes, they pay taxes on their jobs'], ['other', 'No way, I wasn’t ready at 16 😂'], ['other', 'Neither were half the adults I know 😅'], ['other', 'Fair 😂'], ['other', 'Some countries already do it and it’s fine']],
];

// Everyday version: politics creeping into a family or friends chat.
const DINNER_POLITICS = [
  [['any', 'Can we please not talk politics at dinner this Sunday 😅🍗'], ['other', 'No promises 😂'], ['other', 'I’m bringing earplugs 🙉'], ['starter', 'I’m serious 😂🙏']],
  [['any', 'Saw the news about the new tax plan? 📰'], ['other', 'Don’t get me started 😤'], ['other', 'Here we go again 🍿'], ['other', '😂😂😂']],
];

const HISTORY_THREADS = [
  [['any', 'Fun fact: Cleopatra lived closer in time to the moon landing than to the building of the Great Pyramid 🤯🏺🚀'], ['other', 'Wait WHAT 😳'], ['other', 'Pyramid ~2560 BC, Cleopatra ~30 BC, moon landing 1969'], ['other', 'Mind blown 🤯🤯']],
  [['any', 'Just finished a book on the Silk Road 🐪📚'], ['other', 'Which one?'], ['starter', '“The Silk Roads” by Peter Frankopan'], ['other', 'Adding it to my list 📖'], ['other', 'Loved that one ❤️']],
  [['any', 'Better general: Hannibal or Scipio? ⚔️'], ['other', 'Hannibal. Crossed the Alps with elephants 🐘🏔️'], ['other', 'Scipio beat him at Zama though 🏆'], ['other', 'Hannibal won Cannae against a bigger army'], ['other', 'Winning the war > winning battles'], ['starter', 'Rematch at dinner 😂']],
  [['any', 'Vikings didn’t actually wear horned helmets 🪖'], ['other', 'No way, really?'], ['other', 'That came from 19th-century opera costumes 🎭'], ['other', 'Ruining my childhood 😭']],
  [['any', 'Oxford University is older than the Aztec Empire 🎓'], ['other', 'How?!'], ['other', 'Teaching at Oxford started around 1096. Tenochtitlan was founded in 1325'], ['other', 'History is wild 🤯']],
  [['any', 'Visited {landmark} today 📸'], ['other', 'Jealous!! 😍'], ['other', 'Did you learn anything about its history?'], ['starter', 'Way more than I expected, I’ll tell you over coffee ☕']],
  [['any', 'The Great Wall isn’t visible from space with the naked eye 👀🌏'], ['other', 'Says who?'], ['other', 'Astronauts, including China’s first, Yang Liwei'], ['other', 'TIL 🤓']],
  [['any', 'Napoleon wasn’t short btw 📏'], ['other', 'Really?'], ['other', 'About 5′7″, average for his time. Cartoons made him tiny 😂'], ['other', 'Propaganda 101 📰']],
  [['any', 'Best ancient wonder? 🏛️'], ['other', 'Lighthouse of Alexandria 🗼'], ['other', 'Hanging Gardens, if they existed 🌿'], ['other', 'Great Pyramid, the only one still standing 🔺'], ['other', 'Can’t argue with that 💯']],
  [['any', 'Gutenberg was printing Bibles by around 1455 📚'], ['other', 'And now we doomscroll 📱😂'], ['other', 'Progress? 🤔']],
];

const FRIENDS_THREADS = [
  [['any', 'Anyone up for {place} tonight? 🍻'], ['other', 'I’m in! 🙋'], ['other', 'Can’t tonight 😩 next time'], ['starter', '7pm?'], ['other', '👍👍']],
  [['any', 'Did you all see the game last night?? ⚽🔥'], ['other', 'That last minute goal 🤯'], ['other', 'I fell asleep at halftime 😴😂']],
  [['any', 'Brunch Sunday? {place}? 🥞'], ['other', 'Yes please 🥞🥓'], ['other', 'Only if it’s after 11 😴']],
  [['any', 'Running late, save me a seat 🏃'], ['other', 'Got you 🫡']],
  [['any', 'Who has my charger 😂🔌'], ['other', 'Not me'], ['other', '…maybe me 😇']],
  [['any', 'Happy birthday {any}!! 🎂🎉'], ['other', 'HBD!! 🥳🥳'], ['other', 'Happy birthday!! 🎈🎁']],
  [['any', 'Meet at {landmark} Saturday? ☀️'], ['other', 'Saturday works'], ['other', 'I’ll drive 🚗'], ['starter', '🙌🙌🙌']],
  [['any', 'Just landed ✈️'], ['other', 'Welcome back! 🤗']],
  GREETING,
];
const WORK_THREADS = [
  [['any', 'Standup in 5 ⏰'], ['other', '👍'], ['other', 'Joining from the car, 2 min late 🚗']],
  [['any', 'Lunch at {place}? 🌯'], ['other', 'Yes, 12:30'], ['other', 'I brought food today 🥗']],
  [['any', 'Is anyone in the office today? 🏢'], ['other', 'Here till 4'], ['other', 'Remote today 🏠']],
  [['any', 'Traffic is terrible, I’ll be late 😩'], ['other', 'Same here 🚦']],
  [['any', 'Cake in the kitchen 🎂'], ['other', 'On my way 🏃'], ['other', 'Save me a piece! 🙏']],
  [['any', 'Can someone review my doc before 3? 📄'], ['other', 'I’ll take a look after lunch 👀']],
  [['any', 'Leaving now, see you tomorrow 👋'], ['other', 'Bye! 😊']],
  GREETING,
];
const PARTY_THREADS = [
  [['any', 'Party starts at 8! Address is in the place pin 🎉📍'], ['other', 'Can’t wait 🥳'], ['other', 'What should I bring?'], ['starter', 'Drinks or snacks! 🍿🥤']],
  [['any', 'Where do I park? 🅿️'], ['other', 'Street parking on the side road'], ['starter', 'Thanks!']],
  [['any', 'Leaving now, ETA 20 min 🚗💨'], ['other', '🙌']],
  [['any', 'Is anyone driving from downtown? Need a ride 🙏'], ['other', 'I can pick you up at 7:30'], ['starter', 'Lifesaver 🙏🙏']],
  [['any', 'Who brought the speaker 🔊'], ['other', 'Me! 🎶'], ['other', 'Play something good 😂']],
  [['any', 'Group photo in 5 minutes on the patio 📸'], ['other', 'Coming 🏃'], ['other', 'Wait for me!! 😭']],
  [['any', 'Thanks for coming everyone ❤️'], ['other', 'Best party of the year 🔥🔥'], ['other', 'Get home safe! 🏠']],
  GREETING,
];
const ELDER_THREADS = [
  [['elder', 'Good morning everyone ☀️'], ['other', 'Morning ❤️'], ['other', 'Good morning! 🌻']],
  [['elder', 'How do I send a picture on here?'], ['other', 'Tap the + next to the message box 😊'], ['elder', 'Thank you dear 🙏']],
  [['any', 'Sunday lunch at {place}? 🍲'], ['elder', 'Wonderful, I’ll make the pie 🥧'], ['other', 'We’ll be there 🙌']],
  [['elder', 'Doctor appointment went fine 👍'], ['other', 'So glad to hear that ❤️❤️']],
  [['any', 'Did you get home OK? 🏠'], ['elder', 'Yes, all good. Thank you']],
  GREETING,
];

export const EMOJI_REPLIES = ['😂😂😂', '🔥🔥', '❤️', '🙌', '👏👏👏', '🎉🥳', '💯', '😅', '🤣', '👀', '🫶', '😍', '🤯', '🙏', '😭😭'];
const REPLIES_TO_YOU = ['Haha yes 😂', 'On my way! 🚗', '👍', 'Sounds good 👌', 'Who else is coming? 👀', 'Love it ❤️', 'Can’t right now, later? 🙏', 'Same 😂', 'Wait really? 😳', 'Ok! ✅'];
const DM_LINES = [
  ['Hey, got a sec? 👋', 'Sure, what’s up?', 'Can you call me later? 📞', 'Will do 👍'],
  ['Thanks for today ❤️', 'Anytime! 🤗'],
  ['Did you get my email? 📧', 'Just saw it, replying now'],
  ['Are you coming tonight? 🎉', 'Yes! 8ish', 'Great 🙌'],
  ['Can you believe what they said in the group? 😤', 'Let it go 😂', 'Never 😤😂'],
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
  politics: () => ({ pool: 'adults', role: 'member', travel: 'drive' }),
  history: () => ({ pool: Math.random() < 0.2 ? 'elders' : 'adults', role: 'member', travel: 'drive' }),
};

/** Someone new for a circle of this kind, with a name nobody in it has yet. */
export function newPerson(key, takenNames, city) {
  const r = region(city);
  const { pool, role, travel } = EXTRA[key]();
  const free = r[pool].filter((n) => !takenNames.has(n));
  let name = free.length ? pick(free) : null;
  for (let tries = 0; !name && tries < 50; tries++) {
    const n = `${pick(r[pool])} ${pick(r.surnames)[0]}.`;
    if (!takenNames.has(n)) name = n;
  }
  name ??= `${pick(r[pool])} ${takenNames.size + 1}`;
  return { name, role, travel };
}

export const SCALES = {
  small: { family: 1, friends: 1, work: 1, party: 1, elders: 1, politics: 1, history: 1 },
  medium: { family: 3, friends: 2, work: 2, party: 1, elders: 1, politics: 1, history: 1 },
  large: { family: 8, friends: 5, work: 4, party: 2, elders: 3, politics: 2, history: 2 },
  xl: { family: 18, friends: 9, work: 8, party: 5, elders: 5, politics: 5, history: 4 },
};

const landmarkPlace = (city) => (city?.landmark ? [{ key: 'landmark', name: city.landmark.name, lat: city.landmark.lat, lng: city.landmark.lng }] : []);
const inCity = (base, city) => (city?.landmark ? `${base} · ${city.name}` : base);

/**
 * Each scenario: how a circle of that kind is built and behaves.
 * rates are per simulated minute. build(city) → { circleName, people, places, homes }.
 */
export const SCENARIOS = {
  family: {
    label: 'Family with kids',
    threads: [...FAMILY_THREADS, ...DINNER_POLITICS.slice(0, 1)],
    threadEvery: 25, // a new conversation about every 25 min
    reactChance: 0.25,
    emojiChance: 0.08,
    dmEvery: 120,
    locateEvery: 90, // a parent Locates someone
    checkinEvery: 240,
    appOpenEvery: [20, 90],
    appOpenFor: [1, 6],
    build(city) {
      const r = region(city);
      const kids = 1 + Math.floor(Math.random() * 3);
      const [p1, p2] = uniqueNames(r.adults, 2, r.surnames);
      const people = [
        { name: p1, role: 'parent', travel: 'drive' },
        { name: p2, role: 'parent', travel: 'drive' },
        ...uniqueNames(r.kids, kids, r.surnames).map((name, i) => ({ name, role: 'kid', travel: i === 0 && kids > 1 ? 'drive' : 'walk' })),
      ];
      return {
        circleName: `${pick(r.surnames)} family ${city?.flag ?? ''}`.trim(),
        people,
        places: [
          { key: 'home', name: 'Home', km: 0 },
          { key: 'school', name: pick(['School', 'Primary school', 'High school']), km: 1.2 },
          { key: 'work1', name: `${p1}’s work`, km: 6 },
          { key: 'work2', name: `${p2}’s work`, km: 4 },
          { key: 'sports', name: pick(['Football pitch', 'Swimming pool', 'Basketball court']), km: 2 },
          { key: 'store', name: pick(['Market', 'Supermarket', 'Corner shop']), km: 1.5 },
          ...landmarkPlace(city),
        ],
      };
    },
    next(p) {
      if (p.role === 'kid') return pickWeighted({ school: 5, home: 5, sports: 2, store: 1, landmark: 0.5 });
      return pickWeighted({ [p.index === 0 ? 'work1' : 'work2']: 5, home: 5, school: 2, store: 2, sports: 1, landmark: 0.5 });
    },
    dwell: [30, 240],
  },
  friends: {
    label: 'Friends',
    threads: [...FRIENDS_THREADS, ...DINNER_POLITICS, HISTORY_THREADS[0], HISTORY_THREADS[3]],
    threadEvery: 12,
    reactChance: 0.35,
    emojiChance: 0.15,
    dmEvery: 45,
    locateEvery: 240,
    checkinEvery: 0,
    appOpenEvery: [10, 60],
    appOpenFor: [1, 8],
    build(city) {
      const n = 6 + Math.floor(Math.random() * 7);
      const people = uniqueNames(region(city).adults, n, region(city).surnames).map((name) => ({ name, role: 'friend', travel: 'drive' }));
      return {
        circleName: inCity(pick(['Weekend crew', 'College friends', 'Book club', 'Climbing gang', 'Brunch club', 'Neighbors', 'Run club', 'Board game night', 'Trivia team', 'Dog park pals']), city),
        people,
        places: [
          { key: 'cafe', name: pick(['Corner café', 'Coffee spot', 'Bakery']), km: 2 },
          { key: 'gym', name: 'Gym', km: 3 },
          { key: 'bar', name: pick(['Rooftop bar', 'Sports bar', 'Night market']), km: 3.5 },
          { key: 'park', name: 'City park', km: 4 },
          ...landmarkPlace(city),
        ],
        homes: true,
      };
    },
    next: () => pickWeighted({ home: 6, work: 4, cafe: 2, gym: 2, bar: 1, park: 1, landmark: 1 }),
    dwell: [40, 300],
  },
  work: {
    label: 'Coworkers',
    threads: [...WORK_THREADS, POLITICS_THREADS[6]],
    threadEvery: 18,
    reactChance: 0.2,
    emojiChance: 0.05,
    dmEvery: 60,
    locateEvery: 0,
    checkinEvery: 0,
    appOpenEvery: [30, 120],
    appOpenFor: [1, 4],
    build(city) {
      const n = 8 + Math.floor(Math.random() * 13);
      const people = uniqueNames(region(city).adults, n, region(city).surnames).map((name) => ({ name, role: 'colleague', travel: 'drive' }));
      return {
        circleName: inCity(pick(['Design team', 'Platform eng', 'Sales team', 'Ops on-call', 'Marketing', 'Field techs', 'Support crew', 'Night shift', 'Clinic staff', 'Delivery drivers']), city),
        people,
        places: [
          { key: 'office', name: 'Office', km: 3 },
          { key: 'lunch', name: pick(['Food trucks', 'Noodle bar', 'Canteen']), km: 3.3 },
          { key: 'gym', name: 'Gym', km: 2.5 },
          ...landmarkPlace(city),
        ],
        homes: true,
      };
    },
    next: () => pickWeighted({ office: 6, home: 5, lunch: 2, gym: 1, landmark: 0.3 }),
    dwell: [45, 300],
  },
  party: {
    label: 'Party meetup',
    threads: PARTY_THREADS,
    threadEvery: 5,
    reactChance: 0.3,
    emojiChance: 0.2,
    dmEvery: 30,
    locateEvery: 60,
    checkinEvery: 0,
    appOpenEvery: [8, 40],
    appOpenFor: [1, 6],
    build(city) {
      const r = region(city);
      const n = 15 + Math.floor(Math.random() * 21);
      const people = uniqueNames([...r.adults, ...r.kids], n, r.surnames).map((name) => ({ name, role: 'guest', travel: 'drive' }));
      return {
        circleName: inCity(pick(['Birthday bash 🎉', 'Halloween party 🎃', 'Graduation 🎓', 'Housewarming 🏠', 'Game night 🎲', 'Wedding weekend 💍', 'Block party 🎈', 'New Year’s Eve 🎆']), city),
        people,
        places: [
          { key: 'venue', name: 'Party venue', km: 3 },
          { key: 'parking', name: 'Parking lot', km: 3.2 },
          ...landmarkPlace(city),
        ],
        homes: true,
      };
    },
    // Everyone converges on the venue every 4 simulated hours.
    next(p, simMin) {
      const phase = simMin % 240;
      if (phase < 150) return Math.random() < 0.85 ? 'venue' : 'home';
      return Math.random() < 0.2 ? 'landmark' : 'home';
    },
    dwell: [20, 90],
  },
  elders: {
    label: 'Extended family',
    threads: [...ELDER_THREADS, ...DINNER_POLITICS, HISTORY_THREADS[8]],
    threadEvery: 60,
    reactChance: 0.4,
    emojiChance: 0.1,
    dmEvery: 180,
    locateEvery: 180,
    checkinEvery: 360,
    appOpenEvery: [60, 240],
    appOpenFor: [1, 4],
    build(city) {
      const r = region(city);
      const elders = uniqueNames(r.elders, 2, r.surnames).map((name) => ({ name, role: 'elder', travel: 'drive' }));
      const rest = uniqueNames(r.adults, 3 + Math.floor(Math.random() * 4), r.surnames).map((name) => ({ name, role: 'relative', travel: 'drive' }));
      return {
        circleName: inCity(pick(['Family 💛', 'Grandparents & co', 'Cousins', 'Big family', 'The in-laws', 'Sunday dinner', 'Family reunion']), city),
        people: [...elders, ...rest],
        places: [
          { key: 'grandma', name: 'Grandparents’ house', km: 5 },
          { key: 'clinic', name: 'Clinic', km: 6 },
          { key: 'church', name: 'Community center', km: 4 },
          ...landmarkPlace(city),
        ],
        homes: true,
      };
    },
    next: (p) => (p.role === 'elder' ? pickWeighted({ grandma: 8, clinic: 1, church: 2, landmark: 0.5 }) : pickWeighted({ home: 6, work: 4, grandma: 1 })),
    dwell: [60, 360],
  },
  politics: {
    label: 'Politics chat (arguing)',
    threads: POLITICS_THREADS,
    threadEvery: 8,
    reactChance: 0.45, // 😤👎😂 everywhere
    emojiChance: 0.25,
    dmEvery: 40,
    locateEvery: 0,
    checkinEvery: 0,
    appOpenEvery: [5, 30], // people keep checking back
    appOpenFor: [2, 10],
    build(city) {
      const n = 8 + Math.floor(Math.random() * 15);
      const people = uniqueNames(region(city).adults, n, region(city).surnames).map((name) => ({ name, role: 'member', travel: 'drive' }));
      return {
        circleName: inCity(pick(['Politics chat 🗳️', 'Town hall talk 🏛️', 'Debate club 🎤', 'Neighborhood politics 🗳️']), city),
        people,
        places: [
          { key: 'cityhall', name: 'City hall', km: 2 },
          { key: 'cafe', name: 'Debate café', km: 2.5 },
          ...landmarkPlace(city),
        ],
        homes: true,
      };
    },
    next: () => pickWeighted({ home: 6, work: 4, cityhall: 1, cafe: 2, landmark: 0.5 }),
    dwell: [40, 300],
  },
  history: {
    label: 'History buffs (conversation)',
    threads: HISTORY_THREADS,
    threadEvery: 20,
    reactChance: 0.35,
    emojiChance: 0.12,
    dmEvery: 90,
    locateEvery: 0,
    checkinEvery: 0,
    appOpenEvery: [20, 90],
    appOpenFor: [1, 6],
    build(city) {
      const r = region(city);
      const n = 6 + Math.floor(Math.random() * 10);
      const people = uniqueNames([...r.adults, ...r.elders], n, r.surnames).map((name) => ({ name, role: 'member', travel: 'drive' }));
      return {
        circleName: inCity(pick(['History buffs 🏛️', 'Ancient history club 📜', 'Museum friends 🖼️', 'Documentary night 🎬']), city),
        people,
        places: [
          { key: 'museum', name: 'City museum', km: 2 },
          { key: 'library', name: 'Library', km: 1.5 },
          ...landmarkPlace(city),
        ],
        homes: true,
      };
    },
    next: () => pickWeighted({ home: 6, work: 3, museum: 1.5, library: 1.5, landmark: 1.5 }),
    dwell: [40, 300],
  },
};

function pickWeighted(weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  let r = Math.random() * entries.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of entries) if ((r -= w) <= 0) return k;
  return entries[0][0];
}

export { REPLIES_TO_YOU, DM_LINES, pick };
