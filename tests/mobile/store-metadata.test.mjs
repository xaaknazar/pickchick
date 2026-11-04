import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = (path) =>
  readFileSync(new URL(`../../docs/operations/${path}`, import.meta.url), 'utf8');
const metadata = JSON.parse(doc('mobile-appstore-2026-10-22/metadata.json'));
const notes = doc('mobile-review-notes-28.en.txt');
// Build 33, the App Store resubmission after 5.1.1(v) (30.10.2026): notes and the Resolution
// Center reply. Codex fills {OPEN}/{CLOSE}/{UTC}/{PACIFIC} on the submission date and {VIDEO}
// only once the owner's physical-device recording exists.
const notes33 = doc('mobile-review-notes-33.en.txt');
const reply33 = doc('mobile-review-reply-33.en.txt');
const english = new Set(
  JSON.parse(
    readFileSync(new URL('../../apps/mobile/src/i18n/messages.json', import.meta.url), 'utf8'),
  ).map((message) => message.en),
);
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
  for (const text of [notes, notes33]) {
    assert.match(text, /Regular customers receive their code in Telegram\./);
    assert.doesNotMatch(text, /whatsapp/i);
    assert.doesNotMatch(text, /pick run|apple pay|google pay|coming soon/i);
    assert.match(text, /pay with Kaspi\.kz/);
  }
});

test('Build 33 notes: under the Apple limit, the deletion path as the app shows it', () => {
  // App Review Information > Notes: 4000 characters, with the placeholders filled in.
  const filled = notes33
    .replaceAll('{OPEN}', '10:00')
    .replaceAll('{CLOSE}', '00:00')
    .replaceAll('{UTC}', '05:00-19:00')
    .replaceAll('{PACIFIC}', '21:00 on the previous day to 11:00 (PST, UTC-8, for 2 November 2026)')
    .replace('{VIDEO}', 'x'.repeat(250));
  assert.ok(filled.length < 4000, String(filled.length));
  assert.match(notes33, /^[\x20-\x7e\n]+$/, 'plain ASCII, plain hyphens');
  for (const [mark, count] of [
    ['{OPEN}', 2],
    ['{CLOSE}', 1],
    ['{UTC}', 1],
    ['{PACIFIC}', 1],
    ['{VIDEO}', 1],
  ])
    assert.equal(notes33.split(mark).length - 1, count, mark);
  // No recording is claimed until Codex replaces {VIDEO} with the owner's video.
  for (const text of [notes33, reply33])
    assert.doesNotMatch(
      text.replace('{VIDEO}', ''),
      /video|recording|attach/i,
      'a recording that does not exist yet',
    );
  // 5.1.1(v): Profile > Delete account > Delete account > confirm > «Account deleted»; Settings too.
  assert.match(notes33, /ACCOUNT DELETION \(Guideline 5\.1\.1\(v\)\)/);
  assert.match(notes33, /tap "Delete account" \(right below "Language"\)/);
  assert.match(notes33, /Profile > Settings \(gear icon\) > "Delete account"/);
  assert.match(notes33, /"Account deleted"/);
  assert.match(notes33, /\(Games tab\)/);
  assert.doesNotMatch(notes33, /Manage data|Events tab/, 'paths of earlier builds');
  // Every quoted label is an English string of this app (the reviewer reads the EN interface).
  const quoted = [...notes33.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(quoted.length >= 10, String(quoted.length));
  for (const label of quoted)
    assert.ok(english.has(label.replace('{OPEN}', '{p0}')), `not an EN label: ${label}`);
  for (const label of ['Continue', 'Done', 'Profile', 'Settings', 'Menu', 'Games', 'Orders'])
    assert.ok(english.has(label), label);
});

test('Build 33 reply to App Review: short, the same path, nothing beyond the app', () => {
  assert.ok(reply33.length < 1200, String(reply33.length));
  assert.match(reply33, /^[\x20-\x7e\n]+$/, 'plain ASCII, plain hyphens');
  assert.match(reply33, /0\.2\.0 \(33\)/);
  assert.match(reply33, /Profile > Delete account/);
  assert.match(reply33, /Profile > Settings \(gear icon\) > Delete account/);
  assert.match(reply33, /"Account deleted"/);
  assert.equal(reply33.split('{VIDEO}').length - 1, 1);
});
