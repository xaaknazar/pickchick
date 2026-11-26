import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  brandedFiscalRows,
  escposBytes,
  kazakhPickup,
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
  // Printed since the point sends ExternalOrderNumber (forms of 26.11, receipts 132431784, 132490612).
  'Тапсырыс нөмірі/Номер заказа: 27',
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

test('branded receipt in Kazakh and Russian: logo, order, goods with choices, totals, requisites', () => {
  const rows = brandedFiscalRows(ticket());
  assert.ok(rows);
  const texts = rows.map((r) => r.text ?? `${r.left} | ${r.right}`);
  assert.equal(rows[0].type, 'logo');
  for (const kept of [
    'PICK CHICK ALA AP',
    'ЖСН/ИИН 900101300000',
    'Тапсырыс / Заказ',
    '№27',
    'С собой',
    'Комбо Классик | 3 500 ₸',
    '2 дана/шт × 1 750 ₸',
    '+ Соус сырный',
    'Морс клюквенный 0,4 | 690 ₸',
    'Ескерту/Комментарий: Побольше салфеток',
    'Барлығы/Итого | 4 190 ₸',
    'Қолма-қол/Наличные | 4 190 ₸',
    'Алынды/Получено | 5 000 ₸',
    'Қайтарым/Сдача | 810 ₸',
    'Ауысым/Смена 2',
    'Чек №132600001',
    'САТУ/ПРОДАЖА №3',
    'ФБ/ФП: 132600001',
    'Уақыты/Время: 26.11.2026 12:01:05',
    'Мекенжай: Алматы қ., Алатау ауданы, Шаңырақ-2, көш. Рахымов ш.а., 172 үй, wk-devkkm-test',
    'Адрес: г.Алматы, Алатауский район, мкр. Шанырак-2, көш. Рахымов, д. 172, wk-devkkm-test',
    'ФДО/ОФД: ТОО "Smartcontract" (WOFD)',
    'Чекті тексеру/Проверка чека: ctest2.wofd.kz/consumer',
    'Чек автономды режимде құрастырылған',
    'Чек сформирован в автономном режиме',
    'КСН/ИНК: 12132',
    '057946199798',
    'КЗН/ЗНМ: SWK00036966',
    'Кассир: Айгерим',
    'Фискалдық чек',
    'Фискальный чек',
    'PickChick-ті таңдағаныңызға рахмет!',
    'Спасибо, что выбрали PickChick!',
  ])
    assert.ok(texts.includes(kept), kept);
  assert.ok(rows.some((r) => r.type === 'qr' && r.qr.length === 21));
  const all = texts.join('\n');
  assert.ok(!all.includes('Иванов'), 'cabinet owner name is not printed');
  assert.ok(!all.includes('Тестовая касса'), 'cabinet cashbox title is not printed');
  assert.ok(!all.includes('ЖШС'), 'the ОФД is printed once');
  assert.ok(!all.includes('Чек/Чек'), 'identical halves are printed once');
  assert.ok(!all.includes('Номер заказа'), 'the order number is printed once, big, on top');
  assert.ok(
    texts.indexOf('ЖСН/ИИН 900101300000') < texts.indexOf('№27'),
    'taxpayer under the logo',
  );
});

test('the pickup line gets a Kazakh line above it', () => {
  assert.equal(kazakhPickup('Забрать на выдаче'), 'Беру орнынан алыңыз');
  assert.equal(kazakhPickup('Заказ из киоска'), 'Киосктан тапсырыс');
  assert.equal(kazakhPickup('Выдача доставки · Wolt №12'), 'Жеткізуге беру · Wolt №12');
  assert.equal(kazakhPickup('С собой'), null);
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
  assert.match(html, /class="total"><span>Барлығы\/Итого<\/span><b>4 190 ₸<\/b>/);
  const bytes = escposBytes(ticket());
  const text = bytes.toString('latin1');
  assert.ok(text.includes('PICK CHICK'));
  assert.ok(bytes.includes(Buffer.from([0x1d, 0x28, 0x6b])), 'printer QR command');
});

