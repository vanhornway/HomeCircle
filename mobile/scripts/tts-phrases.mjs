// Records the phrase catalog with Gemini's text-to-speech: every
// recording assets/phrases/phrases.json lists, in one voice, ready to play.
//
//   node scripts/tts-phrases.mjs              record what's new: placeholders, missing, or changed in phrases.csv
//   node scripts/tts-phrases.mjs --all        record everything again (after changing the voice or speed)
//   node scripts/tts-phrases.mjs --wait       record what's new, waiting out the free tier's daily limit until done
//   node scripts/tts-phrases.mjs samples DIR  a few whole phrases in each voice, to choose one by ear
//   node scripts/tts-phrases.mjs joined DIR   phrases put together from their recordings, a stand-in name in each slot
//
// Needs GEMINI_API_KEY (from aistudio.google.com/apikey) in the environment;
// the key is never written anywhere. Only the catalog's own phrases are
// sent, with a made-up stand-in name in each slot. TTS_VOICE, TTS_MODEL and
// TTS_STYLE change the voice, model and delivery.
//
// A phrase is spoken whole, with a long pause either side of each slot, then
// cut at those pauses: so "آپ کا پیغام" (which a name follows) ends the way it
// does mid-sentence and joins naturally onto the name. Each phrase is brought
// to -16 LUFS (one gain for all its parts, so they match when joined), its
// parts trimmed to 80 ms of silence either end, and written as 16-bit mono WAV.
// tts.json remembers what each recording says, so a changed phrase is redone.
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const dir = join(scripts, '..', 'assets', 'phrases');

const MODEL = process.env.TTS_MODEL || 'gemini-3.8-flash-tts';
const VOICES = { ur: process.env.TTS_VOICE || 'Sulafat' };
const STYLES = {
  ur: process.env.TTS_STYLE || 'Urdu with a Pakistani accent, calm and warm, a little slower than normal, as if speaking to an elderly grandparent',
};
const RATE = 16000;
const TARGET_LUFS = -16;
const PEAK = 10 ** (-1 / 20); // -1 dBFS
const PAD = 0.08; // seconds of silence kept at each end
/** Said either side of a slot, so the phrase can be cut there. */
const GAP = ' <long pause> ';

/** Stand-ins spoken in the slots while recording; cut away afterwards. */
const STAND_IN = {
  m: { name: 'علی', names: 'علی', a: 'علی', b: 'احمد', game: 'شطرنج' },
  f: { name: 'سارہ', names: 'سارہ', a: 'سارہ', b: 'عائشہ', game: 'شطرنج' },
};

/** The phrase's text as pieces: [{ clip, text } | { slot }]. */
function pieces(form) {
  const texts = form.text.split(/\{[a-z]+\}/).filter((t) => t.trim());
  let i = 0;
  return form.parts.map((p) => (p.clip ? { clip: p.clip, text: texts[i++].trim() } : p));
}

async function synthesize(lang, text, voice = VOICES[lang]) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('Set GEMINI_API_KEY first.');
    process.exit(1);
  }
  let res;
  for (let attempt = 1; ;) {
    res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        input: [
          {
            type: 'user_input',
            content: [
              {
                type: 'text',
                text,
                annotations: [{ type: 'speech_metadata', style: STYLES[lang] }],
              },
            ],
          },
        ],
        response_format: { type: 'audio', mime_type: 'audio/wav' },
        generation_config: { speech_config: [{ voice }] },
      }),
    }).catch((e) => e);
    if (res instanceof Error) {
      // A dropped connection (often after the Mac wakes): try again shortly.
      if (attempt === 10) throw res;
      console.log(`  ${res.cause?.code ?? res.message}, trying again in 30 s`);
      await new Promise((r) => setTimeout(r, 30_000));
      attempt++;
      continue;
    }
    if (res.status !== 429 || attempt === 10) break;
    // The free tier allows a few requests a minute (wait as long as it asks)
    // and a few a day (stop, keeping what's recorded so far, or with --wait
    // come back when it resets).
    const reply = await res.text();
    const [, h = 0, m = 0, sec = 30] = reply.match(/retry in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/) ?? [];
    const wait = Number(h) * 3600 + Number(m) * 60 + Number(sec);
    if (/per day/.test(reply)) {
      if (!WAIT) throw new Error(`Gemini's daily limit: ${JSON.parse(reply).error?.message ?? reply}`);
      const until = Date.now() + (wait + 60) * 1000;
      console.log(`  daily limit: waiting until ${new Date(until).toLocaleString()}`);
      // By the clock, a minute at a time: timers stand still while the Mac sleeps.
      while (Date.now() < until) await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }
    console.log(`  waiting ${Math.ceil(wait)} s for the rate limit`);
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
    attempt++;
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const reply = await res.json();
  const audio = reply.steps
    ?.filter((st) => st.type === 'model_output')
    .flatMap((st) => st.content ?? [])
    .filter((c) => c.type === 'audio')
    .at(-1);
  if (!audio) throw new Error(`no audio in the reply: ${JSON.stringify(reply).slice(0, 300)}`);
  return readWav(Buffer.from(audio.data, 'base64'));
}

