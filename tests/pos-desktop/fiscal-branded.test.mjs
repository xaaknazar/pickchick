import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  brandedFiscalRows,
  escposBytes,
  parseTicket,
  russian,
  ticketHtml,
  ticketRows,
} from '../../apps/pos-desktop/printer.mjs';

const pad = (left, right = '') =>
  left + ' '.repeat(Math.max(1, 48 - left.length - right.length)) + right;
const center = (value) => ' '.repeat(Math.max(0, Math.floor((48 - value.length) / 2))) + value;
const sep = '-'.repeat(48);
const qr = Array.from({ length: 21 }, (_, y) =>
  Array.from({ length: 21 }, (_, x) => ((x * y) % 3 ? '0' : '1')).join(''),
);
/** The shape of a Webkassa Ticket/PrintFormat (test receipt 25.11), two goods. */
export const FORM = [
  center('PICK CHICK ALA AP'),
  center('ЖСН/ИИН 900101300000'),
  sep,
  center('Тестовая касса 26.11.26 12:00'),
  center('Ауысым/Смена 2'),
  'Чек/Чек №132600001',
  'Кассир/Кассир Иванов Иван',
  pad('САТУ/ПРОДАЖА', '№3'),
  sep,
  '  1. Комбо Классик',
  '   2 дана/шт x 1 750,00',
  pad('   Құны/Стоимость', '3 500,00'),
  '  2. Морс клюквенный 0,4',
  '   1 дана/шт x 690,00',
  pad('   Құны/Стоимость', '690,00'),
  sep,
  pad('Қолма-қол/Наличные:', '4 190,00'),
  pad('БАРЛЫҒЫ/ИТОГО:', '4 190,00'),
  sep,
  'ФБ/ФП: 132600001',
  'Уақыты/Время: 26.11.2026 12:01:05',
  // Address, ОФД and site wrapped at 48 columns exactly as on the 26.11 test receipt.
  'Алматы қ., Алатау ауданы, Шаңырақ-2, көш.',
  'Рахымов ш.а., 172 үй, wk-devkkm-test',
  'г.Алматы, Алатауский район, мкр. Шанырак-2,',
  'көш. Рахымов, д. 172, wk-devkkm-test',
  'ФДО: ЖШС "Smartcontract" (WOFD)',
  'ОФД: ТОО "Smartcontract" (WOFD)',
  'Чекті тексеру үшін сайтқа кіріңіз/Для проверки',
  'чека зайдите на сайт: ctest2.wofd.kz/consumer',
  'Чек автономды режимде құрастырылған/Чек',
  'сформирован в автономном режиме',
  sep,
  center('ФИСКАЛДЫ ЧЕК/ФИСКАЛЬНЫЙ ЧЕК'),
  null,
  center('КСН/ИНК: 12132'),
  'МКК БКМ коды (КТН)/Код ККМ КГД (РНМ):',
  '057946199798',
  'КЗН/ЗНМ: SWK00036966',
  center('WEBKASSA.KZ'),
].map((value) =>
  value === null
    ? {
        type: 2,
        value: 'http://ctest2.wofd.kz/consumer?i=132600001&f=057946199798&s=4190.00',
        style: 0,
        qr,
      }
    : { type: 0, value, style: /ИТОГО|ФИСКАЛ/.test(value) ? 1 : 0 },
);
export const RECEIPT = {
  display_number: '27',
  lines: [
    { name: 'Комбо Классик', options: ['Соус сырный', 'Картофель фри большой', 'Без лука'] },
    { name: 'Морс клюквенный 0,4', options: [] },
  ],
  pickup_text: 'С собой',
  comment: 'Побольше салфеток',
  cashier: 'Айгерим',
  cash_tendered_minor: '500000',
  change_minor: '81000',
};
const ticket = (receipt = RECEIPT) =>
  parseTicket({
    kind: 'fiscal',
    fiscal_lines: FORM,
    printed_at: '2026-11-26T07:01:10Z',
    terminal_label: 'Касса 1',
    ...(receipt ? { receipt } : {}),
  });

test('bilingual Webkassa labels keep their Russian half', () => {
  assert.equal(russian('Қолма-қол/Наличные:   4 190,00'), 'Наличные: 4 190,00');
  assert.equal(russian('КЗН/ЗНМ: SWK00036966'), 'ЗНМ: SWK00036966');
  assert.equal(russian('057946199798'), '057946199798');
});

