// What the family's helper already knows when a visitor arrives: recipes,
// notes of every kind, shopping lists with prices, and long-term reminders.
// All made up. Dates are worked out from the day a copy is built.

const DAY = 86_400_000;
export const isoAhead = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

const recipe = (title, by, serves, time, ingredients, steps, tip = '') => ({
  type: 'recipe',
  title,
  body: [by ? `${by}’s recipe.` : '', '## Ingredients', ...ingredients.map((i) => `- ${i}`), '## Steps', ...steps.map((s, i) => `${i + 1}. ${s}`), tip ? `\n${tip}` : ''].filter(Boolean).join('\n'),
  people: by ? [by] : [],
  tags: ['recipe', 'dinner', 'food'],
  data: { serves, time },
});

export const RECIPES = [
  recipe('Chicken biryani', 'Nani', '8', '2 hours',
    ['4 cups basmati rice', '3 lb chicken, bone in', '4 onions, sliced', '1 cup yogurt', '2 tomatoes', '2 tbsp ginger garlic paste', '1 tbsp garam masala', 'A pinch of saffron in warm milk', 'Mint and coriander, a handful each'],
    ['Soak the rice for 30 minutes.', 'Fry the onions until deep brown. Keep half for the top.', 'Cook the chicken with the yogurt, tomatoes, ginger garlic and spices until the oil rises.', 'Boil the rice with whole spices until it is three quarters done.', 'Layer rice over chicken with mint, coriander, fried onions and saffron milk.', 'Seal the pot and cook on the lowest heat for 25 minutes.'],
    'Nani says never stir it. Serve from the side of the pot.'),
  recipe('Dal tadka', 'Dada', '6', '45 minutes',
    ['1 cup toor dal', '1 tsp turmeric', '2 tomatoes, chopped', '2 tbsp ghee', '1 tsp cumin seeds', '4 cloves garlic, sliced', '2 dried red chilies'],
    ['Pressure cook the dal with turmeric and salt until soft.', 'Add the tomatoes and simmer for 10 minutes.', 'Heat the ghee, then add cumin, garlic and chilies until golden.', 'Pour it over the dal and cover for one minute.']),
  recipe('Weeknight chicken karahi', 'Maya', '4', '35 minutes',
    ['2 lb chicken, cut small', '4 tomatoes, halved', '2 tbsp ginger, cut thin', '3 green chilies', '1 tsp crushed black pepper', '1/4 cup oil', 'Coriander to finish'],
    ['Brown the chicken in the oil on high heat.', 'Add the tomatoes, skin side up, and cover for 10 minutes.', 'Pull off the skins and mash the tomatoes in.', 'Cook on high until the oil separates, then add ginger, chilies and pepper.']),
  recipe('Kheer', 'Nani', '10', '1 hour',
    ['1/2 gallon whole milk', '1/2 cup basmati rice, soaked', '3/4 cup sugar', '6 green cardamom pods', 'Almonds and pistachios, sliced'],
    ['Bring the milk to a boil with the cardamom.', 'Add the rice and simmer, stirring often, for 40 minutes.', 'Stir in the sugar and cook 10 minutes more.', 'Chill, and top with the nuts.']),
  recipe('Aloo paratha', 'Aunt Sana', '6', '40 minutes',
    ['3 cups atta', '4 potatoes, boiled', '1 tsp chili flakes', '1 tsp ajwain', 'Coriander, chopped', 'Ghee for the pan'],
    ['Make a soft dough with the atta and water. Rest it 15 minutes.', 'Mash the potatoes with the spices and coriander.', 'Fill a ball of dough, seal it and roll it out gently.', 'Cook on a hot pan with ghee until golden on both sides.']),
  recipe('Chana masala', 'Aunt Sana', '6', '40 minutes',
    ['2 cans chickpeas', '2 onions', '3 tomatoes', '1 tbsp ginger garlic paste', '1 tbsp chana masala spice', '1 tsp amchur'],
    ['Cook the onions until brown.', 'Add ginger garlic, spices and tomatoes, and cook down.', 'Add the chickpeas and a cup of water. Simmer for 20 minutes.', 'Finish with the amchur.']),
  recipe('Lina’s banana bread', 'Aunt Lina', '8', '1 hour 10 minutes',
    ['3 very ripe bananas', '1/3 cup melted butter', '3/4 cup sugar', '1 egg', '1 tsp baking soda', '1 1/2 cups flour', 'A handful of walnuts'],
    ['Heat the oven to 350°F.', 'Mash the bananas and stir in the butter.', 'Add sugar, egg and baking soda, then the flour and walnuts.', 'Bake in a loaf pan for 55 minutes.']),
  recipe('Marco’s Sunday lasagna', 'Uncle Marco', '10', '2 hours 30 minutes',
    ['1 lb lasagna sheets', '2 lb beef ragù', '2 lb ricotta', '1 lb mozzarella', '1 cup parmesan', '1 egg', 'Basil'],
    ['Mix the ricotta, egg and half the parmesan.', 'Layer ragù, sheets, ricotta and mozzarella, four times over.', 'Top with the last of the cheese.', 'Bake at 375°F for 50 minutes, covered for the first 30. Rest it for 20.']),
  recipe('Masala chai', 'Omar', '4', '15 minutes',
    ['3 cups water', '1 cup whole milk', '3 tsp loose black tea', '4 cardamom pods, crushed', '1 inch ginger, grated', '1 cinnamon stick', 'Sugar to taste'],
    ['Boil the water with the spices for 5 minutes.', 'Add the tea and simmer for 2 minutes.', 'Add the milk and bring it up to a boil twice.', 'Strain and sweeten.']),
  recipe('Hana’s shakshuka', 'Hana', '3', '25 minutes',
    ['1 onion', '1 red pepper', '2 cloves garlic', '1 can crushed tomatoes', '1 tsp cumin', '1 tsp paprika', '6 eggs', 'Feta and parsley'],
    ['Soften the onion and pepper in olive oil.', 'Add garlic, spices and tomatoes. Simmer for 10 minutes.', 'Crack in the eggs, cover, and cook until the whites set.', 'Top with feta and parsley.']),
];

