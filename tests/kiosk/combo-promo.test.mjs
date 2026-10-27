import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { LOCALES, copy } from '../../apps/kiosk/src/i18n.ts';

// Owner decision 27.10.2026: «Купи 6 комбо, 7-е в подарок» (was 7 + 1).
const src = new URL('../../apps/kiosk/src/', import.meta.url);

test('kiosk promo copy says six paid combos and the seventh as a gift in every locale', () => {
  const expected = {
    ru: ['Купи 6 комбо -', '7-е в подарок'],
    kk: ['6 комбо алыңыз -', '7-сі сыйлық'],
    en: ['Buy 6 combos -', 'get the 7th free'],
  };
  for (const locale of LOCALES) {
    const { p7Title, p7Gift } = copy(locale);
    assert.deepEqual([p7Title, p7Gift], expected[locale], locale);
    assert.doesNotMatch(`${p7Title} ${p7Gift}`, /\b7 (комбо|combos)|8/, locale);
  }
});

test('the 7 + 1 billboard artwork stays unwired until it is redrawn for 6 + 1', () => {
  // billboard-7plus1.webp is drawn with seven checks and a gift. It may stay in the bundle
  // registry, but no screen may show it before a 6 + 1 version replaces the file.
  const users = [];
  for (const entry of readdirSync(src, { recursive: true })) {
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    const text = readFileSync(new URL(entry, src), 'utf8');
    if (/billboardPromo|billboard-7plus1/.test(text)) users.push(entry);
  }
  assert.deepEqual(users, ['assets.ts']);
  const registry = readFileSync(new URL('assets.ts', src), 'utf8');
  assert.match(registry, /redraw[^\n]*6 \+ 1[^\n]*\n[^\n]*billboardPromo/i);
});
