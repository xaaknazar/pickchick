import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  LIQUID_GLASS_MIN_IOS,
  glass,
  glassBarBody,
  glassLayers,
  glassSurface,
  iosMajorVersion,
  liquidGlassConfig,
} from '../../apps/mobile/src/glass.ts';

// Owner 28.10.2026: «эти стеклянные иконки - это стиль Apple, нужно как у них делать в точности».
// iOS 26+ draws Apple's own Liquid Glass; everything else keeps a fallback that must stay legible.

const SRC = new URL('../../apps/mobile/src/', import.meta.url);
const source = (file) => readFileSync(new URL(file, SRC), 'utf8');
const sources = () =>
  readdirSync(SRC, { recursive: true })
    .map((file) => String(file).replaceAll('\\', '/'))
    .filter((file) => /\.tsx?$/.test(file));

const env = (overrides = {}) => ({
  platform: 'ios',
  osVersion: '26.0',
  liquidGlass: true,
  nativeBlur: true,
  reducedTransparency: false,
  ...overrides,
});

test('Apple Liquid Glass only on iOS 26+ with the module and the API in the binary', () => {
  assert.equal(LIQUID_GLASS_MIN_IOS, 26);
  assert.equal(glassSurface(env()), 'liquid');
  assert.equal(glassSurface(env({ osVersion: '26.1.2' })), 'liquid');
  assert.equal(glassSurface(env({ osVersion: 27 })), 'liquid');
  // Older iOS: the expo-blur fallback, or the tint when the binary has no blur module.
  assert.equal(glassSurface(env({ osVersion: '25.9' })), 'blur');
  assert.equal(glassSurface(env({ osVersion: '18.6' })), 'blur');
  assert.equal(glassSurface(env({ osVersion: '18.6', nativeBlur: false })), 'tint');
  // iOS 26 but the binary predates expo-glass-effect, was built with an older SDK, opts out of
  // the new design, or the runtime API is missing (iOS 26 betas): never GlassView.
  assert.equal(glassSurface(env({ liquidGlass: false })), 'blur');
  assert.equal(glassSurface(env({ liquidGlass: false, nativeBlur: false })), 'tint');
  // An unknown version is not trusted with Liquid Glass.
  assert.equal(glassSurface(env({ osVersion: undefined })), 'blur');
  assert.equal(glassSurface(env({ osVersion: '' })), 'blur');
});

test('web and Android never take the native glass, whatever the flags say', () => {
  assert.equal(glassSurface(env({ platform: 'web', osVersion: '' })), 'blur');
  assert.equal(
    glassSurface(env({ platform: 'web', liquidGlass: false, nativeBlur: false })),
    'blur',
  );
  assert.equal(glassSurface(env({ platform: 'android', osVersion: 36 })), 'tint');
  assert.equal(glassSurface(env({ platform: 'android', liquidGlass: false })), 'tint');
});

test('reduced transparency always gets the opaque fallback, also on iOS 26', () => {
  for (const platform of ['ios', 'android', 'web'])
    for (const liquidGlass of [true, false])
      for (const nativeBlur of [true, false])
        assert.equal(
          glassSurface(env({ platform, liquidGlass, nativeBlur, reducedTransparency: true })),
          'solid',
          `${platform} liquid=${liquidGlass} blur=${nativeBlur}`,
        );
});

test('iOS major version parsing', () => {
  assert.equal(iosMajorVersion('26.0'), 26);
  assert.equal(iosMajorVersion('26.0.1'), 26);
  assert.equal(iosMajorVersion(' 18.6 '), 18);
  assert.equal(iosMajorVersion(26), 26);
  assert.equal(iosMajorVersion(26.4), 26);
  assert.equal(iosMajorVersion(''), 0);
  assert.equal(iosMajorVersion(undefined), 0);
  assert.equal(iosMajorVersion('beta'), 0);
  assert.equal(iosMajorVersion(Number.NaN), 0);
});

