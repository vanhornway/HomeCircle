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
import { playSequence, stopSequence } from '../../modules/hc-attention/src/HcAttentionModule';

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
export type Line = { key: string; g?: Gender; name?: string; game?: string };

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

// The phone's voice for each language, looked up once: a voice id, or null if it has none.
const voices = new Map<string, Promise<string | null>>();
function voiceFor(lang: string): Promise<string | null> {
  if (!voices.has(lang)) {
    voices.set(
      lang,
      Speech.getAvailableVoicesAsync()
        .then((all) => all.find((v) => v.language.toLowerCase().startsWith(lang))?.identifier ?? null)
        .catch(() => null),
    );
  }
  return voices.get(lang)!;
}

/** Whether this phone can speak her language aloud (for the admin's setup check). */
export const canSpeak = (lang = language) => voiceFor(lang).then((v) => !!v);

/** Say lines one after the other. */
export function say(...lines: Line[]): boolean {
  const clips = lines.flatMap((l) => (form(l)?.parts ?? []).map((p) => p.clip).filter((c): c is string => !!c));
  if (!clips.some((c) => placeholders.has(c))) return playSequence(clips);
  // Not recorded yet: the phone's voice says it, or the tones play if it has no voice for her language.
  const lang = language;
  voiceFor(lang).then((voice) => {
    if (!voice) {
      playSequence(clips);
      return;
    }
    stopSequence();
    Speech.stop();
    for (const l of lines) Speech.speak(text(l), { language: lang, voice, rate: 0.9 });
  });
  return true;
}

export function hush() {
  stopSequence();
  Speech.stop();
}
