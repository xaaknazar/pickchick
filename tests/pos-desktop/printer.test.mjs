import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { desktopFile } from './support.mjs';

// Cutover 19.11, CL-3 (contracts section 5.8): tickets and the cash drawer of pos-desktop.
const {
  DRAWER_PULSE,
  ESC,
  createPrinter,
  encodeCp866,
  escposBytes,
  pairLines,
  parseTicket,
  printable,
  sendOnce,
  ticketHtml,
  ticketRows,
  validatePrinter,
} = await import(pathToFileURL(desktopFile('printer.mjs')).href);
const { validateConfig } = await import(pathToFileURL(desktopFile('protocol.mjs')).href);

const LAN_PRINTER = '192.168.77.20';
const order = () => ({
  kind: 'order',
  title: 'Чек заказа (не фискальный)',
  display_number: '27',
  pickup_text: 'Забрать на выдаче',
  lines: [{ name: 'Чизбургер', quantity: 2, total_minor: '300000', options: ['Без лука'] }],
  totals: [{ label: 'Итого', amount_minor: '300000' }],
  tenders: [{ method: 'cash', label: 'Наличные', amount_minor: '300000' }],
  change_minor: '20000',
  printed_at: '2026-11-19T04:05:00.000Z',
  terminal_label: 'Касса 1',
});
const xReport = () => ({
  kind: 'x_report',
  title: 'X-отчёт PickChick (не фискальный)',
  lines: ['Заказов: 1, отменено: 0'],
  totals: [
    { label: 'Начальный остаток', amount_minor: '500000' },
    { label: 'Ожидается в ящике', amount_minor: '1199000' },
  ],
  tenders: [
    {
      method: 'cash',
      label: 'Наличные',
      sales_minor: '699000',
      refunds_minor: '0',
      count: 1,
    },
  ],
  printed_at: '2026-11-19T04:05:00.000Z',
  terminal_label: 'Касса 1',
});

/** An independent PC866 encoder: the inverse of the platform's ibm866 decoder. */
const decoder = new globalThis.TextDecoder('ibm866');
const table = new Map(
  Array.from({ length: 256 }, (_, byte) => [decoder.decode(Uint8Array.of(byte)), byte]),
);
const cp866 = (text) => [...text].map((c) => table.get(c));
const W = 42;
const line = (text) => [...cp866(text), 0x0a];
const pair = (left, right) => line(left + ' '.repeat(W - left.length - right.length) + right);

test('printer settings: Windows queue or a LAN ESC/POS printer, nothing else', () => {
  assert.equal(validatePrinter(undefined), undefined);
  assert.deepEqual(validatePrinter({ mode: 'windows-driver', deviceName: 'POS-80' }), {
    mode: 'windows-driver',
    deviceName: 'POS-80',
  });
  assert.deepEqual(validatePrinter({ mode: 'escpos-tcp', host: LAN_PRINTER }), {
    mode: 'escpos-tcp',
    host: LAN_PRINTER,
    port: 9100,
    drawerKick: false,
  });
  assert.deepEqual(
    validatePrinter({ mode: 'escpos-tcp', host: LAN_PRINTER, port: 9100, drawerKick: true }),
    { mode: 'escpos-tcp', host: LAN_PRINTER, port: 9100, drawerKick: true },
  );
  for (const bad of [
    null,
    'windows-driver',
    [],
    {},
    { mode: 'usb', deviceName: 'POS-80' },
    { mode: 'windows-driver' },
    { mode: 'windows-driver', deviceName: '' },
    { mode: 'windows-driver', deviceName: 'POS\n80' },
    { mode: 'windows-driver', deviceName: 'x'.repeat(201) },
    { mode: 'windows-driver', deviceName: 'POS-80', host: LAN_PRINTER },
    { mode: 'escpos-tcp' },
    { mode: 'escpos-tcp', host: '8.8.8.8' },
    { mode: 'escpos-tcp', host: '127.0.0.1' },
    { mode: 'escpos-tcp', host: 'printer.invalid' },
    { mode: 'escpos-tcp', host: LAN_PRINTER, port: 0 },
    { mode: 'escpos-tcp', host: LAN_PRINTER, port: '9100' },
    { mode: 'escpos-tcp', host: LAN_PRINTER, drawerKick: 'yes' },
    { mode: 'escpos-tcp', host: LAN_PRINTER, deviceName: 'POS-80' },
  ])
    assert.throws(() => validatePrinter(bad), /INVALID_POS_CONFIG/, JSON.stringify(bad));
  // The key belongs to config.json; without it the settings are exactly today's.
  assert.equal(validateConfig({}).printer, undefined);
  assert.ok(!('printer' in validateConfig({})));
  assert.deepEqual(validateConfig({ printer: { mode: 'windows-driver', deviceName: 'POS-80' } }), {
    edgePort: 3101,
    branchLabel: 'Локальная точка',
    categories: {},
    printer: { mode: 'windows-driver', deviceName: 'POS-80' },
  });
  assert.throws(() => validateConfig({ printer: { mode: 'escpos-tcp', host: '8.8.8.8' } }));
});

