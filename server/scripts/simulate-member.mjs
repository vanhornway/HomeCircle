// Dev helper: join a circle as a fake member that walks around, chats, and
// answers location requests. Useful for demos and for testing the apps.
//
//   node scripts/simulate-member.mjs "<invite link>" "Bob" 40.7128 -74.0060
import { CircleClient } from '../../packages/core/src/index.js';

const [link, name = 'Test Member', lat0 = '40.7128', lng0 = '-74.0060'] = process.argv.slice(2);
if (!link) {
  console.error('usage: node scripts/simulate-member.mjs "<invite link>" [name] [lat] [lng]');
  process.exit(1);
}

const mem = new Map();
const storage = {
  getItem: async (k) => mem.get(k) ?? null,
  setItem: async (k, v) => void mem.set(k, v),
  removeItem: async (k) => void mem.delete(k),
};
const client = new CircleClient({ storage, onError: (e) => console.warn('warn:', e.message) });

let lat = Number(lat0);
let lng = Number(lng0);
const share = (trigger) =>
  client.shareLocation({ lat, lng, accuracy: 15, battery: 0.72, charging: false, trigger }).then(() => console.log(`shared location (${trigger})`));

await client.joinWithInvite(link, { name });
console.log(`joined "${client.circle.name}" as ${name}`);
await client.start();
client.on('locationRequest', ({ from }) => {
  console.log(`location requested by ${client.members.get(from)?.name}`);
  share('requested');
});
client.on('newMessage', (m) => {
  const who = client.members.get(m.from)?.name;
  console.log(`${who}: ${m.body?.text ?? JSON.stringify(m.body)}`);
  if (m.kind === 'chat') setTimeout(() => client.sendChat(`👍 got it, ${who}`), 800);
});
client.on('removed', () => {
  console.log('removed from the circle');
  process.exit(0);
});
await share('update');
await client.sendChat(`Hi! ${name} here 👋`);

setInterval(() => {
  lat += (Math.random() - 0.5) * 0.004;
  lng += (Math.random() - 0.5) * 0.004;
  share('update').catch((e) => console.warn('warn:', e.message));
}, 20000);
