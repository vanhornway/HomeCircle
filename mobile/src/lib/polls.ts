// Helpers for polls in the app: previews, templates and option ideas.
import type { CircleClient, Message } from '@homecircle/core';
import { KIND_EMOJI } from './visits';

/** A message as one line for notifications and the chat list ("📊 Question" for a poll). */
export function previewText(m: Message): string {
  if (m.body?.poll?.question) return `📊 ${m.body.poll.question}`;
  return String(m.body?.text ?? '');
}

/** Quick starts for the question. */
export const POLL_TEMPLATES: { question: string; options: { label: string; emoji: string }[] }[] = [
  { question: 'Where should we eat?', options: [] },
  { question: 'What time works?', options: [{ label: '5 pm', emoji: '🕔' }, { label: '6 pm', emoji: '🕕' }, { label: '7 pm', emoji: '🕖' }] },
  { question: 'Movie night: what are we watching?', options: [] },
  { question: 'Weekend plan?', options: [{ label: 'Beach', emoji: '🏖️' }, { label: 'Hike', emoji: '🥾' }, { label: 'Stay in', emoji: '🛋️' }] },
  { question: 'Pizza toppings?', options: [{ label: 'Pepperoni', emoji: '🍕' }, { label: 'Veggie', emoji: '🥦' }, { label: 'Cheese', emoji: '🧀' }] },
];

/** Emoji to choose from for an option. */
export const OPTION_EMOJI = ['🍕', '🌮', '🍣', '🍔', '🍜', '🥗', '🍝', '🥟', '🍦', '☕', '🎬', '🎮', '🎲', '🏖️', '🥾', '⚽', '🛋️', '🛒', '🎉', '✅', '❌', '👍', '👎', '🤷'];

/**
 * Option ideas from the circle's own places: everyone's most visited food
 * and shopping spots, and the circle's saved places.
 */
export function placeIdeas(client: CircleClient): { label: string; emoji: string }[] {
  const out = new Map<string, { label: string; emoji: string }>();
  for (const { places } of client.frequent.values()) {
    for (const p of places) {
      if (['food', 'shopping', 'grocery', 'park', 'gym'].includes(p.kind) && !p.name.startsWith('Near ')) out.set(p.name.toLowerCase(), { label: p.name, emoji: KIND_EMOJI[p.kind] });
    }
  }
  for (const p of client.places.values()) {
    if (p.name && !out.has(p.name.toLowerCase())) out.set(p.name.toLowerCase(), { label: p.name, emoji: '📍' });
  }
  return [...out.values()].slice(0, 12);
}
