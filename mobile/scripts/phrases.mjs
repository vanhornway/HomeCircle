// The phrase catalog (assets/phrases/phrases.csv): every predefined phrase
// by key, with English and each language's text (male and female forms
// where the grammar needs them). Adding a language is data: its columns in
// the CSV, an entry in LANGUAGES below, and its recordings.
//
//   node scripts/phrases.mjs build          write assets/phrases/phrases.json for the app
//   node scripts/phrases.mjs placeholders   make a short tone for every recording still missing
//   node scripts/phrases.mjs check          list what's recorded, what's a placeholder, what's missing
//
// Each phrase is recorded in parts around its slots ({name}, {game}…), so
// "آپ کا پیغام {name} کو بھیج دیا گیا ہے۔" is two recordings with the
// person's name clip played between them. A recording is
// assets/phrases/<lang>_<key>_<part>[_f].wav, e.g. ur_sent_one_2.wav.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'phrases');

/** Languages the app can speak: a CSV column (plus `<col>_female`), its name and direction. */
const LANGUAGES = { ur: { name: 'اردو', english: 'Urdu', rtl: true } };

/** CSV rows as objects (quoted fields may hold commas). */
function readCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(field), (field = '');
    else if (ch === '\n') row.push(field), rows.push(row), (row = []), (field = '');
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const clipName = (lang, key, part, female) => `${lang}_${key.replace(/[^a-z0-9]+/g, '_')}_${part}${female ? '_f' : ''}`;

/** A phrase's text cut into recorded parts and slots: [{ clip } | { slot }]. */
function parts(lang, key, text, female) {
  const out = [];
  let n = 0;
  for (const piece of text.split(/(\{[a-z]+\})/)) {
    const slot = piece.match(/^\{([a-z]+)\}$/)?.[1];
    if (slot) out.push({ slot });
    else if (piece.trim()) out.push({ clip: clipName(lang, key, ++n, female) });
  }
  return out;
}

function catalog() {
  const rows = readCsv(readFileSync(join(dir, 'phrases.csv'), 'utf8'));
  const phrases = {};
  for (const r of rows) {
    const p = { en: r.en, gender: r.gender_follows || null };
    for (const lang of Object.keys(LANGUAGES)) {
      if (!r[lang]) continue;
      const m = { text: r[lang], parts: parts(lang, r.key, r[lang], false) };
      const f = r[`${lang}_female`] ? { text: r[`${lang}_female`], parts: parts(lang, r.key, r[`${lang}_female`], true) } : null;
      p[lang] = f ? { m, f } : { m };
    }
    phrases[r.key] = p;
  }
  return { languages: LANGUAGES, phrases };
}

/** Every recording the app plays: [{ name, lang, key }]. */
function recordings(cat) {
  const out = [];
  for (const [key, p] of Object.entries(cat.phrases)) {
    for (const lang of Object.keys(cat.languages)) {
      for (const form of Object.values(p[lang] ?? {})) for (const part of form.parts) if (part.clip) out.push({ name: part.clip, lang, key });
    }
  }
  return out;
}

// Placeholders: two soft notes, the first shared by a family of phrases
// (call-back, games, SOS) so they can be told apart while testing.
const BASE = { game: 659.25, sos: 392.0 };
const RATE = 16000;
function tone(first, second) {
  const note = (f, ms) => {
    const n = Math.round((RATE * ms) / 1000);
    return Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / RATE) * Math.min(1, i / 400, (n - i) / 800) * 0.5);
  };
  const samples = [...note(first, 220), ...new Float32Array(Math.round(RATE * 0.06)), ...note(second, 320)];
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

const placeholdersFile = join(dir, 'placeholders.json');
const placeholders = new Set(existsSync(placeholdersFile) ? JSON.parse(readFileSync(placeholdersFile, 'utf8')) : []);
const cmd = process.argv[2];
const cat = catalog();

if (cmd === 'build') {
  writeFileSync(join(dir, 'phrases.json'), `${JSON.stringify(cat, null, 1)}\n`);
  console.log(`${Object.keys(cat.phrases).length} phrases, ${recordings(cat).length} recordings`);
} else if (cmd === 'placeholders') {
  let made = 0;
  recordings(cat).forEach(({ name, key }, i) => {
    const path = join(dir, `${name}.wav`);
    if (existsSync(path) && !placeholders.has(name)) return;
    writeFileSync(path, tone(BASE[key.split('.')[0]] ?? 523.25, 600 + (i % 12) * 45));
    placeholders.add(name);
    made++;
  });
  writeFileSync(placeholdersFile, `${JSON.stringify([...placeholders].sort(), null, 2)}\n`);
  console.log(`${made} placeholder recordings written`);
} else if (cmd === 'check') {
  const all = recordings(cat).map((r) => r.name);
  const missing = all.filter((n) => !existsSync(join(dir, `${n}.wav`)));
  const temp = all.filter((n) => placeholders.has(n) && !missing.includes(n));
  console.log(`${all.length} recordings: ${all.length - missing.length - temp.length} recorded, ${temp.length} placeholders, ${missing.length} missing`);
  for (const n of missing) console.log(`  missing: ${n}.wav`);
  if (missing.length) process.exitCode = 1;
} else {
  console.log('Usage: node scripts/phrases.mjs build | placeholders | check');
}