function readWav(buf) {
  let at = 12;
  let rate = 0;
  while (at < buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(at + 12);
    if (id === 'data') {
      const n = Math.min(size, buf.length - at - 8) >> 1;
      return resample(
        Float32Array.from({ length: n }, (_, i) => buf.readInt16LE(at + 8 + i * 2) / 32768),
        rate,
      );
    }
    at += 8 + size + (size & 1);
  }
  throw new Error('no audio in the reply');
}

/** To RATE (Gemini speaks at 24 kHz), through a windowed-sinc low-pass. */
function resample(x, from) {
  if (from === RATE) return x;
  const ratio = from / RATE;
  const cutoff = Math.min(1, 1 / ratio) * 0.95;
  const taps = 24;
  const out = new Float32Array(Math.floor(x.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const t = i * ratio;
    let sum = 0;
    for (let k = Math.ceil(t - taps); k <= Math.floor(t + taps); k++) {
      if (k < 0 || k >= x.length) continue;
      const d = t - k;
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * cutoff * d) / (Math.PI * cutoff * d);
      sum += x[k] * cutoff * sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / taps));
    }
    out[i] = sum;
  }
  return out;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
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

// Loudness as ITU-R BS.1770 measures it: K-weighted, 400 ms blocks, gated.
function biquad(x, [b0, b1, b2, a1, a2]) {
  const y = new Float32Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    y[i] = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y[i];
  }
  return y;
}
function kWeight(x) {
  let K = Math.tan((Math.PI * 1681.974450955533) / RATE);
  let Q = 0.7071752369554196;
  const Vh = 10 ** (3.999843853973347 / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  K = Math.tan((Math.PI * 38.13547087602444) / RATE);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const highPass = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return biquad(biquad(x, shelf), highPass);
}
function loudness(x) {
  const y = kWeight(x);
  const size = Math.min(y.length, Math.round(RATE * 0.4));
  const step = Math.round(RATE * 0.1);
  const blocks = [];
  for (let at = 0; at + size <= y.length; at += step) {
    let sum = 0;
    for (let i = at; i < at + size; i++) sum += y[i] * y[i];
    blocks.push(sum / size);
  }
  const lufs = (ms) => -0.691 + 10 * Math.log10(ms);
  const mean = (bs) => bs.reduce((a, b) => a + b, 0) / bs.length;
  const loud = blocks.filter((b) => lufs(b) > -70);
  const gate = lufs(mean(loud)) - 10;
  return lufs(mean(loud.filter((b) => lufs(b) > gate)));
}

// Speech or silence in 10 ms frames.
const FRAME = RATE / 100;
function voiced(x) {
  const out = [];
  for (let at = 0; at < x.length; at += FRAME) {
    let sum = 0;
    const end = Math.min(x.length, at + FRAME);
    for (let i = at; i < end; i++) sum += x[i] * x[i];
    out.push(10 * Math.log10(sum / (end - at) + 1e-12) > -50);
  }
  return out;
}

/** Cut a recording into n pieces at its n-1 longest pauses. */
function split(x, n, label) {
  const v = voiced(x);
  const gaps = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i]) continue;
    let j = i;
    while (j < v.length && !v[j]) j++;
    if (i > 0 && j < v.length) gaps.push({ from: i, to: j });
    i = j;
  }
  gaps.sort((a, b) => b.to - b.from - (a.to - a.from));
  const cuts = gaps.slice(0, n - 1).sort((a, b) => a.from - b.from);
  const shortest = Math.min(...cuts.map((g) => g.to - g.from)) * 10;
  const next = gaps[n - 1] ? (gaps[n - 1].to - gaps[n - 1].from) * 10 : 0;
  if (cuts.length < n - 1 || shortest < 300 || next > shortest * 0.7) throw new Error(`${label}: can't find the slot pauses (${shortest} ms vs ${next} ms)`);
  const bounds = [0, ...cuts.flatMap((g) => [g.from * FRAME, g.to * FRAME]), x.length];
  return Array.from({ length: n }, (_, i) => x.subarray(bounds[i * 2], bounds[i * 2 + 1]));
}

/** Trim to PAD seconds of silence (or the recording's own fade) each end. */
function trim(x) {
  const v = voiced(x);
  const first = v.indexOf(true);
  const last = v.lastIndexOf(true);
  if (first < 0) throw new Error('silent piece');
  const pad = Math.round(PAD * RATE);
  const from = first * FRAME - pad;
  const to = Math.min(x.length, (last + 1) * FRAME) + pad;
  const out = new Float32Array(to - from);
  out.set(x.subarray(Math.max(0, from), Math.min(x.length, to)), Math.max(0, -from));
  const fade = Math.round(RATE * 0.01);
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[out.length - 1 - i] *= i / fade;
  }
  return out;
}