test('tickets are typed JSON: anything unexpected is refused before printing', () => {
  assert.deepEqual(parseTicket(order()), { ...order() });
  assert.deepEqual(parseTicket(xReport()), { ...xReport() });
  const refund = {
    kind: 'refund',
    title: 'Возврат (не фискальный)',
    display_number: '27',
    totals: [{ label: 'Возвращено', amount_minor: '150000' }],
    tenders: [{ method: 'kaspi_terminal', label: 'Kaspi терминал', amount_minor: '150000' }],
    printed_at: '2026-11-19T04:05:00.000Z',
    terminal_label: 'Касса 1',
  };
  assert.deepEqual(parseTicket(refund), { ...refund, lines: [] });
  const broken = [
    null,
    [],
    '<html>',
    { ...order(), kind: 'receipt' },
    { ...order(), html: '<b>x</b>' },
    { ...order(), title: '' },
    { ...order(), title: 'x'.repeat(81) },
    { ...order(), title: 'Чек\u0007' },
    { ...order(), display_number: 27 },
    { ...order(), display_number: '0' },
    { ...order(), totals: [] },
    { ...order(), totals: [{ label: 'Итого', amount_minor: 300000 }] },
    { ...order(), totals: [{ label: 'Итого', amount_minor: '3000.00' }] },
    { ...order(), totals: [{ label: 'Итого', amount_minor: '-1' }] },
    { ...order(), totals: [{ label: 'Итого', amount_minor: '01' }] },
    { ...order(), lines: ['Чизбургер'] },
    { ...order(), lines: [{ name: 'Чизбургер', quantity: 0, total_minor: '1' }] },
    { ...order(), lines: [{ name: 'Чизбургер', quantity: 1.5, total_minor: '1' }] },
    { ...order(), lines: [{ name: 'Чизбургер', quantity: 1, total_minor: '1', price: '1' }] },
    { ...order(), tenders: [{ method: 'card', label: 'Карта', amount_minor: '1' }] },
    { ...order(), tenders: [{ ...xReport().tenders[0] }] },
    { ...order(), change_minor: '' },
    { ...order(), printed_at: 'вчера' },
    { ...order(), terminal_label: undefined },
    { ...xReport(), lines: [{ name: 'x', quantity: 1, total_minor: '1' }] },
    { ...xReport(), tenders: [{ method: 'cash', label: 'Наличные', amount_minor: '1' }] },
    JSON.parse('{"__proto__":{"polluted":true},"kind":"order"}'),
    Object.assign(Object.create(null), order()),
  ];
  for (const ticket of broken)
    assert.throws(() => parseTicket(ticket), /INVALID_TICKET/, JSON.stringify(ticket));
});