test('branded receipt: logo, order, goods with choices, totals, every fiscal requisite', () => {
  const rows = brandedFiscalRows(ticket());
  assert.ok(rows);
  const texts = rows.map((r) => r.text ?? `${r.left} | ${r.right}`);
  assert.equal(rows[0].type, 'logo');
  assert.ok(texts.includes('Заказ №27'));
  assert.ok(texts.includes('Комбо Классик | 3 500 ₸'));
  assert.ok(texts.includes('2 шт × 1 750 ₸'));
  assert.ok(texts.includes('+ Соус сырный'));
  assert.ok(texts.includes('Морс клюквенный 0,4 | 690 ₸'));
  assert.ok(texts.includes('Комментарий: Побольше салфеток'));
  assert.ok(texts.includes('Итого | 4 190 ₸'));
  assert.ok(texts.includes('Наличные | 4 190 ₸'));
  assert.ok(texts.includes('Получено | 5 000 ₸'));
  assert.ok(texts.includes('Сдача | 810 ₸'));
  for (const kept of [
    'PICK CHICK ALA AP',
    'ИИН 900101300000',
    'Смена 2',
    'Чек №132600001',
    'ФП: 132600001',
    'Время: 26.11.2026 12:01:05',
    'Адрес: г.Алматы, Алатауский район, мкр. Шанырак-2, көш. Рахымов, д. 172, wk-devkkm-test',
    'ОФД: ТОО "Smartcontract" (WOFD)',
    'Проверка чека: ctest2.wofd.kz/consumer',
    'Чек сформирован в автономном режиме',
    'ИНК: 12132',
    '057946199798',
    'ЗНМ: SWK00036966',
    'Кассир: Айгерим',
    'Фискальный чек',
  ])
    assert.ok(texts.includes(kept), kept);
  assert.ok(rows.some((r) => r.type === 'qr' && r.qr.length === 21));
  const all = texts.join('\n');
  assert.ok(!all.includes('Иванов'), 'cabinet owner name is not printed');
  assert.ok(!all.includes('Тестовая касса'), 'cabinet cashbox title is not printed');
  assert.ok(!all.includes('ФДО'), 'the Kazakh duplicate of the ОФД line is dropped');
  assert.ok(!all.includes('Шаңырақ'), 'the address is printed once, in Russian');
  assert.ok(
    texts.indexOf('ИИН 900101300000') < texts.indexOf('Заказ №27'),
    'taxpayer under the logo',
  );
});

test('a form without the expected sections, or no order context, prints as Webkassa made it', () => {
  assert.equal(brandedFiscalRows(ticket(null)), null);
  const rows = ticketRows(ticket(null));
  assert.equal(rows.length, FORM.length);
  const broken = parseTicket({
    kind: 'fiscal',
    fiscal_lines: FORM.filter((l) => !/^-+$/.test(l.value)),
    printed_at: '2026-11-26T07:01:10Z',
    terminal_label: 'Касса 1',
    receipt: RECEIPT,
  });
  assert.equal(brandedFiscalRows(broken), null);
});

test('HTML and ESC/POS both carry the branded receipt', () => {
  const html = ticketHtml(ticket());
  assert.match(html, /<svg[^>]+viewBox="0 0 220 202"/);
  assert.ok(
    !/<img|<script|https?:\/\/(?!www\.w3\.org)/.test(html.replace(/ctest2\.wofd\.kz[^<"]*/g, '')),
  );
  assert.match(html, /class="total"><span>Итого<\/span><b>4 190 ₸<\/b>/);
  const bytes = escposBytes(ticket());
  const text = bytes.toString('latin1');
  assert.ok(text.includes('PICK CHICK'));
  assert.ok(bytes.includes(Buffer.from([0x1d, 0x28, 0x6b])), 'printer QR command');
});

test('receipt block is validated strictly', () => {
  assert.throws(() => ticket({ ...RECEIPT, extra: 1 }), /INVALID_TICKET/);
  assert.throws(() => ticket({ ...RECEIPT, cash_tendered_minor: '5.00' }), /INVALID_TICKET/);
});
