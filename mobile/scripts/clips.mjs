// The Elderly Companion app's Urdu clips (assets/clips/clips.json).
//
//   node scripts/clips.mjs placeholders   make a short tone for every missing clip
//   node scripts/clips.mjs check          list what's recorded and what's still a placeholder
//
// Real recordings replace the placeholders: save each as
// assets/clips/ur_<id>[_m|_f].wav (mono; 16–44.1 kHz). A placeholder is any
// file listed in assets/clips/placeholders.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'clips');
const { clips } = JSON.parse(readFileSync(join(dir, 'clips.json'), 'utf8'));
const placeholdersFile = join(dir, 'placeholders.json');
const placeholders = new Set(existsSync(placeholdersFile) ? JSON.parse(readFileSync(placeholdersFile, 'utf8')) : []);

/** Every file the app expects: ur_<id> or ur_<id>_m / _f. */
export const files = () => clips.flatMap((c) => (c.variants.length ? c.variants.map((v) => `ur_${c.id}_${v}`) : [`ur_${c.id}`]));

// Two soft notes per clip, so placeholders can be told apart while testing:
// a family of clips shares the first note, and each clip gets its own second.
const BASE = { callback: 523.25, game: 659.25, sos: 392.0 };
const RATE = 16000;

function tone(first, second) {
  const note = (f, ms) => {
    const n = Math.round((RATE * ms) / 1000);
    return Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / RATE) * Math.min(1, i / 400, (n - i) / 800) * 0.5);
  };
  const gap = new Float32Array(Math.round(RATE * 0.06));
  const samples = [...note(first, 220), ...gap, ...note(second, 320)];
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(s * 32767), i * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const cmd = process.argv[2];
if (cmd === 'placeholders') {
  let made = 0;
  clips.forEach((c, i) => {
    const names = c.variants.length ? c.variants.map((v) => `ur_${c.id}_${v}`) : [`ur_${c.id}`];
    for (const name of names) {
      const path = join(dir, `${name}.wav`);
      if (existsSync(path) && !placeholders.has(name)) continue;
      writeFileSync(path, tone(BASE[c.tone] ?? BASE.callback, 600 + (i % 12) * 45));
      placeholders.add(name);
      made++;
    }
  });
  writeFileSync(placeholdersFile, `${JSON.stringify([...placeholders].sort(), null, 2)}\n`);
  console.log(`${made} placeholder clips written`);
} else if (cmd === 'check') {
  const all = files();
  const missing = all.filter((n) => !existsSync(join(dir, `${n}.wav`)));
  const temp = all.filter((n) => placeholders.has(n) && !missing.includes(n));
  console.log(`${all.length} clips: ${all.length - missing.length - temp.length} recorded, ${temp.length} placeholders, ${missing.length} missing`);
  for (const n of missing) console.log(`  missing: ${n}.wav`);
  if (missing.length) process.exitCode = 1;
} else {
  console.log('Usage: node scripts/clips.mjs placeholders | check');
}