const note = (type, title, body, tags, extra = {}) => ({ type, title, body, tags, ...extra });

export const notes = () => [
  note('schedule', 'Leo’s soccer practice', 'Leo has soccer practice Tuesdays and Thursdays at 5 pm at Mission Fields, with Coach Dana.', ['soccer', 'practice', 'sports', 'kids'], { people: ['Leo'] }),
  note('schedule', 'Priya’s piano lesson', 'Priya has piano on Wednesdays at 4 pm with Ms. Okafor.', ['piano', 'lesson', 'music'], { people: ['Priya'] }),
  note('schedule', 'Sunday dinner at Nani’s', 'The whole family has dinner at Nani’s every Sunday at 6:30 pm. Whoever comes brings dessert.', ['dinner', 'family', 'sunday'], { people: ['Nani'] }),
  note('event', 'Zara’s dentist', 'Zara sees Dr. Patel at 3:30 pm. Maya drives.', ['dentist', 'teeth', 'appointment', 'health'], { start: isoAhead(9), people: ['Zara', 'Maya'] }),
  note('event', 'Nani’s heart check-up', 'Nani’s follow-up at Creekside Clinic at 10:15 am. Nana drives. Bring her medicine list.', ['doctor', 'appointment', 'health', 'clinic'], { start: isoAhead(2), people: ['Nani', 'Nana'] }),
  note('event', 'Sofia’s graduation', 'Sofia graduates at the Alder Creek High stadium at 6 pm. Arrive an hour early for seats.', ['graduation', 'school', 'celebration'], { start: isoAhead(120), people: ['Sofia'] }),
  note('decision', 'Thanksgiving at Lina’s', 'Thanksgiving is at Lina & Marco’s this year. Maya brings biryani and Nani makes kheer.', ['thanksgiving', 'holiday', 'dinner']),
  note('decision', 'Spring break in Tahoe', 'We decided on Tahoe for spring break: three nights in one big cabin for everyone.', ['spring break', 'vacation', 'travel', 'tahoe']),
  note('fact', 'Recycling day', 'Trash and recycling go out Tuesday night at Maya and Omar’s, and Monday night at Nani’s.', ['trash', 'recycling', 'chores', 'house']),
  note('fact', 'Noor’s school pickup', 'Only Maya, Omar, Sana and Lina are on Noor’s pickup list at Maple Grove.', ['school', 'pickup', 'kids'], { people: ['Noor'] }),
  note('contact', 'Dr. Patel', 'The family dentist.', ['dentist', 'teeth', 'doctor'], { data: { role: 'dentist', phone: '510-555-0142', hours: 'Mon–Fri 8–5', address: 'Alder Creek Dental, Alder Creek' }, people: ['Zara', 'Leo'] }),
  note('contact', 'Dr. Lee', 'Nani’s cardiologist at Creekside Clinic.', ['doctor', 'heart', 'clinic'], { data: { role: 'cardiologist', phone: '510-555-0117', hours: 'Mon–Thu 9–4' }, people: ['Nani'] }),
  note('contact', 'Coach Dana', 'Leo’s soccer coach.', ['soccer', 'coach'], { data: { role: 'soccer coach', phone: '510-555-0165' }, people: ['Leo'] }),
  note('contact', 'Reliable Rooter', 'The plumber who fixed Nani’s kitchen sink. Ask for Hector.', ['plumber', 'house', 'repair'], { data: { role: 'plumber', phone: '510-555-0188' } }),
  note('contact', 'Ms. Okafor', 'Priya’s piano teacher.', ['piano', 'teacher'], { data: { role: 'piano teacher', email: 'piano.okafor@example.com' }, people: ['Priya'] }),
  note('health', 'Leo’s peanut allergy', 'Leo is allergic to peanuts. His EpiPen is in the blue bag, and the school nurse has a second one.', ['allergy', 'peanut', 'food'], { data: { kind: 'allergy' }, people: ['Leo'] }),
  note('health', 'Nani’s blood pressure medicine', 'Nani takes one tablet of lisinopril every morning with breakfast.', ['medicine', 'blood pressure', 'nani'], { data: { kind: 'medicine', dose: '10 mg', schedule: 'Every morning', refillBy: isoAhead(21) }, people: ['Nani'] }),
  note('health', 'Family flu shots', 'Everyone had flu shots at Creekside Clinic this fall.', ['vaccine', 'flu', 'health'], { data: { kind: 'vaccine', refillBy: isoAhead(330) } }),
  note('document', 'Maya’s passport', 'In the fireproof box in the hall closet.', ['passport', 'travel', 'document'], { data: { kind: 'passport', owner: 'Maya', expires: isoAhead(420), number_last4: '4821', where: 'Hall closet box' }, people: ['Maya'] }),
  note('document', 'Honda registration', 'Registration for the family Honda, in the glove box.', ['car', 'registration', 'dmv'], { data: { kind: 'registration', owner: 'Omar', expires: isoAhead(140), number_last4: '7D2K', where: 'Glove box' }, people: ['Omar'] }),
  note('document', 'Fridge warranty', 'Five-year warranty on Nani’s new fridge, kept in the kitchen drawer.', ['warranty', 'fridge', 'appliance'], { data: { kind: 'warranty', expires: isoAhead(900), where: 'Kitchen drawer' } }),
  note('document', 'Costco membership', 'Maya’s Costco card, with Omar and Lina on it too.', ['costco', 'membership'], { data: { kind: 'membership', owner: 'Maya', expires: isoAhead(200), number_last4: '0093' } }),
  note('trip', 'Tahoe cabin', 'Spring break in Tahoe with the whole family.\n\nCabin check-in is at 4 pm. Bring sleds and the big pot.', ['tahoe', 'cabin', 'spring break'], {
    start: isoAhead(135),
    end: isoAhead(138),
    people: ['Maya', 'Omar', 'Sana', 'Lina'],
    data: { legs: [{ kind: 'hotel', from: 'Tahoe cabin', to: '', at: `${isoAhead(135)} 16:00`, arrives: `${isoAhead(138)} 10:00`, confirmation: 'TCB-4417' }] },
  }),
  note('howto', 'Reset the wifi at Nani’s', 'Unplug the white box behind the TV. Count to 30. Plug it back in. Wait for the green light, about two minutes.', ['wifi', 'router', 'internet', 'nani']),
  note('howto', 'Furnace filter', 'The furnace at Home takes a 20x25x1 filter. They are on the garage shelf.', ['furnace', 'filter', 'house'], { data: { every: '3 months' } }),
];

