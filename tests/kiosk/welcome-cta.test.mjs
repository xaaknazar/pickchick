// Kiosk build 14, owner decision 2026-10-11: the attract CTA caption takes turns KZ -> RU -> EN
// (2.4 s each, 7.2 s round, from KZ). The order language always follows the language switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CTA_FLIP,
  CTA_ORDER,
  CTA_STEP_MS,
  ctaRotates,
  ctaShownLocale,
  nextCtaStep,
} from '../../apps/kiosk/src/components/ctaLanguage.ts';
import { copy } from '../../apps/kiosk/src/i18n.ts';

const welcome = readFileSync(
  new URL('../../apps/kiosk/src/components/WelcomeContent.tsx', import.meta.url),
  'utf8',
);
const salute = readFileSync(
  new URL('../../apps/kiosk/src/components/SaluteButton.tsx', import.meta.url),
  'utf8',
);
const free = { pinned: false, reduced: false };

test('the caption turns KZ -> RU -> EN, 2.4 s each, starting with KZ', () => {
  assert.deepEqual(CTA_ORDER, ['kk', 'ru', 'en']);
  assert.equal(CTA_STEP_MS, 2400);
  assert.equal(CTA_STEP_MS * CTA_ORDER.length, 7200);
  let step = 0;
  const seen = [];
  for (let i = 0; i < 6; i++) {
    seen.push(copy(ctaShownLocale(step, free, 'ru')).orderNow);
    step = nextCtaStep(step);
  }
  assert.deepEqual(seen, [
    'ТАПСЫРЫС БЕРУ',
    'СДЕЛАТЬ ЗАКАЗ',
    'ORDER NOW',
    'ТАПСЫРЫС БЕРУ',
    'СДЕЛАТЬ ЗАКАЗ',
    'ORDER NOW',
  ]);
  assert.deepEqual(CTA_FLIP, { duration: 280, outFade: 120, inDelay: 100, shift: 0.4 });
});

test('a chosen language pins the caption; Reduce Motion and the background stop it', () => {
  assert.equal(ctaRotates({ ...free, active: true }), true);
  assert.equal(ctaRotates({ pinned: true, reduced: false, active: true }), false);
  assert.equal(ctaRotates({ pinned: false, reduced: true, active: true }), false);
  assert.equal(ctaRotates({ ...free, active: false }), false);
  for (const step of [0, 1, 2]) {
    assert.equal(ctaShownLocale(step, { pinned: true, reduced: false }, 'en'), 'en');
    // Reduce Motion: the switch language (Russian by default), no rotation.
    assert.equal(ctaShownLocale(step, { pinned: false, reduced: true }, 'ru'), 'ru');
  }
  // Pinning is local state of the attract screen: it starts unpinned on every mount.
  assert.match(welcome, /const \[pinned, setPinned\] = useState\(false\);/);
  assert.match(welcome, /setPinned\(true\);\s*onLocale\(value\);/);
});

test('the order language is the switch language; the caption is hidden from VoiceOver', () => {
  // The button gets the switch language label and the plain onStart, never the caption language.
  assert.match(
    welcome,
    /<StartCta locale=\{locale\} pinned=\{pinned\} busy=\{busy\} onPress=\{onStart\} \/>/,
  );
  assert.match(welcome, /const label = copy\(locale\)\.orderNow;/);
  assert.match(salute, /accessibilityLabel=\{label\}/);
  assert.match(welcome, /onPress=\{onPress\}/);
  const caption = welcome.slice(
    welcome.indexOf('function CtaCaption'),
    welcome.indexOf('function CtaDots'),
  );
  const dots = welcome.slice(
    welcome.indexOf('function CtaDots'),
    welcome.indexOf('function StartCta'),
  );
  for (const part of [caption, dots]) {
    assert.match(part, /accessibilityElementsHidden/);
    assert.match(part, /importantForAccessibility="no-hide-descendants"/);
  }
  // Native driver only (transform/opacity), and the interval is cleared.
  assert.equal((caption.match(/useNativeDriver: true/g) ?? []).length, 2);
  assert.doesNotMatch(caption, /useNativeDriver: false/);
  assert.match(welcome, /setInterval\(\(\) => setStep\(nextCtaStep\), CTA_STEP_MS\)/);
  assert.match(welcome, /return \(\) => clearInterval\(timer\);/);
  assert.match(welcome, /const rotating = ctaRotates\(\{ pinned, reduced, active: true \}\);/);
});