test('receipt block is validated strictly', () => {
  assert.throws(() => ticket({ ...RECEIPT, extra: 1 }), /INVALID_TICKET/);
  assert.throws(() => ticket({ ...RECEIPT, cash_tendered_minor: '5.00' }), /INVALID_TICKET/);
});

test('the branded receipt survives extra 48-dash lines and a QR printed as its link', () => {
  const extra = { type: 0, value: '-'.repeat(48), style: 0 };
  const at = (pattern) => FORM.findIndex((l) => pattern.test(l.value));
  const form = [...FORM];
  form.splice(at(/ФДО:/), 0, extra); // requisites cut in two
  form.splice(at(/ИТОГО/), 0, extra); // payments apart from the total
  const qr = form.findIndex((l) => l.type === 2);
  form[qr] = { type: 0, value: form[qr].value, style: 0 };
  const rows = brandedFiscalRows(
    parseTicket({
      kind: 'fiscal',
      fiscal_lines: form,
      printed_at: '2026-11-26T07:01:10Z',
      terminal_label: 'Касса 1',
      receipt: RECEIPT,
    }),
  );
  assert.ok(rows);
  const texts = rows.map((r) => r.text ?? `${r.left} | ${r.right}`);
  for (const kept of [
    'Комбо Классик | 3 500 ₸',
    'Барлығы/Итого | 4 190 ₸',
    'Қолма-қол/Наличные | 4 190 ₸',
    'ФДО/ОФД: ТОО "Smartcontract" (WOFD)',
    'Фискальный чек',
    'КЗН/ЗНМ: SWK00036966',
  ])
    assert.ok(texts.includes(kept), kept);
});

test('the real form of receipt 132490612 (order 24, 26.11) gets the branded layout', () => {
  const form = [
    center('PICK CHICK ALA AP'),
    center('ЖСН/ИИН 900101300000'),
    sep,
    center('Тестовая касса 25.11.26 12:16'),
    center('Ауысым/Смена 1'),
    'Чек/Чек №132490612',
    'Кассир/Кассир Иванов Иван',
    pad('САТУ/ПРОДАЖА', '№4'),
    sep,
    'Тапсырыс нөмірі/Номер заказа: 24',
    '  1. Finger Combo',
    '   1 дана/шт x 1,00',
    pad('   Құны/Стоимость', '1,00'),
    sep,
    pad('Қолма-қол/Наличные:', '1,00'),
    pad('БАРЛЫҒЫ/ИТОГО:', '1,00'),
    sep,
    'ФБ/ФП: 132490612',
    'Уақыты/Время: 26.11.2026 13:37:41',
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
      ? { type: 2, value: 'http://ctest2.wofd.kz/consumer?i=132490612', style: 0, qr }
      : { type: 0, value, style: /ИТОГО|ФИСКАЛ/.test(value) ? 1 : 0 },
  );
  const rows = brandedFiscalRows(
    parseTicket({
      kind: 'fiscal',
      fiscal_lines: form,
      printed_at: '2026-11-26T08:37:42Z',
      terminal_label: 'Касса 1',
      receipt: {
        display_number: '24',
        lines: [{ name: 'Finger Combo', options: ['Соус барбекю', 'Кола 0,5'] }],
        cash_tendered_minor: '100',
      },
    }),
  );
  assert.ok(rows, 'not the plain Webkassa form');
  const texts = rows.map((r) => r.text ?? `${r.left} | ${r.right}`);
  for (const kept of [
    '№24',
    'Finger Combo | 1 ₸',
    '+ Соус барбекю',
    '+ Кола 0,5',
    'Барлығы/Итого | 1 ₸',
    'Қолма-қол/Наличные | 1 ₸',
    'Фискальный чек',
  ])
    assert.ok(texts.includes(kept), kept);
});
