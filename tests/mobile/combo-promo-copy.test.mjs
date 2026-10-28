import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setAppLocale, t } from '../../apps/mobile/src/i18n/core.ts';

// Owner decision 27.10.2026: «Купи 6 комбо, 7-е в подарок» (was 7 + 1).
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const OLD_RULE =
  /\b7 комбо|8-е|8-ші|сегізінші|восьм|\b8th\b|\beighth\b|\bbuy 7\b|\b7 combos\b|\bseven combos\b/i;

test('customer terms state only the current 6 + 1 rule, without internal history', () => {
  const draft = read('docs/legal/customer-documents-draft.md');
  const start = draft.indexOf('### Акции, Чики и игры');
  assert.ok(start > 0, 'promotions section is present');
  const end = draft.indexOf('\n### ', start + 1);
  const section = draft.slice(start, end).replace(/\s+/g, ' ');
  assert.ok(
    section.includes(
      'Действующая на точке акция «Купи 6 комбо, 7-е в подарок» не означает автоматического ' +
        'начисления цифровых отметок, пока это явно не включено.',
    ),
    section,
  );
  assert.doesNotMatch(draft, OLD_RULE);
  // Customer text carries no decision provenance: that lives in the operations notes.
  assert.doesNotMatch(section, /решени[ея] владельца|ранее|прежн|\d{2}\.\d{2}\.\d{4}/);
});

test('no customer-visible app string in any locale still promises 7 + 1 or an 8th combo', () => {
  const messages = JSON.parse(read('apps/mobile/src/i18n/messages.json'));
  for (const entry of messages)
    for (const locale of ['ru', 'kk', 'en'])
      assert.doesNotMatch(entry[locale], OLD_RULE, `${locale}: ${entry[locale]}`);
});

test('the KK headline keeps «сатып ал.» together so «ал.» never sits alone at 320 pt', () => {
  try {
    setAppLocale('kk');
    // A no-break space joins the verb; the line breaks after «комбо» instead of before «ал.».
    assert.equal(t('Купи 6 комбо.'), '6 комбо сатып ал.');
    assert.equal(t('7-е - в подарок!'), '7-шісі - сыйлық!');
    setAppLocale('ru');
    assert.equal(t('Купи 6 комбо.'), 'Купи 6 комбо.');
  } finally {
    setAppLocale('ru');
  }
});

test('the reward background prompt that still names 7 + 1 is tracked and draws no count', () => {
  const { assets, corrections } = JSON.parse(read('apps/mobile/assets/catalog-hd/prompts.json'));
  const promo = [...assets, ...corrections].filter(({ prompt }) =>
    /gift campaign|\b\d+ combos\b/i.test(prompt),
  );
  // Kept verbatim as the sent prompt. The image has no text or numbers, so it fits 6 + 1;
  // a new generation must name 6 + 1 (see the catalog-hd README).
  assert.deepEqual(
    promo.map(({ id }) => id),
    ['reward-seven-plus-one'],
  );
  for (const { prompt } of promo) assert.match(prompt, /No text, numbers/);
  assert.match(
    read('apps/mobile/assets/catalog-hd/README.md'),
    /промпте нужно указать правило 6 \+ 1/,
  );
});