// Each list: what's usually bought, with its usual price and how often it's
// bought (of the last 6 shops), and what's on the list today.
export const LISTS = [
  {
    name: 'Costco',
    usual: [
      ['Whole milk', 7.49, 6], ['Eggs', 8.99, 6], ['Bananas', 1.99, 6], ['Coffee', 18.99, 4], ['Paper towels', 22.99, 3], ['Rotisserie chicken', 4.99, 5],
      ['Greek yogurt', 7.29, 4], ['Sparkling water', 15.99, 3], ['Blueberries', 8.49, 4], ['Basmati rice', 29.99, 2], ['Olive oil', 21.99, 2], ['Dishwasher pods', 19.99, 2],
    ],
    today: ['Whole milk', 'Eggs', 'Bananas', 'Rotisserie chicken', 'Blueberries', 'Birthday candles'],
  },
  {
    name: 'Spice Bazaar',
    usual: [
      ['Basmati rice', 24.99, 3], ['Atta', 16.99, 4], ['Paneer', 7.99, 5], ['Coriander', 0.99, 6], ['Green chilies', 1.49, 5], ['Ghee', 13.99, 2],
      ['Toor dal', 6.49, 4], ['Chai masala', 5.99, 2], ['Mangoes', 22.99, 2], ['Rusk', 3.99, 3],
    ],
    today: ['Paneer', 'Coriander', 'Green chilies', 'Rusk'],
  },
  {
    name: 'Fresh Valley Market',
    usual: [
      ['Sourdough bread', 6.49, 5], ['Avocados', 2.29, 5], ['Strawberries', 4.99, 4], ['Baby spinach', 3.99, 4], ['Orange juice', 5.49, 3], ['Tomatoes', 2.99, 6],
      ['Lemons', 0.79, 3], ['Chicken thighs', 9.49, 3], ['Hot chips', 4.29, 4],
    ],
    today: ['Sourdough bread', 'Tomatoes', 'Hot chips'],
  },
];

export const reminders = () => [
  { title: 'Honda registration', due: isoAhead(140), repeat: 'yearly', note: 'Online at the DMV, or at the office on Mowry.' },
  { title: 'Zara’s driving test', due: isoAhead(30), repeat: 'none', note: 'Bring her permit and proof of insurance.' },
  { title: 'Summer camp sign-up', due: isoAhead(95), repeat: 'yearly', note: 'Spots fill in the first week.' },
  { title: 'Furnace filter', due: isoAhead(45), repeat: 'months', months: 3, note: 'Filters are on the garage shelf.' },
  { title: 'Renew Costco membership', due: isoAhead(190), repeat: 'yearly', note: 'Check the card’s back for the date.' },
  { title: 'Nani’s eye exam', due: isoAhead(60), repeat: 'yearly', note: 'Nana drives.' },
];
