import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  measuredTabBarInset,
  tabBarMetrics,
  tabBarPalette,
  tabCartDockEstimate,
  tabCartGap,
  tabContentInset,
  tabBarTabCount,
  tabItemWidth,
  tabLabelMaxScale,
  tabLabelMinFit,
  tabLabelSize,
} from '../../apps/mobile/src/tab-bar-metrics.ts';

const read = (path) =>
  readFileSync(new URL(`../../apps/mobile/src/${path}`, import.meta.url), 'utf8');

/**
 * Source shape that survives reformatting (tech lead 28.10.2026): Prettier may break props onto
 * lines, wrap JSX in parentheses or add trailing commas. None of that changes the code, so the
 * source and the expected snippet are compared without any of it.
 */
const squash = (code) =>
  code
    .replace(/\s+/g, '')
    .replace(/,(?=[)\]}])/g, '')
    .replace(/\(</g, '<')
    .replace(/>\)/g, '>');
function assertHas(code, snippet, message) {
  assert.ok(squash(code).includes(squash(snippet)), message ?? `source has: ${snippet}`);
}
const before = (code, first, second) => {
  const a = squash(code).indexOf(squash(first));
  const b = squash(code).indexOf(squash(second));
  return a >= 0 && b > a;
};

test('source checks ignore formatting, not code', () => {
  const formatted = `tabBar={(props) => (
    <FloatingTabBar
      {...props}
      onTabBarHeight={setTabBarHeight}
    />
  )}`;
  assertHas(
    formatted,
    'tabBar={(props) => <FloatingTabBar {...props} onTabBarHeight={setTabBarHeight} />}',
  );
  assertHas('f({ a: 1, b: 2, })', 'f({ a: 1, b: 2 })');
  assert.ok(!squash(formatted).includes(squash('onTabBarHeight={setCartDockHeight}')));
});

