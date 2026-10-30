import test from 'node:test';
import assert from 'node:assert/strict';
import { kazakhTextStyle } from '../../apps/mobile/src/i18n/typography.ts';
import { translate } from '../../apps/mobile/src/i18n/core.ts';

test('Kazakh uses a complete system face and retains emphasis on every platform', () => {
  for (const [platform, family] of [
    ['ios', 'System'],
    ['android', 'sans-serif'],
    ['web', 'system-ui'],
  ]) {
    for (const [fontFamily, fontWeight] of [
      ['Jost_600SemiBold', '600'],
      ['Jost_700Bold', '700'],
      ['Manrope_400Regular', '400'],
      ['Manrope_600SemiBold', '600'],
      ['Manrope_700Bold', '700'],
    ]) {
      assert.deepEqual(kazakhTextStyle('kk', { fontFamily }, platform), {
        fontFamily: family,
        fontWeight,
      });
    }
    assert.deepEqual(
      kazakhTextStyle('kk', { fontFamily: 'Jost_700Bold', fontWeight: '500' }, platform),
      { fontFamily: family, fontWeight: '500' },
    );
  }
});

test('language switching leaves other languages and icon faces untouched; nested text inherits weight', () => {
  for (const locale of ['ru', 'en'])
    assert.equal(kazakhTextStyle(locale, { fontFamily: 'Jost_700Bold' }, 'ios'), undefined);
  assert.equal(kazakhTextStyle('kk', { fontFamily: 'Ionicons' }, 'ios'), undefined);
  assert.deepEqual(kazakhTextStyle('kk', undefined, 'ios'), { fontFamily: 'System' });
});

test('game navigation and payment instruction use consistent polite Kazakh', () => {
  assert.equal(translate('Игры', 'kk'), 'Ойындар');
  assert.equal(translate('Игры', 'en'), 'Games');
  assert.equal(translate('тяни для оплаты', 'kk'), 'сырғытып төлеңіз');
});
