import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Owner report 2026-10-12: События went blank after quick Меню <-> События switches.
// expo-router 57's bottom-tab view derives a hidden tab's react-native-screens activityState
// from a native-driven Animated interpolation whenever the tab animation is not 'none'. On iOS
// the native driver can write "detached" after React re-focused the tab, so the page stays
// blank (expo/expo#49681, react-navigation#12755, fixed upstream in bottom-tabs 7.18.8 but not
// in expo-router's fork). We switch tabs without an animation; a fade may only come back
// together with a navigator that no longer derives the detach state from the animation.
const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const tabView = readFileSync(
  require.resolve('expo-router/build/react-navigation/bottom-tabs/views/BottomTabView.js'),
  'utf8',
);
const layout = readFileSync(
  new URL('../../apps/mobile/src/app/(tabs)/_layout.tsx', import.meta.url),
  'utf8',
);

test('tabs never derive their attach state from a running animation', () => {
  const animation = layout.match(/^\s*animation:\s*(.+),$/m)?.[1];
  assert.ok(animation, 'tab screenOptions must set animation explicitly');
  const derivesFromAnimation = /inputRange:\s*\[0,\s*1 - EPSILON,\s*1\]/.test(tabView);
  if (derivesFromAnimation) assert.equal(animation, "'none'");
});
