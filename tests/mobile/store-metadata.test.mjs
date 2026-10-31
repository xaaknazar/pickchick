import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = (path) =>
  readFileSync(new URL(`../../docs/operations/${path}`, import.meta.url), 'utf8');
const metadata = JSON.parse(doc('mobile-appstore-2026-10-22/metadata.json'));
const notes = doc('mobile-review-notes-28.en.txt');
const locales = Object.entries(metadata.localizations);
// Apple App Store Connect limits (characters).
const LIMITS = { name: 30, subtitle: 30, promotionalText: 170, description: 4000, keywords: 100 };
// What the App Store build does not have (owner 29-30.10.2026, App Review 2.1).
const ABSENT = [
  /pick run/i,
  /pick farm/i,
  /скоро|coming soon|\bsoon\b|not yet|ещё не|еще не/i,
  /чик(?!ен)|chiki/i,
  /6\s*\+\s*1/,
  /apple pay|google pay/i,
  /whatsapp/i,
  /[–—]/,
];

test('App Store texts: within the limits, true to build 33', () => {
  assert.deepEqual(
    locales.map(([locale]) => locale),
    ['ru', 'en-GB', 'en-US'],
  );
  for (const [locale, texts] of locales) {
    for (const [field, limit] of Object.entries(LIMITS))
      assert.ok(texts[field].length <= limit, `${locale}.${field}: ${texts[field].length}`);
    const all = Object.values(texts).join('\n');
    for (const pattern of ABSENT) assert.doesNotMatch(all, pattern, `${locale}: ${pattern}`);
    // Ordering and paying with Kaspi.kz, collecting at the counter: one short paragraph.
    assert.match(texts.description, /Kaspi\.kz/);
    assert.match(texts.description, locale === 'ru' ? /у стойки ресторана/ : /restaurant counter/);
    assert.match(texts.promotionalText, /Kaspi\.kz/);
    // The games the app has (the Games tab): Pick Blocks, Pick Man and Magic Sort.
    for (const game of ['Pick Blocks', 'Pick Man', 'Magic Sort'])
      assert.ok(texts.description.includes(game), `${locale}: ${game}`);
  }
  assert.deepEqual(metadata.localizations['en-GB'], metadata.localizations['en-US']);
});

test('App Review notes: the code comes in Telegram only, nothing promised beyond the app', () => {
  assert.match(notes, /Regular customers receive their code in Telegram\./);
  assert.doesNotMatch(notes, /whatsapp/i);
  assert.doesNotMatch(notes, /pick run|apple pay|google pay|coming soon/i);
  assert.match(notes, /pay with Kaspi\.kz/);
});