/** Record one phrase form: { clip: samples } for each of its parts. */
async function record(lang, g, form, label) {
  const ps = pieces(form);
  const text = ps.map((p) => (p.clip ? p.text : STAND_IN[g][p.slot])).join(GAP);
  // The voice doesn't always pause where asked: try again a few times.
  let audio, cut;
  for (let attempt = 1; !cut; attempt++) {
    audio = await synthesize(lang, text);
    try {
      cut = ps.length > 1 ? split(audio, ps.length, label) : [audio];
    } catch (e) {
      if (attempt === 4) throw e;
      console.log(`  ${e.message}, again`);
    }
  }
  const lufs = loudness(audio);
  let gain = 10 ** ((TARGET_LUFS - lufs) / 20);
  const peak = Math.max(...ps.flatMap((p, i) => (p.clip ? [cut[i].reduce((m, s) => Math.max(m, Math.abs(s)), 0)] : [])));
  if (peak * gain > PEAK) gain = PEAK / peak;
  const out = {};
  ps.forEach((p, i) => {
    if (p.clip) out[p.clip] = trim(cut[i].map((s) => s * gain));
  });
  return { out, lufs: lufs + 20 * Math.log10(gain) };
}

execFileSync(process.execPath, [join(scripts, 'phrases.mjs'), 'build'], {
  stdio: 'ignore',
});
const catalog = JSON.parse(readFileSync(join(dir, 'phrases.json'), 'utf8'));
const placeholdersFile = join(dir, 'placeholders.json');
const placeholders = new Set(existsSync(placeholdersFile) ? JSON.parse(readFileSync(placeholdersFile, 'utf8')) : []);
const manifestFile = join(dir, 'tts.json');
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};

/** Every phrase form: { key, lang, g, form }. */
const forms = Object.entries(catalog.phrases).flatMap(([key, p]) =>
  Object.keys(catalog.languages).flatMap((lang) => Object.entries(p[lang] ?? {}).map(([g, form]) => ({ key, lang, g, form }))),
);
const clipsOf = (form) => form.parts.filter((p) => p.clip).map((p) => p.clip);
const said = (lang, form) => `${MODEL} ${VOICES[lang]} ${STYLES[lang]}: ${form.text}`;

const [cmd, out] = process.argv.slice(2);
const WAIT = cmd === '--wait';
if (cmd === 'samples' || cmd === 'joined') {
  if (!out) throw new Error(`Usage: node scripts/tts-phrases.mjs ${cmd} DIR`);
  mkdirSync(out, { recursive: true });
}

if (cmd === 'samples') {
  const keys = ['sent.one', 'reply.calling_now', 'offline.queued'];
  const voices = ['Sulafat', 'Vindemiatrix', 'Achernar'];
  for (const { key, lang, g, form } of forms.filter((f) => keys.includes(f.key) && f.g === 'm')) {
    const text = form.text.replace(/\{([a-z]+)\}/g, (_, slot) => STAND_IN[g][slot]);
    for (const voice of voices) {
      const audio = await synthesize(lang, text, voice);
      const gain = 10 ** ((TARGET_LUFS - loudness(audio)) / 20);
      writeFileSync(join(out, `${key}_${voice}.wav`), wav(audio.map((s) => s * gain)));
      console.log(`${key} ${voice}`);
    }
  }
} else if (cmd === 'joined') {
  // Each slot gets the stand-in, recorded on its own, as a name clip would be.
  const standIns = {};
  for (const { key, lang, g, form } of forms) {
    if (form.parts.length < 2) continue;
    const parts = [];
    for (const p of form.parts) {
      if (p.clip) parts.push(readWav(readFileSync(join(dir, `${p.clip}.wav`))));
      else {
        const word = STAND_IN[g][p.slot];
        standIns[word] ??= (await record(lang, g, { text: word, parts: [{ clip: 'x' }] }, word)).out.x;
        parts.push(standIns[word]);
      }
    }
    const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (joined.set(p, at), at + p.length), 0);
    writeFileSync(join(out, `${key}_${g}.wav`), wav(joined));
    console.log(`${key} ${g}`);
  }
} else if (!cmd || cmd === '--all' || WAIT) {
  let made = 0;
  for (const { key, lang, g, form } of forms) {
    const clips = clipsOf(form);
    const fresh = clips.every((c) => existsSync(join(dir, `${c}.wav`)) && !placeholders.has(c) && manifest[c] === said(lang, form));
    if (fresh && cmd !== '--all') continue;
    const { out: audio, lufs } = await record(lang, g, form, `${key} ${g}`);
    for (const [clip, samples] of Object.entries(audio)) {
      writeFileSync(join(dir, `${clip}.wav`), wav(samples));
      placeholders.delete(clip);
      manifest[clip] = said(lang, form);
      made++;
    }
    // Saved as it goes, so a stopped run picks up where it left off.
    writeFileSync(placeholdersFile, `${JSON.stringify([...placeholders].sort(), null, 2)}\n`);
    writeFileSync(manifestFile, `${JSON.stringify(Object.fromEntries(Object.entries(manifest).sort()), null, 1)}\n`);
    console.log(`${key} ${g}: ${clips.join(', ')} (${lufs.toFixed(1)} LUFS)`);
  }
  console.log(`${made} recordings written`);
} else {
  console.log('Usage: node scripts/tts-phrases.mjs [--all] | samples DIR | joined DIR');
}
