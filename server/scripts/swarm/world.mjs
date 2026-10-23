// Where the simulated circles live: cities on every inhabited continent, each
// with a well-known landmark (approximate coordinates) that people visit, so
// arrivals and departures happen at real places on the map. Names come from
// the region, and people greet each other in local languages, which also
// exercises non-Latin and right-to-left text end to end.

const pick = (a) => a[Math.floor(Math.random() * a.length)];

export const REGIONS = {
  northAmerica: {
    adults: ['Elena', 'Marco', 'Daniel', 'Hannah', 'Grace', 'Ben', 'Chloe', 'Sam', 'Diego', 'Tom', 'Jasmine', 'Tyler'],
    kids: ['Maya', 'Noah', 'Zoe', 'Eli', 'Ava', 'Kai', 'Lila', 'Max', 'Ruby', 'Theo'],
    elders: ['Grandma Rose', 'Grandpa Joe', 'Aunt Carol', 'Uncle Ted'],
    surnames: ['Johnson', 'Parker', 'Garcia', 'Nguyen', 'Brooks', 'Rivera', 'Lee', 'Walker'],
    greetings: ['Morning all ☀️', 'Hey hey 👋', 'What’s up everyone 😎'],
  },
  latam: {
    adults: ['Valentina', 'Mateo', 'Camila', 'Santiago', 'Lucía', 'Diego', 'Isabella', 'Joaquín', 'Gabriela', 'Thiago'],
    kids: ['Sofía', 'Benjamín', 'Martina', 'Emiliano', 'Renata', 'Bruno'],
    elders: ['Abuela Inés', 'Abuelo Rafa', 'Vovó Lúcia', 'Vovô Zé'],
    surnames: ['Silva', 'González', 'Rodríguez', 'Pereira', 'Hernández', 'López', 'Santos', 'Fernández'],
    greetings: ['¡Hola a todos! 👋', 'Bom dia! ☀️', '¿Qué tal? 😄', 'Buenas noches 🌙'],
  },
  europe: {
    adults: ['Sophie', 'Lukas', 'Elena', 'Mateo', 'Ingrid', 'Pierre', 'Anna', 'Giulia', 'Oliver', 'Mia'],
    kids: ['Leon', 'Emma', 'Noah', 'Lina', 'Hugo', 'Clara'],
    elders: ['Oma Greta', 'Nonna Rosa', 'Mamie Jeanne', 'Grandad Bill'],
    surnames: ['Müller', 'Rossi', 'Dubois', 'Smith', 'García', 'Novak', 'Jensen', 'Kowalski'],
    greetings: ['Bonjour ! 🥐', 'Guten Morgen ☕', 'Ciao a tutti! 👋', 'Cheers all 🍻'],
  },
  africa: {
    adults: ['Amara', 'Kwame', 'Chidi', 'Zanele', 'Tunde', 'Wanjiru', 'Kofi', 'Ngozi', 'Thabo', 'Fatou'],
    kids: ['Ade', 'Nia', 'Tendai', 'Ayo', 'Zuri', 'Kito'],
    elders: ['Mama Grace', 'Baba Oluwa', 'Gogo Thandi', 'Nana Akosua'],
    surnames: ['Okafor', 'Mensah', 'Adeyemi', 'Kamau', 'Ndlovu', 'Diallo', 'Osei', 'Mwangi'],
    greetings: ['Jambo! 👋', 'Sannu! 😄', 'Sawubona 🙌', 'Ẹ káàárọ̀ ☀️'],
  },
  middleEast: {
    adults: ['Layla', 'Omar', 'Yasmin', 'Karim', 'Noor', 'Tariq', 'Mariam', 'Ali', 'Zeynep', 'Emre'],
    kids: ['Adam', 'Lina', 'Yusuf', 'Sara', 'Ayaz', 'Rania'],
    elders: ['Teta Salma', 'Jiddo Fadi', 'Babaanne Ayşe', 'Dede Mehmet'],
    surnames: ['Haddad', 'Mansour', 'Khalil', 'Nasser', 'Yılmaz', 'Demir', 'Aziz', 'Saleh'],
    greetings: ['مرحبا 👋', 'صباح الخير 🌞', 'Günaydın ☀️', 'Merhaba 😊'],
  },
  southAsia: {
    adults: ['Priya', 'Arjun', 'Ananya', 'Rohan', 'Kavya', 'Vikram', 'Isha', 'Sameer', 'Neha', 'Farhan'],
    kids: ['Aarav', 'Diya', 'Vihaan', 'Saanvi', 'Kabir', 'Myra'],
    elders: ['Dadi Kamla', 'Nana Suresh', 'Ammi Rukhsana', 'Thatha Raman'],
    surnames: ['Sharma', 'Patel', 'Iyer', 'Khan', 'Reddy', 'Gupta', 'Das', 'Mehta'],
    greetings: ['नमस्ते 🙏', 'Kaise ho sab? 😊', 'Assalamu alaikum 👋', 'வணக்கம் 🙏'],
  },
  eastAsia: {
    adults: ['Haruto', 'Yui', 'Sora', 'Mei', 'Jun', 'Hana', 'Min-jun', 'Seo-yeon', 'Wei', 'Lin', 'Kenji', 'Aiko'],
    kids: ['Riku', 'Yuna', 'Hina', 'Ren', 'Ji-ho', 'Xiao', 'Mio', 'Kaito'],
    elders: ['Obaachan Fumiko', 'Halmeoni Sun', 'Nainai Hua', 'Ojiichan Hiro'],
    surnames: ['Tanaka', 'Sato', 'Kim', 'Park', 'Wang', 'Chen', 'Suzuki', 'Lee'],
    greetings: ['おはよう！☀️', '안녕하세요 👋', '早上好 🌅', 'こんばんは 🌙'],
  },
  oceania: {
    adults: ['Jack', 'Olivia', 'Tama', 'Aroha', 'Liam', 'Charlotte', 'Mia', 'Ethan'],
    kids: ['Isla', 'Oscar', 'Ruby', 'Nikau', 'Harper', 'Archie'],
    elders: ['Nan Margaret', 'Pop Kevin', 'Kuia Mere', 'Koro Hemi'],
    surnames: ['Smith', 'Williams', 'Ngata', 'Wilson', 'Taylor', 'Walker', 'Parata', 'Brown'],
    greetings: ['G’day! 🦘', 'Kia ora 👋', 'Morning legends ☀️'],
  },
};

