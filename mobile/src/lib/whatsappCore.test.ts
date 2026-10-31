// WhatsApp number cleaning and link building, checked with plain Node:
//   node --test --experimental-strip-types src/lib/whatsappCore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLinkFrom, chatUrls, cleanCallUrl, cleanNumber, storeUrls, type NumberProblem } from './whatsappCore.ts';

const digits = (raw: unknown) => {
  const r = cleanNumber(raw);
  return r.ok ? r.digits : r.problem;
};

test('numbers keep only digits, in E.164 order, without the +', () => {
  assert.equal(digits('+92 300 1234567'), '923001234567');
  assert.equal(digits('+92 (300) 123-4567'), '923001234567');
  assert.equal(digits('  +1.555.123.4567 '), '15551234567');
  assert.equal(digits('+1 555‑123‑4567'.replace(/‑/g, '-')), '15551234567');
  assert.equal(digits('+44 7911 123456'), '447911123456');
});

test('a leading 00 means +', () => {
  assert.equal(digits('0092 300 1234567'), '923001234567');
  assert.equal(digits('00 1 555 123 4567'), '15551234567');
});

test('a local number is refused, never guessed', () => {
  assert.equal(digits('0300 1234567'), 'no_country_code');
  assert.equal(digits('(555) 123-4567'), 'no_country_code');
  assert.equal(digits('3001234567'), 'no_country_code');
  assert.equal(digits('923001234567'), 'no_country_code', 'digits alone could be local: ask for the +');
  assert.equal(digits('92+3001234567'), 'no_country_code');
  assert.equal(digits('++923001234567'), 'no_country_code');
});

test('empty, short, long, letters, odd country codes', () => {
  for (const e of ['', '   ', null, undefined, 42, '+']) assert.equal(digits(e), 'empty', String(e));
  assert.equal(digits('+1234567'), 'too_short');
  assert.equal(digits('+1 555'), 'too_short');
  assert.equal(digits('+1234567890123456'), 'too_long');
  assert.equal(digits('+1 555 CALL NOW'), 'letters');
  assert.equal(digits('+1 555 123 4567 ext. 9'), 'letters');
  assert.equal(digits('+1 555 123 4567; rm -rf'), 'letters');
  assert.equal(digits('+0123456789'), 'bad_country_code');
  assert.equal(digits('0000123456789'), 'bad_country_code');
  const problems: NumberProblem[] = ['empty', 'letters', 'no_country_code', 'too_short', 'too_long', 'bad_country_code'];
  assert.equal(new Set(problems).size, 6);
});

test('chat links: the app link first, wa.me as the fallback, text encoded', () => {
  assert.deepEqual(chatUrls('923001234567'), { app: 'whatsapp://send?phone=923001234567', web: 'https://wa.me/923001234567' });
  const u = chatUrls('15551234567', 'Umair is calling you on WhatsApp & wants “chai”?\n#1');
  assert.equal(u.app, 'whatsapp://send?phone=15551234567&text=Umair%20is%20calling%20you%20on%20WhatsApp%20%26%20wants%20%E2%80%9Cchai%E2%80%9D%3F%0A%231');
  assert.equal(u.web, 'https://wa.me/15551234567?text=Umair%20is%20calling%20you%20on%20WhatsApp%20%26%20wants%20%E2%80%9Cchai%E2%80%9D%3F%0A%231');
  assert.equal(new URL(u.web).searchParams.get('text'), 'Umair is calling you on WhatsApp & wants “chai”?\n#1');
});

test('an empty or blank line adds no text parameter, and a long one is cut', () => {
  for (const blank of [undefined, null, '', '   ']) assert.equal(chatUrls('15551234567', blank).app, 'whatsapp://send?phone=15551234567');
  const long = chatUrls('15551234567', 'ا'.repeat(5000));
  assert.ok(decodeURIComponent(long.web.split('text=')[1]).length === 1000);
});

test('call links: only https call.whatsapp.com video or voice links', () => {
  const ok = 'https://call.whatsapp.com/video/AbCdEfGh1234';
  assert.equal(cleanCallUrl(ok), ok);
  assert.equal(cleanCallUrl(` ${ok}?src=share#top `), ok);
  assert.equal(cleanCallUrl('https://call.whatsapp.com/voice/AbCdEfGh1234/'), 'https://call.whatsapp.com/voice/AbCdEfGh1234');
  for (const bad of [
    'http://call.whatsapp.com/video/AbCdEfGh1234',
    'https://wa.me/15551234567',
    'https://call.whatsapp.com.evil.com/video/AbCdEfGh1234',
    'https://call.whatsapp.com@evil.com/video/AbCdEfGh1234',
    'https://evil.com/?u=https://call.whatsapp.com/video/AbCdEfGh1234',
    'https://call.whatsapp.com/video/short',
    'https://call.whatsapp.com/other/AbCdEfGh1234',
    'https://call.whatsapp.com/video/AbCdEfGh1234/extra',
    'https://call.whatsapp.com:8443/video/AbCdEfGh1234',
    'whatsapp://call.whatsapp.com/video/AbCdEfGh1234',
    'javascript:alert(1)',
    '',
    null,
    7,
  ]) {
    assert.equal(cleanCallUrl(bad), null, String(bad));
  }
});

test('the call link is built from whatever was pasted', () => {
  const link = 'https://call.whatsapp.com/video/AbCdEfGh1234567890xyz';
  assert.equal(callLinkFrom(link), link);
  assert.equal(callLinkFrom(`Join my WhatsApp call: ${link}\nSee you there`), link, 'share text around it');
  assert.equal(callLinkFrom('call.whatsapp.com/voice/AbCdEfGh1234567890xyz?x=1'), 'https://call.whatsapp.com/voice/AbCdEfGh1234567890xyz');
  assert.equal(callLinkFrom('http://call.whatsapp.com/video/AbCdEfGh1234567890xyz'), link, 'upgraded to https');
  assert.equal(callLinkFrom('  AbCdEfGh1234567890xyz  '), link, 'just the code');
  assert.equal(cleanCallUrl(callLinkFrom('x https://evil.com/?u=https://call.whatsapp.com/video/AbCdEfGh1234567890xyz')), link, 'only the code is taken; the host is ours');
  for (const bad of ['', 'hello', 'https://call.whatsapp.com/video/', 'https://call.whatsapp.com.evil.com/video/AbCdEfGh1234567890xyz', 'https://evil.com/video/AbCdEfGh1234567890xyz', 'short', 'two words here that are long enough', null, 5]) {
    assert.equal(callLinkFrom(bad), null, String(bad));
  }
});

test('where to get WhatsApp', () => {
  assert.deepEqual(storeUrls('android'), ['market://details?id=com.whatsapp', 'https://play.google.com/store/apps/details?id=com.whatsapp']);
  assert.deepEqual(storeUrls('ios'), ['https://apps.apple.com/app/whatsapp-messenger/id310633997']);
});
