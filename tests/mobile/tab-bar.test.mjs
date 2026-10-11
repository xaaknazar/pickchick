import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  tabBarMetrics,
  tabBarPalette,
  tabLabelMaxScale,
} from '../../apps/mobile/src/tab-bar-metrics.ts';

const read = (path) =>
  readFileSync(new URL(`../../apps/mobile/src/${path}`, import.meta.url), 'utf8');

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
  assert.match(layout, /tabBar=\{\(props\) => <FloatingTabBar \{\.\.\.props\} \/>\}/);
  const order = [...layout.matchAll(/name="(\w+)"[\s\S]*?title: '([^']+)'/g)].map((m) => [
    m[1],
    m[2],
  ]);
  assert.deepEqual(order, [
    ['menu', 'Меню'],
    ['events', 'События'],
    ['orders', 'Заказы'],
    ['profile', 'Профиль'],
  ]);
  assert.equal((layout.match(/listeners=\{gate\(/g) ?? []).length, 3);
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

test('tab screens and the cart dock reserve the floating bar height', () => {
  const host = read('ScreenHost.tsx');
  assert.match(host, /activeTab \? tabBarInset \+ \(model\.cart\.length \? cartHeight : 0\) : 0/);
  assert.match(host, /bottomOffset=\{tabBarInset\}/);
  assert.match(read('components/UI.tsx'), /props\.inTabLayout && !editing && tabBarInset > 0/);
});
