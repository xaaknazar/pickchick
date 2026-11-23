import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Owner 23.11.2026: «Как в системе» (default), «Светлая», «Тёмная», «Синяя».
const src = new URL('../../apps/mobile/src/', import.meta.url);
const tokens = readFileSync(
  new URL('../../packages/design-tokens/tokens.json', import.meta.url),
  'utf8',
);
const dir = mkdtempSync(join(tmpdir(), 'pc-theme-'));
writeFileSync(
  join(dir, 'theme.ts'),
  readFileSync(new URL('theme.ts', src), 'utf8')
    .replace(/^import tokens from .*$/m, `const tokens = ${tokens};`)
    .replace("from './tab-bar-metrics'", `from '${new URL('tab-bar-metrics.ts', src).href}'`),
);
const theme = await import(pathToFileURL(join(dir, 'theme.ts')).href);
const { tabBarPalette } = await import(new URL('tab-bar-metrics.ts', src).href);

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('system follows the phone; the navy look is only chosen by hand', () => {
  assert.equal(theme.resolveTheme('system', 'light'), 'light');
  assert.equal(theme.resolveTheme('system', 'dark'), 'dark');
  assert.equal(theme.resolveTheme('system', null), 'dark');
  assert.equal(theme.resolveTheme('blue', 'light'), 'blue');
  assert.deepEqual([...theme.THEME_PREFERENCES], ['system', 'light', 'dark', 'blue']);
});

test('approved backgrounds: light #E4EDFB, dark #0A1020, blue the original navy', () => {
  assert.equal(theme.palettes.light.background, '#E4EDFB');
  assert.equal(theme.palettes.dark.background, '#0A1020');
  assert.equal(theme.palettes.blue.background, '#04143A');
});

test('text keeps 4.5:1 on page and cards in every theme', () => {
  for (const name of ['light', 'dark', 'blue']) {
    const p = theme.palettes[name];
    for (const surface of [p.background, p.surface, p.raised])
      for (const ink of [p.text, p.muted, p.white])
        assert.ok(contrast(ink, surface) >= 4.5, `${name}: ${ink} on ${surface}`);
    assert.ok(contrast(p.accentText, p.surface) >= 4.5, `${name}: accent text`);
  }
});

test('applyTheme switches the palette, literal colours and the tab bar in place', () => {
  theme.applyTheme('light');
  assert.equal(theme.colors.background, '#E4EDFB');
  assert.equal(theme.tc('#0A1020'), '#E4EDFB');
  assert.equal(theme.tc('#141B2B'), '#FFFFFF');
  assert.equal(theme.tc('#FF6900'), '#FF6900', 'brand orange stays');
  assert.equal(theme.tc('#000000AA'), '#000000AA', 'black scrims stay');
  assert.match(
    theme.tc('linear-gradient(180deg, rgba(10,16,32,0) 0%, #0A1020 100%)'),
    /rgba\(228,237,251,0\).*#E4EDFB/,
  );
  assert.equal(tabBarPalette.active, '#B84800');
  const styles = theme.themed(() => ({ page: { backgroundColor: theme.colors.background } }));
  assert.equal(styles.page.backgroundColor, '#E4EDFB');
  theme.applyTheme('blue');
  assert.equal(styles.page.backgroundColor, '#04143A');
  assert.equal(theme.tc('#141B2B'), '#0B2255');
  assert.equal(tabBarPalette.active, '#FF8A3D');
  theme.applyTheme('dark');
  assert.equal(styles.page.backgroundColor, '#0A1020');
  assert.equal(theme.tc('#A3B4D6'), '#A3B4D6', 'dark is the look the screens were drawn in');
});

test('light tab bar labels stay readable on the light glass', () => {
  theme.applyTheme('light');
  assert.ok(contrast(tabBarPalette.active, '#F6F9FF') >= 4.5);
  assert.ok(contrast(tabBarPalette.inactive, '#F6F9FF') >= 4.5);
  theme.applyTheme('dark');
});
