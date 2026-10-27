import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appHeaderMetrics,
  appHeaderProfileFrame,
} from '../../apps/mobile/src/app-header-metrics.ts';
import { createTapGate, pushSettleMs } from '../../apps/mobile/src/tap-guard.ts';

// Owner redesign 27.10.2026 (Drinkit pattern): profile button in the top header on all three
// tabs, three-tab bar, profile as a stack route, notifications only inside the profile.
// Screen behaviour (positions on every tab, navigation, auth gate, double taps) is covered by
// the browser tests: browser_tab_bar, browser_profile, browser_account_required,
// browser_review_demo, browser_localization. Here: the shared rules, and the contracts that
// those tests and the iOS smoke tests rely on, without pinning source text.

const src = fileURLToPath(new URL('../../apps/mobile/src/', import.meta.url));
const read = (path) => readFileSync(join(src, path), 'utf8');
function sources(dir = src) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test('the profile button keeps the right gutter and a 44 pt target on every width', () => {
  for (const width of [320, 375, 393, 430, 680, appHeaderMetrics.maxWidth]) {
    const frame = appHeaderProfileFrame(width);
    assert.equal(width - frame.right, appHeaderMetrics.gutter, `phone ${width}`);
    assert.ok(frame.width >= 44 && frame.x > width / 2, `phone ${width}`);
  }
  // Wider screens (tablet, desktop web): one centred row with one cap for every tab, so the
  // button cannot jump when switching tabs.
  for (const width of [834, 1024, 1366]) {
    const frame = appHeaderProfileFrame(width);
    assert.equal(frame.right, (width + appHeaderMetrics.maxWidth) / 2 - appHeaderMetrics.gutter);
  }
  assert.ok(appHeaderMetrics.maxFontScale > 1 && appHeaderMetrics.maxFontScale <= 1.5);
});

test('a double tap opens the profile once; the button works again after the push', () => {
  let time = 1000;
  const opened = [];
  const gate = createTapGate(pushSettleMs, () => time);
  const open = () => opened.push(time);
  assert.equal(gate.run(open), true);
  time += 120; // second tap of a double tap
  assert.equal(gate.run(open), false);
  time = 1000 + pushSettleMs - 1;
  assert.equal(gate.run(open), false);
  time = 1000 + pushSettleMs;
  assert.equal(gate.run(open), true);
  // Back on the tab before the window ends: focus re-arms the button at once.
  time += 10;
  gate.reset();
  assert.equal(gate.run(open), true);
  assert.deepEqual(opened, [1000, 1000 + pushSettleMs, 1010 + pushSettleMs]);
  // Long enough for a double tap (second tap 100-300 ms later), short of a deliberate revisit.
  assert.ok(pushSettleMs >= 300 && pushSettleMs <= 600);
});

test('header and the screens it opens use the shared guards; no unread mark on the header', () => {
  const header = read('components/AppHeader.tsx');
  assert.match(header, /useTapGate\(\)/);
  assert.match(header, /app-header-metrics/);
  // Opened under the finger: profile top bar (member), sign-in sheet and its header (guest).
  for (const file of [
    'screens/ProfileScreen.tsx',
    'components/AuthWelcome.tsx',
    'components/OrderSheet.tsx',
  ])
    assert.match(read(file), /useTapsSettled\(\)/, file);
  // Owner answer: nothing about unread notifications outside the profile.
  assert.doesNotMatch(header, /notifications\/|useNotifications|readAt/);
  assert.doesNotMatch(header, /[—–]/, 'plain hyphen only');
});

test('contracts for the browser and iOS tests: test IDs, routes, no bell, no profile tab', () => {
  const files = sources().map((path) => [path, readFileSync(path, 'utf8')]);
  const ids = new Set(
    files.flatMap(([, text]) => [...text.matchAll(/testID="([^"]+)"/g)].map((m) => m[1])),
  );
  for (const id of [
    'app-header',
    'app-header-bar',
    'header-profile',
    'header-restaurant',
    'storefront-header',
    'orders-title',
    'profile-back',
    'profile-settings',
    'profile-notifications',
  ])
    assert.ok(ids.has(id), id);
  // Removed by the redesign: the bell and the profile tab (and links to it).
  for (const [path, text] of files)
    assert.doesNotMatch(text, /storefront-notifications|tab-profile|\(tabs\)\/profile/, path);
  // Exactly three tabs; the profile is a stack route at the old URL /profile.
  const tabs = readdirSync(join(src, 'app/(tabs)'))
    .filter((name) => !name.startsWith('_'))
    .sort();
  assert.deepEqual(tabs, ['events.tsx', 'menu.tsx', 'orders.tsx']);
  assert.ok(existsSync(join(src, 'app/profile.tsx')));
});

test('new header and profile strings are translated', () => {
  const messages = JSON.parse(read('i18n/messages.json'));
  for (const ru of ['Уведомления, непрочитанных: {p0}', 'Назад в профиль', 'Профиль']) {
    const entry = messages.find((message) => message.ru === ru);
    assert.ok(entry?.kk && entry.en, ru);
  }
});

test('iOS smoke tests open the profile from the visible header', () => {
  const smoke = readFileSync(new URL('./ios/SmokeTests.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(smoke, /"tab-profile"/);
  assert.match(smoke, /"header-profile"/);
  // Visited tabs stay mounted, so a plain firstMatch could pick a hidden tab's header.
  assert.doesNotMatch(smoke, /tap\("header-profile"/);
});
