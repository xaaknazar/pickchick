// Android UX (lane android, 05.11.2026): hardware Back on every layer, haptics, keyboard,
// native dialog labels and Android shadows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBackLayers } from '../../apps/mobile/src/back-layers.ts';
import { keyboardAvoidingBehavior } from '../../apps/mobile/src/keyboard-avoidance.ts';
import { ANDROID_FEEDBACK, IMPACT_STYLE } from '../../apps/mobile/src/haptic-map.ts';

const appRoot = fileURLToPath(new URL('../../apps/mobile/', import.meta.url));
const src = `${appRoot}src/`;
const read = (path) => readFileSync(`${src}${path}`, 'utf8');

function sourceFiles(directory = src) {
  return readdirSync(directory).flatMap((name) => {
    const path = `${directory}${name}`;
    if (statSync(path).isDirectory()) return sourceFiles(`${path}/`);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test('back layers: newest first, the sheet closes only when no layer takes Back', () => {
  const layers = createBackLayers();
  const calls = [];
  assert.equal(layers.dispatch(), false);
  const removeOuter = layers.add(() => {
    calls.push('outer');
    return true;
  });
  let innerTakes = true;
  const removeInner = layers.add(() => {
    calls.push('inner');
    return innerTakes;
  });
  assert.equal(layers.dispatch(), true);
  assert.deepEqual(calls, ['inner']);
  innerTakes = false;
  assert.equal(layers.dispatch(), true);
  assert.deepEqual(calls, ['inner', 'inner', 'outer']);
  removeInner();
  removeInner();
  assert.equal(layers.size, 1);
  removeOuter();
  assert.equal(layers.dispatch(), false);
  // A layer that removes itself while handling Back (the overlay closes) does not skip another.
  const order = [];
  let removeSelf = () => {};
  layers.add(() => {
    order.push('below');
    return false;
  });
  removeSelf = layers.add(() => {
    order.push('top');
    removeSelf();
    return false;
  });
  assert.equal(layers.dispatch(), false);
  assert.deepEqual(order, ['top', 'below']);
});

test('Back inside sheets: payment X with its confirmation, overlays, OTP step, locked sheet', () => {
  const sheet = read('components/OrderSheet.tsx');
  assert.match(sheet, /if \(!layers\.dispatch\(\)\) close\(\);\s*return true;/);
  assert.match(
    sheet,
    /if \(Platform\.OS !== 'android' \|\| !focused\) return;\s*const sub = BackHandler\.addEventListener\('hardwareBackPress', back\)/,
  );
  // Web Escape keeps its tested behaviour (browser_kaspi_checkout: a locked sheet stays).
  assert.match(sheet, /event\.key === 'Escape'\) \{\s*event\.preventDefault\(\);\s*close\(\);/);
  assert.match(sheet, /<SheetBackContext\.Provider value=\{layers\.add\}>/);
  // Outside a sheet (the payment screen in «Заказы») Back is heard only on the focused screen.
  assert.match(sheet, /if \(Platform\.OS !== 'android' \|\| !focused\) return;/);
  const payment = read('components/KaspiPaymentState.tsx');
  assert.match(
    payment,
    /useSheetBack\(\(\) => \{\s*requestDismiss\(\);\s*return true;\s*\}, dismissible && !confirming\);/,
  );
  // requestDismiss is the X: the confirmation while the bank may act, never a direct close.
  assert.match(
    payment,
    /if \(dismissNeedsConfirm\?\.\(\)\) setConfirming\(true\);\s*else onDismiss\(\);/,
  );
  assert.match(read('app/auth.tsx'), /<SheetBackLayer onBack=\{\(\) => setAuxiliary\(null\)\} \/>/);
  assert.match(
    read('components/AuthLayout.tsx'),
    /<SheetBackLayer onBack=\{topAction\?\.onPress \?\? props\.goBack\} \/>/,
  );
});

test('every route a customer opens over the app handles hardware Back', () => {
  const layout = read('app/_layout.tsx');
  const screens = [
    ...layout.matchAll(/<Stack\.Screen\s+name="([^"]+)"\s+options=\{([\s\S]*?)\}\s*\/>/g),
  ];
  const arcade = screens.filter(([, , options]) => options.includes('ARCADE_SCREEN_OPTIONS'));
  assert.deepEqual(
    arcade.map(([, name]) => name),
    ['games/pick-blocks', 'games/pick-man', 'games/magic-sort', 'games/pick-farm'],
  );
  assert.match(read('games/route-options.ts'), /presentation: 'fullScreenModal'/);
  for (const [, name] of arcade) {
    const route = read(`app/${name}.tsx`);
    const imported = [...route.matchAll(/from '\.\.\/\.\.\/(games\/[^']+Screen)'/g)].map(
      (m) => m[1],
    );
    assert.equal(imported.length, 1, name);
    const handled = [route, ...imported.map((path) => read(`${path}.tsx`))].some((code) =>
      /BackHandler\.addEventListener\(\s*'hardwareBackPress'/.test(code),
    );
    assert.ok(handled, `${name}: a fullScreenModal game handles hardwareBackPress`);
  }
  const transparent = [
    ...layout.matchAll(/name="([^"]+)"\s+options=\{\{\s*presentation: 'transparentModal'/g),
  ].map((m) => m[1]);
  assert.deepEqual(transparent.sort(), ['auth', 'cart', 'checkout', 'order-status']);
  const host = read('ScreenHost.tsx');
  assert.match(host, /const inSheet = id === 'M09' \|\| id === 'M12' \|\| statusSheet;/);
  assert.match(host, /if \(inSheet\)[\s\S]*?<OrderSheet/);
  for (const name of transparent) {
    const route = read(`app/${name}.tsx`);
    assert.ok(/<OrderSheet\b/.test(route) || /<ScreenHost\b/.test(route), name);
  }
});

test('every React Native Modal answers Android Back; the deletion dialog not while deleting', () => {
  const missing = [];
  for (const file of sourceFiles()) {
    if (file.endsWith('components/Motion.tsx')) continue;
    const code = readFileSync(file, 'utf8');
    for (const match of code.matchAll(/<(Modal|MotionModal)\b/g)) {
      const line = code.slice(code.lastIndexOf('\n', match.index) + 1, match.index).trim();
      if (/^(\*|\/\/|\/\*)/.test(line)) continue; // A comment names it.
      let depth = 0;
      let end = match.index;
      for (; end < code.length; end += 1) {
        if (code[end] === '{') depth += 1;
        else if (code[end] === '}') depth -= 1;
        else if (code[end] === '>' && depth === 0) break;
      }
      if (!code.slice(match.index, end).includes('onRequestClose'))
        missing.push(`${file.slice(src.length)}:${code.slice(0, match.index).split('\n').length}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.match(
    read('screens/ProfileScreens.tsx'),
    /onRequestClose=\{\(\) => \{\s*if \(!demo\.busy\) setDeleteConfirmVisible\(false\);\s*\}\}/,
  );
});

test('native dialogs get translated button labels', () => {
  const picker = read('components/BirthDatePicker.tsx');
  assert.match(picker, /positiveButton: \{ label: t\('Готово'\) \}/);
  assert.match(picker, /negativeButton: \{ label: t\('Отмена'\) \}/);
  // The system draws these buttons with the text as given: a Russian literal stays Russian in the
  // Kazakh and English app.
  const cyrillicLiteral = /(?:text|label): '[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]/u;
  for (const file of sourceFiles()) {
    const code = readFileSync(file, 'utf8');
    for (const call of code.matchAll(/(?:Alert\.alert|DateTimePickerAndroid\.open)\(/g)) {
      const body = code.slice(call.index, code.indexOf(');', call.index));
      assert.doesNotMatch(body, cyrillicLiteral, file.slice(src.length));
    }
  }
});

test('keyboard: forms pad above the keyboard on Android too (edge-to-edge)', () => {
  assert.equal(keyboardAvoidingBehavior('ios'), 'padding');
  assert.equal(keyboardAvoidingBehavior('android'), 'padding');
  assert.equal(keyboardAvoidingBehavior('web'), undefined);
  for (const path of ['components/AuthLayout.tsx', 'components/UI.tsx']) {
    const code = read(path);
    assert.match(code, /behavior=\{keyboardAvoidingBehavior\(Platform\.OS\)\}/, path);
  }
  for (const file of sourceFiles())
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /Platform\.OS === 'ios' \? 'padding' : undefined/,
      file,
    );
});

test('haptics: Android keeps the heavy impact for grab/armed, system slider ticks with fallbacks', () => {
  const types = readFileSync(
    `${appRoot}node_modules/expo-haptics/build/Haptics.types.d.ts`,
    'utf8',
  );
  const android = new Set(
    [...types.split('export declare enum AndroidHaptics')[1].matchAll(/= "([a-z-]+)"/g)].map(
      (m) => m[1],
    ),
  );
  // Available on every Android version expo-haptics supports (HapticsRecord.kt fallbacks).
  const everyVersion = new Set([
    'clock-tick',
    'context-click',
    'keyboard-tap',
    'long-press',
    'virtual-key',
  ]);
  // Owner: firmer feedback. The pick-up and the point where letting go pays keep the 60 ms
  // heavy pulse (system DRAG_START / CONFIRM are often weaker, tech-lead review 05.11.2026).
  assert.deepEqual(ANDROID_FEEDBACK.grab, { kind: 'impact', style: 'heavy' });
  assert.deepEqual(ANDROID_FEEDBACK.armed, { kind: 'impact', style: 'heavy' });
  // A tick every sixteenth of the track: the short system slider constant, not a vibrator buzz.
  const tick = ANDROID_FEEDBACK.tick;
  assert.equal(tick.kind, 'system');
  assert.ok(tick.types.length >= 2);
  for (const type of tick.types) assert.ok(android.has(type), `tick: ${type}`);
  assert.ok(everyVersion.has(tick.types.at(-1)), 'tick ends with an all-API constant');
  const impacts = readFileSync(
    `${appRoot}node_modules/expo-haptics/build/Haptics.types.d.ts`,
    'utf8',
  ).split('export declare enum ImpactFeedbackStyle')[1];
  for (const style of new Set(Object.values(IMPACT_STYLE)))
    assert.match(impacts, new RegExp(`= "${style}"`), style);
  assert.deepEqual(IMPACT_STYLE, { grab: 'heavy', tick: 'medium', armed: 'heavy' });
  const code = read('haptics.ts');
  assert.match(code, /performAndroidHapticsAsync/);
  assert.match(
    code,
    /if \(feedback\.kind === 'impact'\) \{\s*await Haptics\.impactAsync\(feedback\.style/,
  );
  assert.match(code, /Platform\.OS === 'android'\s*\? androidFeedback\(cue\)/);
});

test('Android has a shadow wherever iOS draws one; 2GIS keeps its web fallback', () => {
  for (const file of sourceFiles()) {
    if (file.includes('/games/pick-farm/')) continue; // Off in the store builds.
    const code = readFileSync(file, 'utf8');
    for (const match of code.matchAll(/\n {2}(\w+): \{\n([\s\S]*?)\n {2}\},/g)) {
      const body = match[2];
      if (!/shadowOpacity: 0?\.\d*[1-9]/.test(body)) continue;
      assert.ok(
        /elevation:|boxShadow/.test(body),
        `${file.slice(src.length)} ${match[1]}: iOS shadow without an Android counterpart`,
      );
    }
  }
  const restaurants = read('components/Restaurants.tsx');
  assert.match(restaurants, /if \(await Linking\.canOpenURL\(app\)\)/);
  assert.match(restaurants, /await Linking\.openURL\(mapUrl\);\s*\}/);
});
