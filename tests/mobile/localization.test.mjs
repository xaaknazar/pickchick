import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  translate,
  t,
  setAppLocale,
  subscribeLocale,
  localize,
} from '../../apps/mobile/src/i18n/core.ts';
import { parsePreferences } from '../../apps/mobile/src/domain.ts';
import { historyDayLabel } from '../../apps/mobile/src/orders-tab.ts';
const messages = JSON.parse(
  readFileSync(new URL('../../apps/mobile/src/i18n/messages.json', import.meta.url), 'utf8'),
);
test('all messages have both translations and preserve every interpolation parameter', () => {
  const seen = new Set();
  for (const message of messages) {
    assert.ok(!seen.has(message.ru), message.ru);
    seen.add(message.ru);
    for (const language of ['kk', 'en']) {
      assert.equal(typeof message[language], 'string');
      assert.ok(message[language] || message.ru === ' г.', message.ru);
      assert.deepEqual(
        [...message[language].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(),
        [...message.ru.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(),
        message.ru,
      );
    }
  }
});
test('locale changes notify once, preserve unknown/user text and use full sentence word order', () => {
  let updates = 0;
  const remove = subscribeLocale(() => updates++);
  setAppLocale('kk');
  assert.equal(t('Корзина'), 'Себет');
  assert.equal(t('Заказ №{p0}', { p0: '12' }), '№12 тапсырыс');
  setAppLocale('kk');
  assert.equal(updates, 1);
  setAppLocale('en');
  assert.equal(t('Заказ №{p0}', { p0: '12' }), 'Order #12');
  assert.equal(localize('Owner nickname 123'), 'Owner nickname 123');
  assert.equal(translate('Unknown product', 'en'), 'Unknown product');
  remove();
  setAppLocale('ru');
});
test('all three languages survive stored preferences and localize Almaty dates', () => {
  const prefs = {
    version: 1,
    catalogMode: 'server',
    diningMode: 'takeaway',
    locale: 'en',
    nickname: '',
    branchId: null,
    releaseId: null,
    lines: [],
  };
  for (const locale of ['ru', 'kk', 'en'])
    assert.equal(parsePreferences(JSON.stringify({ ...prefs, locale }))?.locale, locale);
  assert.equal(parsePreferences(JSON.stringify({ ...prefs, locale: 'xx' })), null);
  setAppLocale('kk');
  assert.equal(historyDayLabel('2026-10-14', Date.parse('2026-10-14T07:00:00Z')), 'Бүгін');
  setAppLocale('en');
  assert.equal(historyDayLabel('2026-10-13', Date.parse('2026-10-14T07:00:00Z')), 'Yesterday');
  setAppLocale('ru');
  assert.equal(parsePreferences('invalid'), null);
  assert.equal(prefs.locale, 'en');
});