test('ESC/POS: exact bytes of an order ticket in PC866, then a partial cut', () => {
  assert.deepEqual(ESC.init, [0x1b, 0x40]);
  assert.deepEqual(ESC.codepage, [0x1b, 0x74, 17]);
  assert.deepEqual(ESC.cut, [0x1d, 0x56, 66, 0]);
  const rule = line('-'.repeat(W));
  const expected = [
    ...ESC.init,
    ...ESC.codepage,
    ...ESC.center,
    ...ESC.boldOn,
    ...line('Чек заказа (не фискальный)'),
    ...ESC.boldOff,
    ...ESC.left,
    ...ESC.center,
    ...ESC.double,
    ...line('Заказ №27'),
    ...ESC.normal,
    ...ESC.left,
    ...ESC.center,
    ...line('Забрать на выдаче'),
    ...ESC.left,
    ...rule,
    ...pair('2 x Чизбургер', '3 000 тг'),
    ...line('  + Без лука'),
    ...rule,
    ...ESC.boldOn,
    ...pair('Итого', '3 000 тг'),
    ...ESC.boldOff,
    ...pair('Наличные', '3 000 тг'),
    ...ESC.boldOn,
    ...pair('Сдача', '200 тг'),
    ...ESC.boldOff,
    ...rule,
    ...line('Касса 1'),
    ...line('19.11.2026 09:05'),
    0x0a,
    ...ESC.cut,
  ];
  assert.ok(!expected.includes(undefined), 'every expected character exists in PC866');
  assert.deepEqual([...escposBytes(parseTicket(order()))], expected);
  // No byte of the ticket can be a drawer pulse or a stray control command.
  const bytes = escposBytes(parseTicket(order()));
  assert.equal(bytes.indexOf(DRAWER_PULSE), -1);
  assert.deepEqual([...DRAWER_PULSE], [0x1b, 0x70, 0x00, 0x19, 0xfa]);
});

test('ESC/POS text: wrapping, money columns and characters PC866 lacks', () => {
  assert.deepEqual(encodeCp866('АЯапряЁё№·'), cp866('АЯапряЁё№·'));
  assert.deepEqual(encodeCp866('€'), [0x3f]);
  assert.equal(printable('Қазақстан 1 500 ₸ – «Әже»'), 'Казакстан 1 500 тг - "Аже"');
  const long = 'Большой семейный комбо с крыльями и картофелем фри';
  const lines = pairLines(long, '12 990 тг', W);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => l.length <= W));
  assert.ok(lines.at(-1).endsWith('12 990 тг'));
  const report = escposBytes(parseTicket(xReport()));
  const text = decoder.decode(report);
  assert.ok(text.includes('Наличные · 1' + ' '.repeat(W - 12 - 8) + '6 990 тг'));
  assert.ok(text.includes('Заказов: 1, отменено: 0'));
  assert.ok(text.indexOf('Ожидается в ящике') < text.indexOf('Заказов: 1'), 'money rows first');
});

test('Windows driver HTML: a static document, every text escaped', () => {
  const ticket = parseTicket({
    ...order(),
    title: '<script>alert(1)</script>',
    lines: [{ name: 'Соус "Сырный" & <b>', quantity: 1, total_minor: '50000' }],
  });
  const html = ticketHtml(ticket);
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('Соус &quot;Сырный&quot; &amp; &lt;b&gt;'));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes('Заказ №27'));
  assert.ok(html.includes('500 ₸'));
  assert.ok(!/\b(?:src|href)=/i.test(html), 'no external resource');
  assert.equal(ticketRows(ticket)[0].text, '<script>alert(1)</script>');
});

function printerServer() {
  const received = [];
  const server = createServer((socket) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      received.push(Buffer.concat(chunks));
      socket.end();
    });
  });
  return { server, received };
}
const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const eventually = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check());
};

