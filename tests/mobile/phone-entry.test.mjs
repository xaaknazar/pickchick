import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { phoneFieldDigits, phoneMayContinue } from '../../apps/mobile/src/phone-entry.ts';
import { normalizeDemoPhone } from '../../apps/mobile/src/demo-account.ts';

// Constructed fixture number (not a real customer): the 10 digits after +7.
const local = '7000000001';

/** What the field holds after typing `keys` one by one into it, as the TextInput reports it. */
function typeKeys(keys) {
  let digits = '';
  let dismissedAt = null;
  for (const [index, key] of [...keys].entries()) {
    if (dismissedAt !== null) break; // the keyboard is gone: later keys never arrive
    // The field shows the formatted digits; a key appends to that text.
    const shown = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 8), digits.slice(8, 10)]
      .filter(Boolean)
      .join(' ');
    digits = phoneFieldDigits(shown + key);
    if (digits.length === 10 && normalizeDemoPhone(digits) && !phoneMayContinue(digits))
      dismissedAt = index;
  }
  return digits;
}

test('the review number typed with its country code keeps every digit (App Review 29.10.2026)', () => {
  for (const typed of [`+7${local}`, `7${local}`, `8${local}`, local, `+7 ${local}`]) {
    assert.equal(typeKeys(typed), local, typed);
    assert.equal(normalizeDemoPhone(typeKeys(typed)), `+7${local}`, typed);
  }
  // Pasted or autofilled in any usual form.
  for (const pasted of [
    `+7${local}`,
    `+7 (${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6, 8)}-${local.slice(8)}`,
    `8 ${local}`,
    `7${local}`,
    local,
  ])
    assert.equal(phoneFieldDigits(pasted), local, pasted);
});

test('ten digits that may still carry the country code are not final', () => {
  // «+7 700…» after ten keys: a valid-looking 770… number, but the last key is still coming.
  assert.equal(phoneMayContinue(`7${local}`.slice(0, 10)), true);
  assert.equal(phoneMayContinue(`8${local}`.slice(0, 10)), true);
  // A number typed without the country code is final at 10 digits when it cannot be one.
  assert.equal(phoneMayContinue('7012345678'), false);
  assert.equal(phoneMayContinue(local), false);
  assert.equal(phoneMayContinue('770000000'), false);
  // A 77… number typed without the code still signs in: it is valid, only the keyboard stays.
  assert.equal(normalizeDemoPhone('7770000001'), '+77770000001');
});

test('an extra key after a full number is ignored instead of shifting the number', () => {
  assert.equal(phoneFieldDigits('701 000 00 019'), '7010000001');
  assert.equal(phoneFieldDigits('8001234567'), '8001234567');
  assert.equal(phoneFieldDigits(''), '');
  assert.equal(phoneFieldDigits('+'), '');
});

test('the phone screen uses these rules for the keyboard and the error', () => {
  const source = readFileSync(
    new URL('../../apps/mobile/src/screens/AuthScreens.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /const next = phoneFieldDigits\(value\);/);
  assert.match(
    source,
    /next\.length === 10 && normalizeDemoPhone\(next\) && !phoneMayContinue\(next\)\)\s*Keyboard\.dismiss\(\)/,
  );
  assert.match(source, /phone\.length === 10 && !valid && !phoneMayContinue\(phone\)/);
});
