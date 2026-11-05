// What she hears, and the same line written for the screen, from the phrase
// catalog (assets/phrases, built from phrases.csv by scripts/phrases.mjs).
// A phrase plays as recorded parts around its slots: a person's name clip
// (recorded by an admin, coming later) goes where {name} is; until one is
// recorded the slot is skipped and the screen shows who it's about.
//
// Until a phrase's recordings exist (they're placeholder tones for now), the
// phone's own text-to-speech says it in her language, name included, if the
// phone has a voice for that language; otherwise she hears the tones.
import * as Speech from 'expo-speech';
import catalog from '../../assets/phrases/phrases.json';
import placeholderList from '../../assets/phrases/placeholders.json';
import { diag } from '../lib/diagnostics';
import { playSequence, stopSequence } from '../../modules/hc-attention/src/HcAttentionModule';
import { captionMs, watchStart } from './speechWatch';

export type Gender = 'm' | 'f';
type Part = { clip?: string; slot?: string };
type Form = { text: string; parts: Part[] };
type Phrase = { en: string; gender: string | null } & Record<string, unknown>;

const PHRASES = catalog.phrases as Record<string, Phrase>;
export const LANGUAGES = catalog.languages as Record<string, { name: string; english: string; rtl: boolean }>;

/** Her language; admins choose it (one language today: Urdu). */
let language = 'ur';
export function setLanguage(lang: string) {
  if (LANGUAGES[lang]) language = lang;
}

/** One line: a phrase, the he/she its verbs follow, and what fills its slots. */
export type Line = { key: string; g?: Gender; name?: string; names?: string; game?: string };

function form({ key, g }: Line): Form | null {
  const forms = PHRASES[key]?.[language] as Partial<Record<Gender, Form>> | undefined;
  if (!forms) return null;
  return (g === 'f' && forms.f) || forms.m || null;
}

/** The line as written, with names in place of its slots. */
export function text(line: Line): string {
  const f = form(line);
  if (!f) return '';
  return f.text.replace(/\{([a-z]+)\}/g, (_, slot: string) => String((line as Record<string, unknown>)[slot] ?? '')).trim();
}

const placeholders = new Set(placeholderList as string[]);

// The phone's voice for each language. A voice that was found is kept; "no voice" is
// asked again after a minute, because Android's speech engine is often not ready the
// first time the app asks (and a "none" kept for good would silence her for good).
const voices = new Map<string, { id: string | null; at: number }>();
const NO_VOICE_RETRY_MS = 60_000;

async function voiceFor(lang: string): Promise<string | null> {
  const hit = voices.get(lang);
  if (hit && (hit.id || Date.now() - hit.at < NO_VOICE_RETRY_MS)) return hit.id;
  const id = await Speech.getAvailableVoicesAsync()
    // ISO 639-1 ("ur-PK") or 639-2 ("urd-PAK"): engines differ.
    .then((all) => all.find((v) => /^(ur|urd)([-_]|$)/i.test(v.language))?.identifier ?? null)
    .catch(() => null);
  voices.set(lang, { id, at: Date.now() });
  return id;
}

/** Whether this phone can speak her language aloud (for the admin's setup check). */
export const canSpeak = (lang = language) => voiceFor(lang).then((v) => !!v);

// What she's hearing, shown on her screen while it plays.
let caption: string | null = null;
let captionTimer: ReturnType<typeof setTimeout> | null = null;
const captionSubs = new Set<() => void>();
const setCaption = (next: string | null) => {
  if (captionTimer) clearTimeout(captionTimer);
  captionTimer = next ? setTimeout(() => setCaption(null), captionMs(next)) : null;
  caption = next;
  captionSubs.forEach((fn) => fn());
};
/** The line being said now, or null (for useSyncExternalStore). */
export const spokenLine = () => caption;
export function onSpokenLine(fn: () => void) {
  captionSubs.add(fn);
  return () => {
    captionSubs.delete(fn);
  };
}

/** A name goes where its slot is, and there are no name clips yet: only the phone's voice can say the whole line. */
const needsVoice = (l: Line) => (form(l)?.parts ?? []).some((p) => p.slot && (l as Record<string, unknown>)[p.slot]);

// The newest line wins: an older one's checks stop counting once another has started.
let current: ReturnType<typeof watchStart> | null = null;
let turn = 0;

/** Say lines one after the other, and show them. Whatever goes wrong, she still hears the recordings (tones for now). */
export function say(...lines: Line[]): boolean {
  const me = ++turn;
  current?.cancel();
  setCaption(lines.map(text).filter(Boolean).join('\n') || null);
  const clips = lines.flatMap((l) => (form(l)?.parts ?? []).map((p) => p.clip).filter((c): c is string => !!c));
  if (!clips.some((c) => placeholders.has(c)) && !lines.some(needsVoice)) {
    diag('say', { how: 'clips', n: clips.length });
    return playSequence(clips);
  }
  // Not recorded yet: the phone's voice says it; the tones play if it has no voice for her
  // language, never starts, or reports an error (the speech engine can drop out after the
  // app has been in the background for a while).
  const lang = language;
  const fallback = (why: string) => {
    if (me !== turn) return;
    turn++;
    current?.cancel();
    diag('say:fallback', { why });
    Speech.stop();
    playSequence(clips);
  };
  voiceFor(lang)
    .then((voice) => {
      if (me !== turn) return;
      if (!voice) return fallback('no-voice');
      stopSequence();
      Speech.stop();
      current = watchStart(Speech.isSpeakingAsync, () => fallback('no-start'));
      lines.forEach((l, i) =>
        Speech.speak(text(l), {
          voice,
          language: lang,
          rate: 0.9,
          onStart: () => {
            if (i !== 0 || me !== turn) return;
            current?.started();
            diag('say', { how: 'voice' }).catch(() => {});
          },
          onError: () => fallback('error'),
        }),
      );
    })
    .catch(() => fallback('exception'));
  return true;
}

export function hush() {
  turn++;
  current?.cancel();
  setCaption(null);
  stopSequence();
  Speech.stop();
}