function rgb(color) {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const parts = color
    .match(/rgba\(([^)]+)\)/)[1]
    .split(',')
    .map(Number);
  return parts;
}
function over(top, bottom) {
  const [r, g, b, a] = rgb(top);
  const [br, bg, bb] = rgb(bottom);
  return `#${[r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)]
    .map((v) => Math.round(v).toString(16).padStart(2, '0'))
    .join('')}`;
}
function luminance(color) {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('floating capsule sits above the home indicator and stays compact', () => {
  const phone = tabBarMetrics({ bottom: 34, left: 0, right: 0 }, 1);
  assert.equal(phone.bottom, 20);
  assert.equal(phone.height, 64);
  assert.equal(phone.inset, 84);
  assert.equal(phone.side, 16);
  const flat = tabBarMetrics({ bottom: 0 }, 1);
  assert.equal(flat.bottom, 12, 'devices without a home indicator keep a visible gap');
  assert.equal(flat.inset, 76);
  const landscape = tabBarMetrics({ bottom: 21, left: 47, right: 47 }, 1);
  assert.equal(landscape.side, 63, 'side safe areas keep the capsule off the notch');
  assert.equal(landscape.bottom, 12);
});

test('tab targets meet 48pt and large text grows the bar only up to the cap', () => {
  for (const scale of [0.8, 1, 1.15, 1.3, 2, 3.1]) {
    const m = tabBarMetrics({ bottom: 34 }, scale);
    assert.ok(m.itemHeight >= 48, `scale ${scale}`);
    assert.equal(m.height, m.itemHeight + m.padding * 2);
  }
  assert.deepEqual(
    tabBarMetrics({ bottom: 34 }, 3.1),
    tabBarMetrics({ bottom: 34 }, tabLabelMaxScale),
  );
  assert.ok(tabBarMetrics({ bottom: 34 }, 2).height <= 72);
});

test('brand colours keep WCAG AA for labels on glass, opaque and active pill', () => {
  const p = tabBarPalette;
  // Worst cases: glass over a white photo and over the navy app background.
  for (const backdrop of ['#FFFFFF', '#04143A', '#FF6900']) {
    assert.ok(contrast(p.inactive, over(p.glass, backdrop)) >= 4.5, backdrop);
  }
  assert.ok(contrast(p.inactive, p.solid) >= 4.5);
  assert.ok(contrast(p.active, p.pill) >= 4.5);
  assert.equal(p.active.toUpperCase(), '#FF8A3D', 'mobile accentText token');
});

test('tabs keep order, labels, gates and accessibility semantics', () => {
  const layout = read('app/(tabs)/_layout.tsx');
  assertHas(layout, 'tabBar={(props) => <FloatingTabBar {...props}');
  assertHas(layout, 'onTabBarHeight={setTabBarHeight}');
  assertHas(layout, 'onCartDockHeight={setCartDockHeight}');
  const order = [...layout.matchAll(/name="(\w+)"[\s\S]*?title: (?:t\()?'([^']+)'/g)].map((m) => [
    m[1],
    m[2],
  ]);
  // Owner 27.10.2026: exactly three tabs; the profile opens from the top header.
  assert.deepEqual(order, [
    ['menu', 'Меню'],
    ['events', 'События'],
    ['orders', 'Заказы'],
  ]);
  assert.equal(order.length, tabBarTabCount);
  assert.doesNotMatch(layout, /tab-profile|name="profile"/);
  assert.equal((layout.match(/listeners=\{gate\(/g) ?? []).length, 2);
  assert.match(layout, /name="events"\s+listeners=\{gate\('M26'\)\}/);
  assert.match(layout, /name="orders"\s+listeners=\{gate\('M19'\)\}/);
  assert.match(layout, /tabBarBadge: activeOrders > 0 \? activeOrders : undefined/);
  assert.ok(!existsSync(new URL('../../apps/mobile/src/app/(tabs)/profile.tsx', import.meta.url)));
  const bar = read('components/FloatingTabBar.tsx');
  assert.match(bar, /accessibilityRole="tablist"/);
  assert.match(bar, /accessibilityRole="tab"/);
  assert.match(bar, /accessibilityState=\{\{ selected: focused \}\}/);
  assert.match(bar, /canPreventDefault: true/, 'account gates can still stop a tab press');
  assert.match(bar, /isReduceTransparencyEnabled/);
  assert.match(bar, /prefers-reduced-transparency/);
  assert.match(bar, /if \(keyboardVisible\) return null/);
  assert.doesNotMatch(bar, /—/, 'plain hyphen in UI texts');
});

test('three tabs share the capsule evenly with room for the label at 320 and 393 pt', () => {
  // Label widths in em, measured in Chromium with Manrope 600 (12 px). Widest: kk «Тапсырыстар».
  const labels = { Меню: 2.9, События: 4.35, Заказы: 3.53, Оқиғалар: 4.58, Тапсырыстар: 6.56 };
  const widest = Math.max(...Object.values(labels));
  const room = (screen, scale) => tabItemWidth(screen, tabBarMetrics({ bottom: 34 }, scale)) - 8;
  for (const scale of [1, tabLabelMaxScale, 3.1]) {
    assert.ok(room(320, scale) + 8 >= 88, `320 pt item at scale ${scale}`);
    const regular = room(393, scale) + 8;
    assert.ok(regular >= 110 && regular <= 125, `393 pt item: ${regular}`);
  }
  const size = (scale) => tabLabelSize * Math.min(scale, tabLabelMaxScale) * widest;
  assert.ok(size(1) <= room(320, 1), 'every label fits at 320 pt with default text');
  assert.ok(size(tabLabelMaxScale) <= room(393, tabLabelMaxScale), 'largest text fits at 393 pt');
  assert.ok(
    size(tabLabelMaxScale) * tabLabelMinFit <= room(320, tabLabelMaxScale),
    'largest text at 320 pt fits after the iOS shrink-to-fit',
  );
  const bar = read('components/FloatingTabBar.tsx');
  assert.equal(tabLabelSize, 12);
  assert.match(bar, /fontSize: tabLabelSize/);
  assert.match(bar, /adjustsFontSizeToFit\s+minimumFontScale=\{tabLabelMinFit\}/);
  assert.doesNotMatch(bar, /'profile'/);
});

test('tab screens reserve the measured tab bar and the cart bar docked on it', () => {
  const host = read('ScreenHost.tsx');
  assertHas(
    host,
    'tabScreen ? tabContentInset(tabBarInset, cartDockHeight, model.cart.length) : 0',
  );
  assertHas(host, 'const inTabs = tabBarInset > 0;');
  assertHas(host, 'const tabScreen = id in tabRoutes && inTabs;');
  assert.match(read('components/UI.tsx'), /props\.inTabLayout && !editing && tabBarInset > 0/);
  // Before the first layout the formula holds; a taller measured bar wins, a shorter never.
  const metrics = tabBarMetrics({ bottom: 34 });
  assert.equal(measuredTabBarInset(metrics, 0), metrics.inset);
  assert.equal(measuredTabBarInset(metrics, null), metrics.inset);
  assert.equal(
    measuredTabBarInset(metrics, metrics.height + 15.2),
    metrics.bottom + metrics.height + 16,
  );
  assert.equal(measuredTabBarInset(metrics, metrics.height - 10), metrics.inset);
  // The cart bar's measured height while the cart has lines (the estimate until measured).
  assert.equal(tabContentInset(84, 92.4, 2), 84 + 93);
  assert.equal(tabContentInset(84, 0, 1), 84 + tabCartDockEstimate);
  assert.equal(tabContentInset(84, null, 1), 84 + tabCartDockEstimate);
  assert.equal(tabContentInset(84, 92, 0), 84);
});

test('the cart bar is docked in the tab bar layer, on top of the tab capsule (owner 28.10)', () => {
  // TestFlight 25: «быстрая оплата застревает за иконками». Each tab screen drew the bar at a
  // computed bottom in the screen layer, which lies under the tab bar. Now the tab bar draws it.
  const bar = read('components/FloatingTabBar.tsx');
  const dock = bar.indexOf('<TabCartDock');
  const capsule = bar.indexOf('testID="floating-tab-bar"');
  assert.ok(dock > 0 && capsule > dock, 'the dock is laid out above the capsule, in one column');
  assertHas(bar, "host: { position: 'absolute', left: 0, right: 0, alignItems: 'stretch' }");
  assertHas(bar, 'onLayout={(event) => onTabBarHeight?.(event.nativeEvent.layout.height)}');
  const host = read('ScreenHost.tsx');
  assert.doesNotMatch(host, /CartShortcut|bottomOffset/, 'tab screens no longer draw the bar');
  const shortcut = read('components/CartShortcut.tsx');
  assert.doesNotMatch(shortcut, /bottomOffset/);
  assertHas(shortcut, 'aboveTabBar: { paddingBottom: tabCartGap }');
  assert.equal(tabCartGap, 10);
  const docked = read('components/TabCartDock.tsx');
  assert.match(docked, /<CartShortcut[\s\S]*aboveTabBar/);
  assertHas(docked, 'pointerEvents="box-none"');
  assertHas(docked, "pathname: '/cart'");
  // Under a sheet (cart, sign-in, order status) the bar is not drawn, as before; its last height
  // stays so the content below does not jump.
  assertHas(docked, 'const focused = useIsFocused();');
  assertHas(docked, 'if (focused) onHeightChange');
  // «In the tab layout» means rendered inside it, not «a tab is focused»: with a sheet open over
  // a tab, the menu below drew a second, standalone bar under the tab bar (before 28.10).
  assertHas(host, 'inTabLayout={inTabs}');
  assert.ok(!squash(host).includes(squash("segments[0] === '(tabs)'")));
  // The standalone menu (outside the tabs) keeps its own floating bar.
  assertHas(read('screens/CatalogScreens.tsx'), '!props.inTabLayout ? <CartShortcut');
});

test('coming back to the docked bar is not «an item was added» (tech lead 28.10)', () => {
  // The bar unmounts under a sheet and under the keyboard; the count it last showed is kept by
  // the tab bar, which outlives it, so a remount without a new item does not replay the feedback.
  const bar = read('components/FloatingTabBar.tsx');
  assertHas(bar, 'const seenCartCount = useRef(0);');
  assertHas(bar, 'seenCount={seenCartCount}');
  assert.ok(
    before(bar, 'const seenCartCount = useRef(0);', 'if (keyboardVisible) return null'),
    'a hook before the early return',
  );
  assertHas(read('components/TabCartDock.tsx'), 'seenCount={seenCount}');
  const shortcut = read('components/CartShortcut.tsx');
  assertHas(shortcut, 'const previousCount = seenCount ?? ownSeenCount;');
  assertHas(shortcut, 'const added = count > previousCount.current;');
  assertHas(shortcut, 'previousCount.current = count;');
});
