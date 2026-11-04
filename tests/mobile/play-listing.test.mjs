// Google Play listing pack (lane android, 05.11.2026): the texts stay within Play's limits, say
// only what the production build does, and every code path the Data safety answers cite exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const pack = (name) =>
  readFileSync(new URL(`docs/operations/mobile-play-2026-11/${name}`, root), 'utf8');
const listing = JSON.parse(pack('listing.json'));
const appStore = JSON.parse(
  readFileSync(new URL('docs/operations/mobile-appstore-2026-10-22/metadata.json', root), 'utf8'),
);
const messages = JSON.parse(
  readFileSync(new URL('apps/mobile/src/i18n/messages.json', root), 'utf8'),
);
// Google Play limits (characters).
const LIMITS = { title: 30, shortDescription: 80, fullDescription: 4000 };
// What the production build does not have (same rules as the App Store texts, store-metadata.test).
const ABSENT = [
  /pick run/i,
  /pick farm/i,
  /скоро|coming soon|\bsoon\b|not yet|ещё не|еще не|жақында/i,
  /чик(?!ен)|chiki|чиктер/i,
  /6\s*\+\s*1/,
  /apple pay|google pay/i,
  /whatsapp/i,
  /app store|iphone|testflight/i,
  /[–—]/,
];

test('listing: three languages within Play limits, true to the production build', () => {
  assert.equal(listing.packageName, 'kz.pickchick.app');
  assert.equal(listing.category, 'FOOD_AND_DRINK');
  assert.equal(listing.contactEmail, '{SUPPORT_EMAIL}');
  assert.equal(listing.website, 'https://pickchick.kz');
  assert.equal(listing.privacyPolicy, 'https://pickchick.kz/legal/privacy');
  assert.equal(listing.accountDeletionUrl, 'https://pickchick.kz/support/#delete-account');
  assert.equal(listing.containsAds, false);
  assert.equal(listing.inAppPurchases, false);
  assert.deepEqual(Object.keys(listing.listings), ['ru-RU', 'kk', 'en-US']);
  for (const [locale, texts] of Object.entries(listing.listings)) {
    for (const [field, limit] of Object.entries(LIMITS))
      assert.ok(texts[field].length <= limit, `${locale}.${field}: ${texts[field].length}`);
    assert.equal(texts.title, 'PickChick');
    const all = Object.values(texts).join('\n');
    for (const pattern of ABSENT) assert.doesNotMatch(all, pattern, `${locale}: ${pattern}`);
    assert.match(texts.fullDescription, /Kaspi\.kz/);
    assert.match(texts.shortDescription, /Kaspi\.kz/);
    for (const game of ['Pick Blocks', 'Pick Man', 'Magic Sort'])
      assert.ok(texts.fullDescription.includes(game), `${locale}: ${game}`);
    assert.match(texts.fullDescription, /Telegram/);
  }
  // The App Store texts are the source for Russian and English.
  assert.equal(listing.listings['ru-RU'].fullDescription, appStore.localizations.ru.description);
  assert.equal(
    listing.listings['en-US'].fullDescription,
    appStore.localizations['en-US'].description,
  );
  // Kazakh is Kazakh, not a copy of the Russian text.
  assert.match(listing.listings.kk.fullDescription, /[ӘәҒғҚқҢңӨөҰұҮүІі]/);
  assert.notEqual(listing.listings.kk.fullDescription, listing.listings['ru-RU'].fullDescription);
});

test('Data safety answers cite code that exists and match the release config', () => {
  const text = pack('data-safety.md');
  const cited = [...text.matchAll(/`((?:apps|scripts|infra|tests|docs)\/[^`\s]+)`/g)].map(
    (m) => m[1],
  );
  assert.ok(cited.length >= 10, String(cited.length));
  for (const path of cited) assert.ok(existsSync(new URL(path, root)), path);
  for (const type of [
    'Phone number',
    'Name',
    'Other info',
    'Purchase history',
    'Other user-generated content',
    'Device or other IDs',
  ])
    assert.match(text, new RegExp(`(?:> |\\| )${type} `), type);
  for (const answer of ['encrypted in transit', 'request that their data is deleted'])
    assert.match(text, new RegExp(answer));
  assert.match(text, /https:\/\/pickchick\.kz\/support\/#delete-account/);
  assert.match(text, /Kaspi\.kz/);
  assert.match(text, /Telegram/);
  assert.doesNotMatch(text, /[–—]/);
  const app = JSON.parse(readFileSync(new URL('apps/mobile/app.json', root), 'utf8')).expo;
  assert.equal(app.android.allowBackup, false);
  assert.ok(app.android.blockedPermissions.includes('com.google.android.gms.permission.AD_ID'));
  const dependencies = Object.keys(
    JSON.parse(readFileSync(new URL('apps/mobile/package.json', root), 'utf8')).dependencies,
  );
  // «No analytics, ads or crash reporting» stays true only while no such SDK is added.
  for (const name of dependencies)
    assert.doesNotMatch(name, /analytics|sentry|crashlytics|bugsnag|admob|ads|firebase\/app/, name);
});

test('reviewer access: credentials only in Play fields, labels exist in the app', () => {
  const text = pack('app-access.en.txt');
  assert.match(text, /^[\x20-\x7e\n]+$/, 'plain ASCII, plain hyphens');
  // No phone number or code in the text: only Play Console's credential fields hold them.
  assert.doesNotMatch(text, /\+7\s?\d{3}|\b\d{10}\b|\b\d{4}\b(?!-)/);
  const short = text.split('SHORT (for "Any other information")\n')[1].split('\n\nLONG')[0];
  assert.ok(short.length <= 500, String(short.length));
  const english = new Set(messages.map((message) => message.en));
  for (const label of [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1])) {
    if (
      ['All or some functionality in my app is restricted', 'Any other information'].includes(label)
    )
      continue;
    assert.ok(english.has(label), `the app has no English label "${label}"`);
  }
  assert.match(text, /Regular customers receive their code in Telegram\./);
  assert.match(text, /https:\/\/pickchick\.kz\/support\/#delete-account/);
});

test('rating, deletion page and testers guide are present and honest', () => {
  const rating = pack('content-rating.md');
  assert.match(rating, /18 лет и старше/);
  assert.match(rating, /Families/);
  assert.match(rating, /Ads: \*\*No\*\*/);
  const deletion = pack('account-deletion-web.md');
  assert.match(deletion, /https:\/\/pickchick\.kz\/support\/#delete-account/);
  for (const path of [
    'infra/public-staging/support/content.json',
    'infra/public-staging/support/render.py',
    'tests/operations/test_support_page_release.py',
  ]) {
    assert.ok(deletion.includes(path), path);
    assert.ok(existsSync(new URL(path, root)), path);
  }
  const support = JSON.parse(
    readFileSync(new URL('infra/public-staging/support/content.json', root), 'utf8'),
  );
  for (const language of ['ru', 'kk', 'en'])
    assert.ok(deletion.includes(support[language].delete_request), language);
  const guide = pack('testers-guide.ru.md');
  assert.match(guide, /14 дней подряд/);
  assert.match(guide, /12 человек/);
  assert.match(guide, /\{OPT_IN_LINK\}/);
  assert.match(guide, /Настоящие заказы и оплату не делайте/);
  for (const text of [rating, deletion, guide]) assert.doesNotMatch(text, /[–—]/);
});