// City centre, a landmark people visit (approximate coordinates), region, flag.
export const CITIES = [
  { name: 'New York', flag: '🇺🇸', region: 'northAmerica', lat: 40.7128, lng: -74.006, landmark: { name: 'Central Park', lat: 40.7829, lng: -73.9654 } },
  { name: 'Los Angeles', flag: '🇺🇸', region: 'northAmerica', lat: 34.0522, lng: -118.2437, landmark: { name: 'Griffith Observatory', lat: 34.1184, lng: -118.3004 } },
  { name: 'Toronto', flag: '🇨🇦', region: 'northAmerica', lat: 43.6532, lng: -79.3832, landmark: { name: 'High Park', lat: 43.6465, lng: -79.4637 } },
  { name: 'Mexico City', flag: '🇲🇽', region: 'latam', lat: 19.4326, lng: -99.1332, landmark: { name: 'Bosque de Chapultepec', lat: 19.4204, lng: -99.1819 } },
  { name: 'São Paulo', flag: '🇧🇷', region: 'latam', lat: -23.5505, lng: -46.6333, landmark: { name: 'Parque Ibirapuera', lat: -23.5874, lng: -46.6576 } },
  { name: 'Buenos Aires', flag: '🇦🇷', region: 'latam', lat: -34.6037, lng: -58.3816, landmark: { name: 'Plaza de Mayo', lat: -34.6083, lng: -58.3712 } },
  { name: 'London', flag: '🇬🇧', region: 'europe', lat: 51.5074, lng: -0.1278, landmark: { name: 'Borough Market', lat: 51.5055, lng: -0.091 } },
  { name: 'Paris', flag: '🇫🇷', region: 'europe', lat: 48.8566, lng: 2.3522, landmark: { name: 'Jardin du Luxembourg', lat: 48.8462, lng: 2.3372 } },
  { name: 'Berlin', flag: '🇩🇪', region: 'europe', lat: 52.52, lng: 13.405, landmark: { name: 'Tiergarten', lat: 52.5145, lng: 13.3501 } },
  { name: 'Rome', flag: '🇮🇹', region: 'europe', lat: 41.9028, lng: 12.4964, landmark: { name: 'Colosseum', lat: 41.8902, lng: 12.4922 } },
  { name: 'Lagos', flag: '🇳🇬', region: 'africa', lat: 6.455, lng: 3.3941, landmark: { name: 'Tafawa Balewa Square', lat: 6.4473, lng: 3.402 } },
  { name: 'Nairobi', flag: '🇰🇪', region: 'africa', lat: -1.2864, lng: 36.8172, landmark: { name: 'Uhuru Park', lat: -1.289, lng: 36.815 } },
  { name: 'Cape Town', flag: '🇿🇦', region: 'africa', lat: -33.9249, lng: 18.4241, landmark: { name: 'V&A Waterfront', lat: -33.9036, lng: 18.4207 } },
  { name: 'Cairo', flag: '🇪🇬', region: 'middleEast', lat: 30.0444, lng: 31.2357, landmark: { name: 'Khan el-Khalili', lat: 30.0477, lng: 31.2623 } },
  { name: 'Istanbul', flag: '🇹🇷', region: 'middleEast', lat: 41.0082, lng: 28.9784, landmark: { name: 'Galata Tower', lat: 41.0256, lng: 28.9741 } },
  { name: 'Dubai', flag: '🇦🇪', region: 'middleEast', lat: 25.2048, lng: 55.2708, landmark: { name: 'Burj Khalifa', lat: 25.1972, lng: 55.2744 } },
  { name: 'Mumbai', flag: '🇮🇳', region: 'southAsia', lat: 18.98, lng: 72.83, landmark: { name: 'Marine Drive', lat: 18.944, lng: 72.8236 } },
  { name: 'Tokyo', flag: '🇯🇵', region: 'eastAsia', lat: 35.6812, lng: 139.7671, landmark: { name: 'Shibuya Crossing', lat: 35.6595, lng: 139.7005 } },
  { name: 'Seoul', flag: '🇰🇷', region: 'eastAsia', lat: 37.5665, lng: 126.978, landmark: { name: 'Gyeongbokgung Palace', lat: 37.5796, lng: 126.977 } },
  { name: 'Sydney', flag: '🇦🇺', region: 'oceania', lat: -33.8688, lng: 151.2093, landmark: { name: 'Bondi Beach', lat: -33.8915, lng: 151.2767 } },
  { name: 'Auckland', flag: '🇳🇿', region: 'oceania', lat: -36.8485, lng: 174.7633, landmark: { name: 'Auckland Domain', lat: -36.8606, lng: 174.7766 } },
];

let nextCity = Math.floor(Math.random() * CITIES.length);
/** Cities in turn, so a handful of circles already spans several continents. */
export function pickCity() {
  // Step through the list with a stride that visits every city before repeating.
  nextCity = (nextCity + 8) % CITIES.length;
  return CITIES[nextCity];
}

/** A "city" for --near: your own coordinates, with no landmark. */
export function customCity(lat, lng) {
  return { name: 'your area', flag: '📍', region: 'northAmerica', lat, lng, landmark: null };
}

export const region = (city) => REGIONS[city?.region] || REGIONS.northAmerica;
export const greeting = (city) => pick(region(city).greetings);
