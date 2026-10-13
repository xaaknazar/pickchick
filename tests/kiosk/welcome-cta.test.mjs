// Kiosk build 14, owner decision 2026-10-11: the attract CTA caption takes turns KZ -> RU -> EN
// (2.4 s each, 7.2 s round, from KZ). The order language always follows the language switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CTA_FLIP,
  CTA_ORDER,
  CTA_STEP_MS,
  ctaCaptionMove,
  ctaRestPoses,
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
const caption = welcome.slice(
  welcome.indexOf('function CtaCaption'),
  welcome.indexOf('function CtaDots'),
);

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
  const dots = welcome.slice(
    welcome.indexOf('function CtaDots'),
    welcome.indexOf('function StartCta'),
  );
  for (const part of [caption, dots]) {
    assert.match(part, /accessibilityElementsHidden/);
    assert.match(part, /importantForAccessibility="no-hide-descendants"/);
  }
  // Native driver only (transform/opacity), and the interval is cleared.
  assert.equal((caption.match(/useNativeDriver: true/g) ?? []).length, 1);
  assert.doesNotMatch(caption, /useNativeDriver: false/);
  assert.match(welcome, /setInterval\(\(\) => setStep\(nextCtaStep\), CTA_STEP_MS\)/);
  assert.match(welcome, /return \(\) => clearInterval\(timer\);/);
  assert.match(welcome, /const rotating = ctaRotates\(\{ pinned, reduced, active: true \}\);/);
});

