import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// Owner redesign 27.10.2026 (Drinkit pattern): profile button in the top header on all three
// tabs, three-tab bar, profile as a stack route, notifications only inside the profile.
const read = (path) =>
  readFileSync(new URL(`../../apps/mobile/src/${path}`, import.meta.url), 'utf8');
const exists = (path) => existsSync(new URL(`../../apps/mobile/src/${path}`, import.meta.url));

test('one shared header: logo, restaurant picker and a round profile button, no bell', () => {
  const header = read('components/AppHeader.tsx');
  assert.match(header, /testID="header-profile"/);
  assert.match(
    header,
    /testID="header-restaurant"[\s\S]*?onPress=\{\(\) => current\.navigate\('M05'\)\}/,
  );
  assert.match(header, /<Logo size=\{38\} \/>/);
  // The profile button is the last control of the row, so it sits at the right gutter.
  const row = header.slice(header.indexOf('testID="app-header-bar"'));
  assert.ok(row.indexOf('header-restaurant') < row.indexOf('header-profile'));
  const button = row.slice(
    row.indexOf('testID="header-profile"'),
    row.indexOf('</Pressable>', row.indexOf('testID="header-profile"')),
  );
  assert.match(button, /accessibilityRole="button"/);
  assert.match(button, /accessibilityLabel=\{t\('Профиль'\)\}/);
  assert.match(button, /onPress=\{\(\) => current\.navigate\('M30'\)\}/);
  assert.match(header, /profile: \{\s*width: 48,\s*height: 48,\s*borderRadius: 24/);
  // Owner answer: nothing about unread notifications outside the profile.
  const code = header.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(code, /notification|unread|badge|readAt/i);
  assert.match(header, /maxFontSizeMultiplier=\{appHeaderMaxFontScale\}/);
  assert.doesNotMatch(header, /[—–]/, 'plain hyphen only');
});

test('menu, events and orders render the same header; the bell is gone everywhere', () => {
  const catalog = read('screens/CatalogScreens.tsx');
  assert.match(catalog, /testID="storefront-header"[\s\S]*?<AppHeaderBar screen=\{props\} \/>/);
  assert.doesNotMatch(catalog, /storefront-notifications|notifications-outline|'\/notifications'/);
  // The collapsing storefront shell and sticky categories keep their measurements.
  assert.match(catalog, /setCollapsedHeaderHeight\(/);
  assert.match(catalog, /translateY: Math\.max\(headerHeight, categoryTop - scrollY\.value\)/);
  const events = read('screens/GameScreens.tsx');
  assert.match(events, /testID="screen-M26"[^]*?<AppHeader \/>[^]*?testID="scroll-M26"/);
  assert.doesNotMatch(events, /paddingTop: insets\.top/, 'the header already pads the safe area');
  const orders = read('components/OrdersTab.tsx');
  const ordersHeader = orders.slice(orders.indexOf('export function OrdersHeader'));
  assert.match(ordersHeader, /<AppHeader safeArea=\{false\}/);
  assert.match(ordersHeader, /testID="orders-title"/);
  // Every orders variant (simulator, Kaspi, empty, preview) uses OrdersHeader.
  for (const file of [
    'screens/OrderScreens.tsx',
    'screens/ConnectedOrderScreens.tsx',
    'screens/KaspiCheckoutScreen.tsx',
  ])
    assert.match(read(file), /<OrdersHeader \/>/, file);
  // The header reads the current screen without prop drilling.
  assert.match(read('screens/MobileScreen.tsx'), /<AppHeaderContext\.Provider value=\{props\}>/);
});

test('profile is a stack route at /profile with back, reached from the header', () => {
  assert.ok(!exists('app/(tabs)/profile.tsx'), 'no profile tab');
  assert.match(read('app/profile.tsx'), /<ScreenHost id="M30" \/>/);
  assert.match(
    read('app/_layout.tsx'),
    /<Stack\.Screen name="profile" options=\{\{ gestureEnabled: true \}\} \/>/,
  );
  const host = read('ScreenHost.tsx');
  const tabs = host.slice(host.indexOf('const tabRoutes'), host.indexOf('} as const;'));
  assert.doesNotMatch(tabs, /M30|profile/);
  assert.match(host, /const profileRoute = '\/profile';/);
  assert.match(
    host,
    /if \(id === 'M04'\) router\.dismissTo\(profileRoute\);\s*else router\.push\(profileRoute\);/,
  );
  assert.match(host, /else if \(returnTo === 'M30'\) router\.dismissTo\(profileRoute\);/);
  assert.match(
    host,
    /id === 'M30' && next in tabRoutes\)\s*router\.dismissTo\(/,
    'no second tab stack',
  );
  assert.match(host, /if \(id === 'M29'\) return <Redirect href=\{profileRoute\} \/>;/);
  // Guests hit the same auth gate as the old tab: returnTo M30, then back to /profile.
  assert.match(host, /!account\.account && requiresAccount\(next, false\)/);
  assert.match(read('app/auth.tsx'), /destination === 'M30'\) router\.dismissTo\('\/profile'\)/);
  const profile = read('screens/ProfileScreen.tsx');
  assert.match(profile, /testID="profile-back"[\s\S]*?onPress=\{props\.goBack\}/);
  for (const file of [
    'ScreenHost.tsx',
    'app/auth.tsx',
    'screens/ReviewDemoScreen.tsx',
    'app/notifications.tsx',
  ])
    assert.doesNotMatch(read(file), /\(tabs\)\/profile|tab-profile/, file);
});

test('notifications open from a row near the top of the profile and return to it', () => {
  const profile = read('screens/ProfileScreen.tsx');
  const row = profile.indexOf('testID="profile-notifications"');
  assert.ok(row > 0 && profile.indexOf('testID="profile-notifications"', row + 1) === -1);
  assert.ok(row < profile.indexOf("id: 'profile-orders'"), 'above the shortcuts');
  assert.ok(row > profile.indexOf('testID="profile-identity"'), 'below the identity card');
  assert.match(profile, /useNotifications\(\)\.items\.filter\(\(item\) => !item\.readAt\)\.length/);
  assert.match(profile, /count=\{unread\}/);
  assert.match(profile, /t\('Уведомления, непрочитанных: \{p0\}', \{ p0: unread \}\)/);
  assert.match(profile, /router\.push\('\/notifications'\)/);
  const screen = read('app/notifications.tsx');
  assert.match(screen, /label=\{t\('Назад в профиль'\)\}/);
  assert.match(
    screen,
    /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\('\/profile'\)/,
  );
  assert.match(
    screen,
    /router\.dismissTo\(orders \? '\/\(tabs\)\/orders' : '\/\(tabs\)\/events'\)/,
  );
  const messages = JSON.parse(read('i18n/messages.json'));
  for (const ru of ['Уведомления, непрочитанных: {p0}', 'Назад в профиль', 'Профиль']) {
    const entry = messages.find((message) => message.ru === ru);
    assert.ok(entry?.kk && entry.en, ru);
  }
});

test('iOS smoke tests open the profile from the header', () => {
  const smoke = readFileSync(new URL('./ios/SmokeTests.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(smoke, /tab-profile/);
  assert.match(smoke, /tap\("header-profile", in: app\)/);
});
