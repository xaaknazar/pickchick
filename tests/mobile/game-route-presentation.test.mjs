import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ARCADE_SCREEN_OPTIONS } from '../../apps/mobile/src/games/route-options.ts';

const read = (path) =>
  readFileSync(new URL(`../../apps/mobile/src/${path}`, import.meta.url), 'utf8');
const mobileRequire = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const games = readdirSync(new URL('../../apps/mobile/src/app/games/', import.meta.url))
  .filter((name) => name.endsWith('.tsx') && !name.startsWith('_'))
  .map((name) => `games/${name.slice(0, -4)}`);
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
      { options: games.includes(name) ? gameOptions : (ROOT_OPTIONS[name] ?? {}) },
    ]),
  );
  const modal = getModalRouteKeys(routes, descriptors);
  const game = names.at(-1);
  const presentation =
    descriptors[game].options.presentation ?? (modal.includes(game) ? 'modal' : 'card');
  return presentation === 'card' ? 'push' : presentation;
}

const fromEvents = (game, options) => nativePresentation(['(tabs)', game], options);
const fromOrder = (game, sheet, options) => nativePresentation(['(tabs)', sheet, game], options);

test('the old options gave the order sheet a different, swipe-dismiss container', () => {
  const old = { headerShown: false, gestureEnabled: false };
  assert.equal(fromEvents('games/pick-man', old), 'push');
  assert.equal(fromOrder('games/pick-man', 'order-status', old), 'modal');
});

for (const game of games) {
  test(`${game} uses a fixed full-screen container from Events, checkout and order status`, () => {
    // The root declaration matters: screen-local options arrive after native presentation.
    assert.ok(
      read('app/_layout.tsx').includes(
        `<Stack.Screen name="${game}" options={ARCADE_SCREEN_OPTIONS} />`,
      ),
      `${game} must declare its container before mounting`,
    );
    assert.doesNotMatch(read(`app/${game}.tsx`), /presentation/);
    const events = fromEvents(game, ARCADE_SCREEN_OPTIONS);
    for (const sheet of ['order-status', 'checkout']) {
      assert.equal(fromOrder(game, sheet, ARCADE_SCREEN_OPTIONS), events, sheet);
    }
    // iOS sheets own a vertical dismiss pan; a push after a modal sits underneath it.
    assert.equal(events, 'fullScreenModal');
    assert.equal(ARCADE_SCREEN_OPTIONS.gestureEnabled, false);
  });
}