test('escpos-tcp: one connection per ticket and per drawer pulse, exact bytes', async () => {
  const { server, received } = printerServer();
  const port = await listen(server);
  const connects = [];
  try {
    const printer = createPrinter({
      printer: validatePrinter({ mode: 'escpos-tcp', host: LAN_PRINTER, drawerKick: true }),
      connect: (options) => {
        connects.push(options);
        return createConnection({ host: '127.0.0.1', port });
      },
    });
    assert.deepEqual(await printer.print(order()), { state: 'sent' });
    assert.deepEqual(await printer.openDrawer(), { state: 'sent' });
    await eventually(() => received.length === 2);
    assert.deepEqual(received[0], escposBytes(parseTicket(order())));
    assert.deepEqual(received[1], DRAWER_PULSE);
    assert.deepEqual(connects, [
      { host: LAN_PRINTER, port: 9100 },
      { host: LAN_PRINTER, port: 9100 },
    ]);
    // Without a drawer on the printer's kick port, nothing is sent.
    const noDrawer = createPrinter({
      printer: validatePrinter({ mode: 'escpos-tcp', host: LAN_PRINTER }),
      connect: () => assert.fail('no connection for an unsupported drawer'),
    });
    assert.deepEqual(await noDrawer.openDrawer(), { state: 'unsupported' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A socket whose fate the test decides: connect or not, then flush, break or stall. */
function fakeSocket(sockets, { connects = true, after = 'flush' } = {}) {
  const socket = new EventEmitter();
  socket.written = [];
  socket.setTimeout = (ms) => (socket.timeout = ms);
  socket.destroy = () => (socket.destroyed = true);
  socket.end = (bytes, done) => {
    socket.written.push(Buffer.from(bytes));
    globalThis.setImmediate(() => {
      if (after === 'flush') done();
      else if (after === 'reset') socket.emit('error', new Error('ECONNRESET'));
      else if (after === 'stall') socket.emit('timeout');
      else if (after === 'close') socket.emit('close');
    });
  };
  globalThis.setImmediate(() =>
    connects ? socket.emit('connect') : socket.emit('error', new Error('ECONNREFUSED')),
  );
  sockets.push(socket);
  return socket;
}

test('a lost printer answer is unknown and is never sent again by itself', async () => {
  for (const [options, state] of [
    [{ after: 'flush' }, 'sent'],
    [{ after: 'reset' }, 'unknown'],
    [{ after: 'stall' }, 'unknown'],
    [{ after: 'close' }, 'unknown'],
    [{ connects: false }, 'failed'],
  ]) {
    const sockets = [];
    const printer = createPrinter({
      printer: validatePrinter({ mode: 'escpos-tcp', host: LAN_PRINTER, drawerKick: true }),
      connect: () => fakeSocket(sockets, options),
    });
    assert.deepEqual(await printer.print(order()), { state }, JSON.stringify(options));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sockets.length, 1, 'exactly one attempt: ' + JSON.stringify(options));
    assert.equal(sockets[0].written.length, options.connects === false ? 0 : 1);
    assert.ok(sockets[0].destroyed);
    assert.deepEqual(await printer.openDrawer(), { state });
    assert.equal(sockets.length, 2, 'the drawer pulse is one attempt as well');
  }
  // A real refused connection: one attempt, failed.
  const closed = createServer();
  const port = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  let attempts = 0;
  const printer = createPrinter({
    printer: validatePrinter({ mode: 'escpos-tcp', host: LAN_PRINTER }),
    connect: () => {
      attempts++;
      return createConnection({ host: '127.0.0.1', port });
    },
  });
  assert.deepEqual(await printer.print(order()), { state: 'failed' });
  assert.equal(attempts, 1);
  // sendOnce gives the socket its idle timeout.
  const sockets = [];
  await sendOnce({ host: LAN_PRINTER }, DRAWER_PULSE, {
    timeoutMs: 1234,
    connect: () => fakeSocket(sockets),
  });
  assert.equal(sockets[0].timeout, 1234);
});

test('windows-driver: the main process prints the HTML once; no answer is unknown', async () => {
  const jobs = [];
  let answer = async () => 'sent';
  const printer = createPrinter({
    printer: validatePrinter({ mode: 'windows-driver', deviceName: 'POS-80' }),
    printHtml: (job) => {
      jobs.push(job);
      return answer(job);
    },
    timeoutMs: 50,
  });
  assert.deepEqual(await printer.print(order()), { state: 'sent' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].deviceName, 'POS-80');
  assert.equal(jobs[0].html, ticketHtml(parseTicket(order())));
  assert.ok(Number.isInteger(jobs[0].heightMicrons) && jobs[0].heightMicrons >= 60000);
  for (const [next, state] of [
    [async () => 'failed', 'failed'],
    [async () => 'printed', 'unknown'],
    [async () => Promise.reject(new Error('gone')), 'unknown'],
    [() => new Promise(() => {}), 'unknown'],
  ]) {
    answer = next;
    const before = jobs.length;
    assert.deepEqual(await printer.print(order()), { state });
    assert.equal(jobs.length, before + 1, 'one job per tap');
  }
  answer = async () => 'sent';
  assert.deepEqual(await printer.openDrawer(), { state: 'unsupported' });
  assert.deepEqual(await printer.print({ ...order(), kind: 'html' }), {
    state: 'failed',
    code: 'INVALID_TICKET',
  });
  const before = jobs.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(jobs.length, before, 'nothing is printed again later');
});

test('jobs print one at a time; a fourth waiting job is refused, not queued forever', async () => {
  const order_ = [];
  const releases = [];
  const printer = createPrinter({
    printer: validatePrinter({ mode: 'windows-driver', deviceName: 'POS-80' }),
    printHtml: () =>
      new Promise((resolve) => {
        order_.push('start');
        releases.push(() => {
          order_.push('end');
          resolve('sent');
        });
      }),
  });
  const first = printer.print(order());
  const second = printer.print(xReport());
  const third = printer.print(order());
  assert.deepEqual(await printer.print(order()), { state: 'failed', code: 'PRINTER_BUSY' });
  await eventually(() => releases.length === 1);
  releases[0]();
  await eventually(() => releases.length === 2);
  releases[1]();
  await eventually(() => releases.length === 3);
  releases[2]();
  assert.deepEqual(await Promise.all([first, second, third]), [
    { state: 'sent' },
    { state: 'sent' },
    { state: 'sent' },
  ]);
  assert.deepEqual(order_, ['start', 'end', 'start', 'end', 'start', 'end']);
});

test('no printer: "not configured" for print and drawer; IPC messages are exact', async () => {
  const none = createPrinter({ printer: undefined });
  assert.deepEqual(await none.print(order()), { state: 'not_configured' });
  assert.deepEqual(await none.openDrawer(), { state: 'not_configured' });
  const jobs = [];
  const printer = createPrinter({
    printer: validatePrinter({ mode: 'windows-driver', deviceName: 'POS-80' }),
    printHtml: async (job) => {
      jobs.push(job);
      return 'sent';
    },
  });
  assert.deepEqual(await printer.handle({ operation: 'print', ticket: order() }), {
    state: 'sent',
  });
  assert.deepEqual(await printer.handle({ operation: 'drawer' }), { state: 'unsupported' });
  for (const message of [
    null,
    'print',
    [],
    { operation: 'print' },
    { operation: 'print', ticket: order(), deviceName: 'Другой принтер' },
    { operation: 'drawer', pulse: [27, 112] },
    { operation: 'raw', bytes: [27, 64] },
  ])
    assert.deepEqual(
      await printer.handle(message),
      { state: 'failed', code: 'INVALID_REQUEST' },
      JSON.stringify(message),
    );
  assert.equal(jobs.length, 1);
});