test('regular dark glass everywhere; interactive only where the customer presses', () => {
  for (const place of ['button', 'header', 'pill', 'bar']) {
    const config = liquidGlassConfig(place);
    assert.equal(config.glassEffectStyle, 'regular', place);
    assert.equal(config.colorScheme, 'dark', place);
    // No tint: the red trash is a red glyph on neutral glass (Apple: tint only a primary action).
    assert.equal('tintColor' in config, false, place);
  }
  assert.equal(liquidGlassConfig('button').isInteractive, true);
  assert.equal(liquidGlassConfig('header').isInteractive, true);
  // The pay handle stretches under the finger (owner 6a); the capsule holds the dragged handle.
  assert.equal(liquidGlassConfig('pill').isInteractive, false);
  assert.equal(liquidGlassConfig('bar').isInteractive, false);
});

test('Liquid Glass draws none of our imitation; each fallback has its own body', () => {
  const liquid = glassLayers('liquid');
  assert.deepEqual(liquid, {
    blur: false,
    fill: null,
    lift: false,
    highlights: false,
    rim: 'transparent',
    pressFeedback: false,
  });
  const blur = glassLayers('blur');
  assert.equal(blur.blur, true);
  assert.equal(blur.fill, glass.veil);
  assert.ok(blur.highlights && blur.lift && blur.pressFeedback);
  const tint = glassLayers('tint');
  assert.equal(tint.blur, false);
  assert.equal(tint.fill, glass.fallback);
  const solid = glassLayers('solid');
  assert.equal(solid.blur, false);
  assert.equal(alpha(solid.fill), 1, 'reduced transparency: opaque');
  assert.equal(solid.lift, false);
  for (const surface of ['blur', 'tint', 'solid'])
    assert.equal(glassLayers(surface).rim, glass.rim);
});

// --- Colour maths (WCAG 2.1) -------------------------------------------------------------------

function rgba(value) {
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(1);
  }
  const parts = value
    .match(/rgba?\(([^)]+)\)/)[1]
    .split(',')
    .map(Number);
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}
function alpha(value) {
  return rgba(value)[3];
}
function over(top, bottom) {
  const [r, g, b, a] = typeof top === 'string' ? rgba(top) : top;
  return [r * a + bottom[0] * (1 - a), g * a + bottom[1] * (1 - a), b * a + bottom[2] * (1 - a)];
}
function luminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
// The sheen's white at the glyph's centre (50 %), interpolated between its gradient stops.
function sheenAt(percent) {
  const stops = [...glass.sheen.matchAll(/rgba\(255,255,255,([\d.]+)\) (\d+)%/g)].map((m) => [
    Number(m[2]),
    Number(m[1]),
  ]);
  for (let i = 1; i < stops.length; i++) {
    const [p0, a0] = stops[i - 1];
    const [p1, a1] = stops[i];
    if (percent <= p1) return a0 + ((a1 - a0) * (percent - p0)) / (p1 - p0);
  }
  return stops.at(-1)[1];
}
// The dark tint of the blur at `glass.blurIntensity`, on both platforms that draw the blur:
// - web: expo-blur's getBackgroundColor, rgba(25,25,25, intensity/100 * 0.78);
// - iOS < 26: expo-blur runs UIBlurEffect `.dark` to fractionComplete = intensity/100 on a linear
//   UIViewPropertyAnimator; `.dark` tints with white 0.11 at alpha 0.73 (UIKit's private values,
//   as reverse engineered, so an approximation: one look on an iPhone with iOS 18 is still due).
//   It tints less than the web at the same strength, so the glyph has less contrast there.
const blurTints = {
  web: [25, 25, 25, (glass.blurIntensity / 100) * 0.78],
  ios: [0.11 * 255, 0.11 * 255, 0.11 * 255, (glass.blurIntensity / 100) * 0.73],
};
const white = [255, 255, 255];
const background = rgba('#04143A').slice(0, 3);

function fallbackGlass(surface, behind, blurTint = blurTints.web) {
  const layers = glassLayers(surface);
  let color = behind;
  if (layers.blur) color = over(blurTint, color);
  color = over(layers.fill, color);
  if (layers.lift) color = over(glass.lift, color);
  return over([255, 255, 255, sheenAt(50)], color);
}