// Kiosk build 16 (iPad, Fabric): after a guest chose a language the button showed several
// captions at once. On iOS Fabric a view whose opacity/transform the native driver has moved
// ignores later plain style values, so a caption switched from an animated to a static
// `opacity: 0` stayed opaque. Each caption now keeps its own Animated values in its style.
test('every caption always reads its own Animated opacity and offset, never a plain value', () => {
  assert.match(caption, /const \[tracks\] = useState\(\(\) => \{/);
  assert.doesNotMatch(caption, /setTracks|tracks = |\.interpolate\(/);
  assert.equal((caption.match(/new Animated\.Value\(/g) ?? []).length, 2);
  assert.match(caption, /opacity: new Animated\.Value\(rest\[locale\]\.opacity\)/);
  assert.match(caption, /y: new Animated\.Value\(rest\[locale\]\.lift \* shift\)/);
  const text = caption.slice(
    caption.indexOf('<Animated.Text'),
    caption.indexOf('</Animated.Text>'),
  );
  assert.equal((text.match(/opacity:/g) ?? []).length, 1);
  assert.match(text, /opacity: tracks\[locale\]\.opacity,/);
  assert.equal((text.match(/translateY:/g) ?? []).length, 1);
  assert.match(text, /transform: \[\{ translateY: tracks\[locale\]\.y \}\],/);
  // No role switch and no conditional anywhere in the caption style.
  const style = text.slice(text.indexOf('style={{'), text.indexOf('}}', text.indexOf('style={{')));
  assert.doesNotMatch(style, /role|\?/);
  assert.doesNotMatch(caption, /role/);
  assert.match(text, /testID=\{locale === shown \? 'kiosk-start-caption' : undefined\}/);
  // Every pose change stops the animations first and sets both values of every caption.
  assert.match(
    caption,
    /for \(const locale of CTA_ORDER\) \{\s*const track = tracks\[locale\];\s*track\.opacity\.stopAnimation\(\);\s*track\.y\.stopAnimation\(\);\s*track\.opacity\.setValue\(poses\[locale\]\.opacity\);\s*track\.y\.setValue\(poses\[locale\]\.lift \* shift\);/,
  );
});

test('a flip moves the old caption up and out, the new one up and in (CTA_FLIP timings)', () => {
  const { start, legs } = ctaCaptionMove('kk', 'ru', true);
  assert.deepEqual(start, ctaRestPoses('kk'));
  assert.deepEqual(start, {
    kk: { opacity: 1, lift: 0 },
    ru: { opacity: 0, lift: 1 },
    en: { opacity: 0, lift: 1 },
  });
  assert.deepEqual(legs, [
    { locale: 'kk', prop: 'opacity', to: 0, delay: 0, duration: 120, curve: 'linear' },
    { locale: 'kk', prop: 'lift', to: -1, delay: 0, duration: 280, curve: 'ease' },
    { locale: 'ru', prop: 'opacity', to: 1, delay: 100, duration: 180, curve: 'linear' },
    { locale: 'ru', prop: 'lift', to: 0, delay: 0, duration: 280, curve: 'ease' },
  ]);
  // The component maps each leg to one native-driver timing of that caption's own value.
  assert.match(
    caption,
    /leg\.prop === 'opacity' \? tracks\[leg\.locale\]\.opacity : tracks\[leg\.locale\]\.y/,
  );
  assert.match(caption, /toValue: leg\.prop === 'opacity' \? leg\.to : leg\.to \* shift,/);
  assert.match(
    caption,
    /delay: leg\.delay,\s*duration: leg\.duration,\s*easing: curve\(leg\.curve\),/,
  );
});

test('stopping the rotation settles every caption at once, also in the middle of a flip', () => {
  for (const from of CTA_ORDER) {
    for (const shown of CTA_ORDER) {
      // A chosen language or Reduce Motion: no flip, every caption at rest.
      assert.deepEqual(ctaCaptionMove(from, shown, false), {
        start: ctaRestPoses(shown),
        legs: [],
      });
    }
    // The same language again while rotating (e.g. a new size): rest, no flip.
    assert.deepEqual(ctaCaptionMove(from, from, true), { start: ctaRestPoses(from), legs: [] });
  }
  // The effect always applies `start` before anything else, keeps no early return, and its
  // cleanup stops the flip so a stale completion cannot touch the values.
  const effect = caption.slice(caption.indexOf('useEffect('), caption.indexOf('return (\n'));
  assert.doesNotMatch(effect, /shown === from|from === shown/);
  assert.match(
    effect,
    /const \{ start, legs \} = ctaCaptionMove\(from, shown, animate\);\s*pose\(start\);\s*if \(legs\.length === 0\) return;/,
  );
  assert.match(effect, /if \(finished && live\) pose\(ctaRestPoses\(shown\)\);/);
  assert.match(effect, /return \(\) => \{\s*live = false;\s*flip\.stop\(\);\s*\};/);
  assert.match(effect, /\}, \[shown, animate, shift, tracks\]\);/);

  // Model of CtaCaption: React's cleanup stops a running flip where it is, then the effect
  // writes `start` over whatever the values hold and runs the legs on them.
  const copyPoses = (poses) => Object.fromEntries(CTA_ORDER.map((l) => [l, { ...poses[l] }]));
  const at = (flight, t) => {
    const poses = copyPoses(flight.start);
    for (const leg of flight.legs) {
      const p = Math.min(1, Math.max(0, (t - leg.delay) / leg.duration));
      const from = flight.start[leg.locale][leg.prop];
      poses[leg.locale][leg.prop] = from + (leg.to - from) * p;
    }
    return poses;
  };
  const model = (first) => {
    let current = first;
    let values = ctaRestPoses(first);
    let flight = null;
    return {
      show(shown, animate, t) {
        if (flight) values = at(flight, t - flight.t0);
        const move = ctaCaptionMove(current, shown, animate);
        current = shown;
        for (const locale of CTA_ORDER) Object.assign(values[locale], move.start[locale]);
        flight = move.legs.length ? { start: copyPoses(values), legs: move.legs, t0: t } : null;
      },
      read(t) {
        return flight ? at(flight, t - flight.t0) : values;
      },
    };
  };
  const lit = (poses) => CTA_ORDER.filter((locale) => poses[locale].opacity > 0.05);
  // Mid-flip both captions are half-shown: the old code froze them there when the guest tapped
  // the language that was flipping in (`shown` unchanged, rotation stopped).
  const frozen = model('kk');
  frozen.show('ru', true, 0);
  assert.deepEqual(lit(frozen.read(110)), ['kk', 'ru']);
  assert.deepEqual(lit(frozen.read(CTA_FLIP.duration)), ['ru']);
  assert.deepEqual(frozen.read(CTA_FLIP.duration).ru, { opacity: 1, lift: 0 });
  // Choosing any language at any moment of any flip leaves exactly that caption, in place.
  for (const [from, to] of [
    ['kk', 'ru'],
    ['ru', 'en'],
    ['en', 'kk'],
  ]) {
    for (const t of [0, 40, 110, 200, 279, 1000]) {
      for (const chosen of CTA_ORDER) {
        const stage = model(from);
        stage.show(to, true, 0);
        stage.show(chosen, false, t);
        for (const later of [t, t + 1000]) {
          const poses = stage.read(later);
          assert.deepEqual(lit(poses), [chosen], `${from}->${to}, ${chosen} at ${t} ms`);
          assert.deepEqual(poses[chosen], { opacity: 1, lift: 0 });
        }
      }
    }
  }
});
