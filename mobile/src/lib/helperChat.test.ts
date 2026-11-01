// The helper in a chat: questions by name, questions shown plainly, compact replies.
//   node --experimental-strip-types --test src/lib/helperChat.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askedText, helperQuestion, isHelperStatusLine, parseHelperReply } from './helperChat.ts';

test('a message that starts with the helper’s name is a question for it', () => {
  assert.equal(helperQuestion('Chirya, remember our dentist is Dr. Lee', 'Chirya'), 'remember our dentist is Dr. Lee');
  assert.equal(helperQuestion('chirya: when is the dentist?', 'Chirya'), 'when is the dentist?');
  assert.equal(helperQuestion('Hey Chirya, what’s on this week?', 'Chirya'), 'what’s on this week?');
  assert.equal(helperQuestion('@Chirya what’s on this week?', 'Chirya'), 'what’s on this week?');
  assert.equal(helperQuestion('@chirya, add milk to Costco', 'Chirya'), 'add milk to Costco');
  assert.equal(helperQuestion('  Chirya ,  remember\nthis too ', 'Chirya'), 'remember\nthis too');
});

test('the slash form still works for anyone who types it', () => {
  assert.equal(helperQuestion('/Chirya when is the dentist?', 'Chirya'), 'when is the dentist?');
  assert.equal(helperQuestion('/chirya/dream', 'Chirya'), 'dream');
  assert.equal(helperQuestion('/agent when is the dentist?', 'Chirya'), 'when is the dentist?');
});

test('a name with spaces or symbols is matched as written', () => {
  assert.equal(helperQuestion('Big Bird, remember the gate code is gone', 'Big Bird'), 'remember the gate code is gone');
  assert.equal(helperQuestion('@Big Bird when?', 'Big Bird'), 'when?');
  assert.equal(helperQuestion('J.A.R.V.I.S., hi', 'J.A.R.V.I.S.'), 'hi');
  // The dots are literal: "JxAxRxVxIxSx" isn't the name.
  assert.equal(helperQuestion('JxAxRxVxIxSx, hi', 'J.A.R.V.I.S.'), null);
});

test('ordinary messages are not questions', () => {
  assert.equal(helperQuestion('Chirya is so useful', 'Chirya'), null);
  assert.equal(helperQuestion('Ask Chirya, she knows', 'Chirya'), null);
  assert.equal(helperQuestion('Chiryas, everyone', 'Chirya'), null);
  assert.equal(helperQuestion('@Chiryas hi', 'Chirya'), null);
  assert.equal(helperQuestion('/Chiryas hi', 'Chirya'), null);
  assert.equal(helperQuestion('Dinner at 7', 'Chirya'), null);
  // The name with nothing to ask.
  assert.equal(helperQuestion('Chirya,', 'Chirya'), null);
  assert.equal(helperQuestion('@Chirya', 'Chirya'), null);
  assert.equal(helperQuestion('/Chirya ', 'Chirya'), null);
  assert.equal(helperQuestion('Chirya, hi', ''), null);
});

test('a question shows as the person’s own words', () => {
  assert.equal(askedText('/Chirya when is the dentist?', 'Chirya'), 'when is the dentist?');
  assert.equal(askedText('/Chirya 📎 calendar.pdf', 'Chirya'), '📎 calendar.pdf');
  assert.equal(askedText('/Big Bird when?', 'Big Bird'), 'when?');
  // Asked before the helper was renamed.
  assert.equal(askedText('/Jarvis when?', 'Chirya'), 'when?');
  assert.equal(askedText('when?', 'Chirya'), 'when?');
});

test('“Remembered” comes apart into what was kept and short privacy notes', () => {
  assert.deepEqual(parseHelperReply('📌 Remembered: Dr. Lee'), { text: '', kept: { verb: 'Remembered', titles: ['Dr. Lee'] }, extra: [], notes: [] });
  assert.deepEqual(parseHelperReply('📌 Remembered: Kid; Sam').kept, { verb: 'Remembered', titles: ['Kid', 'Sam'] });

  const doc = parseHelperReply(
    '📌 Remembered: Mom’s passport\n⏰ I’ll remind every admin about Renew Mom’s passport on Sep 1, 2030.\n🔒 I left out a password, code or full number: what I read goes to the AI provider, so I never keep those, only the last 4 digits of a number.',
  );
  assert.deepEqual(doc.kept, { verb: 'Remembered', titles: ['Mom’s passport'] });
  assert.deepEqual(doc.extra, ['⏰ I’ll remind every admin about Renew Mom’s passport on Sep 1, 2030.']);
  assert.equal(doc.notes.length, 1);
  assert.equal(doc.notes[0].short, 'Left out a password or full number');
  assert.match(doc.notes[0].full, /^I left out a password, code or full number: what I read goes to the AI provider/);

  const health = parseHelperReply('📌 Remembered: Amoxicillin\n🔒 Health notes are just for you. Say “share it with the circle” to keep one for everyone.');
  assert.equal(health.notes[0].short, 'Health notes stay private to you');

  // A note it doesn't know keeps its first sentence.
  assert.equal(parseHelperReply('📌 Saved: X\n🔒 Something new. With a reason.').notes[0].short, 'Something new');
});

test('an answer that also kept something keeps its answer', () => {
  const r = parseHelperReply('The dentist is on Friday.\n\n📌 Remembered: Dentist Friday');
  assert.equal(r.text, 'The dentist is on Friday.');
  assert.deepEqual(r.kept, { verb: 'Remembered', titles: ['Dentist Friday'] });
});

test('an ordinary answer is left alone', () => {
  assert.deepEqual(parseHelperReply('Sam is free from Jun 3 to Jun 9.'), { text: 'Sam is free from Jun 3 to Jun 9.', kept: null, extra: [], notes: [] });
  assert.equal(isHelperStatusLine('↩️ Undone.'), true);
  assert.equal(isHelperStatusLine('Nothing to undo.'), true);
  assert.equal(isHelperStatusLine('↩️ Undone. And more'), false);
});