test('the fallback glyph keeps 3:1 over a white backdrop (the brightest hero frame)', () => {
  for (const [platform, tint] of Object.entries(blurTints)) {
    for (const surface of ['blur', 'tint', 'solid']) {
      const behindGlyph = fallbackGlass(surface, white, tint);
      const ratio = contrast(rgba(glass.icon), behindGlyph);
      assert.ok(ratio >= 3, `${platform} ${surface}: white glyph ${ratio.toFixed(2)}:1`);
    }
    // The red trash keeps 3:1 on the glass over the dark sheet.
    for (const surface of ['blur', 'tint', 'solid']) {
      const ratio = contrast(rgba(glass.danger), fallbackGlass(surface, background, tint));
      assert.ok(ratio >= 3, `${platform} ${surface}: red trash ${ratio.toFixed(2)}:1`);
    }
  }
  // The native dark blur is the weaker case: 46 (before the 28.10 review) fell below 3:1 there.
  const at = (intensity) =>
    contrast(white, fallbackGlass('blur', white, [28.05, 28.05, 28.05, (intensity / 100) * 0.73]));
  assert.ok(at(46) < 3);
  assert.ok(at(glass.blurIntensity) >= 3);
  assert.ok(
    contrast(white, fallbackGlass('blur', white, blurTints.ios)) <
      contrast(white, fallbackGlass('blur', white, blurTints.web)),
  );
});

test('closer to Liquid Glass: thinner veil, lighter rim, lifted over the dark background', () => {
  assert.ok(alpha(glass.veil) < 0.34, 'thinner veil than the 27.10 navy 0.34');
  assert.ok(alpha(glass.rim) > 0.22, 'lighter rim than 27.10');
  assert.match(glass.specular, /inset/);
  // Dark Liquid Glass reads a little lighter than the dark content under it.
  assert.ok(luminance(fallbackGlass('blur', background)) > luminance(background));
});

test('the cart bar capsule: Apple glass on iOS 26, a readable total everywhere else', () => {
  assert.deepEqual(glassBarBody('liquid', false), {
    fill: 'transparent',
    backdrop: null,
    rim: 'transparent',
  });
  const web = glassBarBody('blur', true);
  assert.match(web.backdrop, /blur\(\d+px\)/);
  assert.ok(alpha(web.fill) < 0.94, 'the web capsule shows more of the menu behind it');
  // The white total keeps AA (4.5:1) over a white photo under the blur.
  assert.ok(contrast(white, over(web.fill, white)) >= 4.5);
  // Natively without Liquid Glass nothing blurs behind the capsule: the dense navy stays.
  for (const surface of ['blur', 'tint']) {
    const native = glassBarBody(surface, false);
    assert.equal(native.backdrop, null);
    assert.equal(native.fill, glass.bar.fallback);
  }
  assert.equal(alpha(glassBarBody('solid', true).fill), 1);
  assert.equal(glassBarBody('solid', true).backdrop, null);
});

test('expo-glass-effect is pinned to the SDK 57 version and guarded in old binaries', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../apps/mobile/package.json', import.meta.url), 'utf8'),
  );
  const version = pkg.dependencies['expo-glass-effect'];
  assert.match(version, /^57\.\d+\.\d+$/, 'exact pin like expo-blur');
  assert.equal(version.split('.')[0], pkg.dependencies.expo.split('.')[0]);
  // A binary without the module (or iOS 26 betas without the API) must never reach GlassView.
  const hook = source('components/useGlassSurface.ts');
  assert.match(hook, /requireOptionalNativeModule\('ExpoGlassEffect'\) == null\) return false/);
  assert.match(hook, /isLiquidGlassAvailable\(\) && isGlassEffectAPIAvailable\(\)/);
  const button = source('components/GlassButton.tsx');
  // GlassView is rendered only inside a `liquid` branch: each one follows a `surface ===
  // 'liquid'` check in the same function (GlassFill, GlassButton), whatever their number.
  const views = [...button.matchAll(/<GlassView\b/g)].map((match) => match.index);
  assert.ok(views.length >= 1);
  for (const at of views) {
    const before = button.slice(0, at);
    const check = before.lastIndexOf("surface === 'liquid'");
    assert.ok(check > 0, `GlassView at ${at} without a liquid check`);
    assert.doesNotMatch(before.slice(check), /\nexport function /, `GlassView at ${at}`);
  }
  // Only the glass layer imports the native module; screens use GlassButton / GlassFill.
  for (const file of sources())
    if (/from 'expo-glass-effect'/.test(source(file)))
      assert.ok(
        ['components/GlassButton.tsx', 'components/useGlassSurface.ts'].includes(file),
        file,
      );
});
