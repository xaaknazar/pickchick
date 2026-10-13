import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ARCADE_SCREEN_OPTIONS } from '../../apps/mobile/src/games/route-options.ts';

const read = (path) =>
  readFileSync(new URL(`../../apps/mobile/src/${path}`, import.meta.url), 'utf8');
const mobileRequire = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
// The same helper expo-router's native stack uses to decide which routes are modal.
const { getModalRouteKeys } = mobileRequire(
  'expo-router/build/react-navigation/native-stack/utils/getModalRoutesKeys.js',
);

const ROOT_OPTIONS = {
  'order-status': { presentation: 'transparentModal' },
  checkout: { presentation: 'transparentModal' },
};

/** Mirrors NativeStackView.native SceneView: an unset presentation after any modal is `modal`. */
function nativePresentation(names, gameOptions) {
  const routes = names.map((name) => ({ key: name, name }));
  const descriptors = Object.fromEntries(
    names.map((name) => [
      name,
      { options: name === 'games/pick-blocks' ? gameOptions : (ROOT_OPTIONS[name] ?? {}) },
    ]),
  );
  const modal = getModalRouteKeys(routes, descriptors);
  const game = names.at(-1);
  const presentation =
    descriptors[game].options.presentation ?? (modal.includes(game) ? 'modal' : 'card');
  return presentation === 'card' ? 'push' : presentation;
}

const fromEvents = (options) => nativePresentation(['(tabs)', 'games/pick-blocks'], options);
const fromOrder = (sheet, options) =>
  nativePresentation(['(tabs)', sheet, 'games/pick-blocks'], options);

test('the old options gave the order sheet a different, swipe-dismiss container', () => {
  const old = { headerShown: false, gestureEnabled: false };
  assert.equal(fromEvents(old), 'push');
  assert.equal(fromOrder('order-status', old), 'modal');
});

test('Pick Blocks opens in one full-screen container from Events and from an order sheet', () => {
  const events = fromEvents(ARCADE_SCREEN_OPTIONS);
  for (const sheet of ['order-status', 'checkout']) {
    assert.equal(fromOrder(sheet, ARCADE_SCREEN_OPTIONS), events, sheet);
  }
  // iOS sheets own a vertical dismiss pan; a push after a modal is placed underneath it.
  assert.equal(events, 'fullScreenModal');
  assert.equal(ARCADE_SCREEN_OPTIONS.gestureEnabled, false);
});

test('the presentation is declared in the root stack, before the game mounts', () => {
  assert.match(
    read('app/_layout.tsx'),
    /<Stack\.Screen name="games\/pick-blocks" options=\{ARCADE_SCREEN_OPTIONS\} \/>/,
  );
  assert.doesNotMatch(read('app/games/pick-blocks.tsx'), /presentation/);
});
