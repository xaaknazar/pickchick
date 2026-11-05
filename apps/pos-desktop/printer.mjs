import { createConnection, isIP } from 'node:net';

// Cutover 19.11, CL-3 (contracts section 5.8, design КС4): non-fiscal tickets and the cash drawer
// of this desk, printed by the main process only. The renderer sends typed JSON; the paper is
// built here. A printer answer that is lost is `unknown` and is never printed again on its own.

const METHODS = [
  'cash',
  'kaspi_terminal',
  'kaspi_manual',
  'aggregator_yandex_eda',
  'aggregator_glovo',
  'chocofood',
  'staff_meal',
  'marketing',
];
export const TICKET_KINDS = ['order', 'x_report', 'z_report', 'refund'];
const MONEY = /^(0|[1-9][0-9]{0,17})$/;
const DISPLAY_NUMBER = /^[1-9][0-9]{0,18}$/;
/** Characters per line of the ESC/POS layout: Font A of an 80 mm printer has 48, so 42 leaves a
 *  margin. The printer model is not known yet (КД6); a 58 mm printer would wrap long lines. */
export const ESCPOS_COLUMNS = 42;
export const ESC = Object.freeze({
  init: [0x1b, 0x40],
  // ESC t 17: PC866 Cyrillic on Epson-compatible printers.
  codepage: [0x1b, 0x74, 0x11],
  left: [0x1b, 0x61, 0x00],
  center: [0x1b, 0x61, 0x01],
  boldOn: [0x1b, 0x45, 0x01],
  boldOff: [0x1b, 0x45, 0x00],
  double: [0x1d, 0x21, 0x11],
  normal: [0x1d, 0x21, 0x00],
  // GS V 66 0: feed to the cutter and cut partially.
  cut: [0x1d, 0x56, 0x42, 0x00],
  // ESC p 0 25 250: pulse on drawer pin 2 for 50 ms, then 500 ms off.
  drawer: [0x1b, 0x70, 0x00, 0x19, 0xfa],
});
export const DRAWER_PULSE = Buffer.from(ESC.drawer);

const plain = (value) =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
function text(value, max, min = 1) {
  if (typeof value !== 'string' || CONTROL.test(value)) throw new Error('INVALID_TICKET');
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new Error('INVALID_TICKET');
  return trimmed;
}
function money(value) {
  if (typeof value !== 'string' || !MONEY.test(value)) throw new Error('INVALID_TICKET');
  return value;
}
function count(value, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error('INVALID_TICKET');
  return value;
}
function keys(value, required, optional = []) {
  if (!plain(value)) throw new Error('INVALID_TICKET');
  const names = Object.keys(value);
  if (
    required.some((key) => !names.includes(key)) ||
    names.some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error('INVALID_TICKET');
}
function list(value, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new Error('INVALID_TICKET');
  return value;
}
const method = (value) => {
  if (!METHODS.includes(value)) throw new Error('INVALID_TICKET');
  return value;
};

export function privateIPv4(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The `printer` key of config.json (contracts sections 5.8 and 6.1). Absent: printing is not
 * configured and the desk sells exactly as before.
 *   {mode:'windows-driver', deviceName}            the Windows printer queue of this desk
 *   {mode:'escpos-tcp', host, port?, drawerKick?}  a LAN printer at a private IPv4; the port is
 *                                                  9100 only (section 5.8 pins it; absent: 9100)
 */
export function validatePrinter(value) {
  if (value === undefined) return undefined;
  try {
    if (!plain(value)) throw new Error();
    if (value.mode === 'windows-driver') {
      keys(value, ['mode', 'deviceName']);
      return Object.freeze({ mode: value.mode, deviceName: text(value.deviceName, 200) });
    }
    if (value.mode === 'escpos-tcp') {
      keys(value, ['mode', 'host'], ['port', 'drawerKick']);
      const { host, port = 9100, drawerKick = false } = value;
      if (!privateIPv4(host) || port !== 9100 || typeof drawerKick !== 'boolean') throw new Error();
      return Object.freeze({ mode: value.mode, host, port, drawerKick });
    }
    throw new Error();
  } catch {
    throw new Error('INVALID_POS_CONFIG');
  }
}

const itemKind = (kind) => kind === 'order' || kind === 'refund';
/**
 * PosTicket (contracts section 5.8), strictly. Amounts are strings of tiyn. Order and refund
 * tickets carry item lines and tender amounts; X/Z reports carry text lines and method rows, as
 * apps/pos/src/v2/ops-view.js builds them. Anything else is INVALID_TICKET and is not printed.
 */
export function parseTicket(value) {
  keys(
    value,
    ['kind', 'title', 'totals', 'printed_at', 'terminal_label'],
    ['display_number', 'pickup_text', 'lines', 'tenders', 'change_minor'],
  );
  if (!TICKET_KINDS.includes(value.kind)) throw new Error('INVALID_TICKET');
  const items = itemKind(value.kind);
  if (typeof value.printed_at !== 'string' || value.printed_at.length > 40)
    throw new Error('INVALID_TICKET');
  if (!/^\d{4}-\d\d-\d\dT/.test(value.printed_at) || !Number.isFinite(Date.parse(value.printed_at)))
    throw new Error('INVALID_TICKET');
  if (
    value.display_number !== undefined &&
    (typeof value.display_number !== 'string' || !DISPLAY_NUMBER.test(value.display_number))
  )
    throw new Error('INVALID_TICKET');
  const ticket = {
    kind: value.kind,
    title: text(value.title, 80),
    ...(value.display_number === undefined ? {} : { display_number: value.display_number }),
    ...(value.pickup_text === undefined ? {} : { pickup_text: text(value.pickup_text, 160) }),
    lines: list(value.lines ?? [], items ? 60 : 30).map((line) => {
      if (!items) return text(line, 200);
      keys(line, ['name', 'quantity', 'total_minor'], ['options']);
      if (count(line.quantity, 99) < 1) throw new Error('INVALID_TICKET');
      return {
        name: text(line.name, 300),
        quantity: line.quantity,
        total_minor: money(line.total_minor),
        options: list(line.options ?? [], 30).map((option) => text(option, 300)),
      };
    }),
    totals: list(value.totals, 20, 1).map((total) => {
      keys(total, ['label', 'amount_minor']);
      return { label: text(total.label, 60), amount_minor: money(total.amount_minor) };
    }),
    tenders: list(value.tenders ?? [], 10).map((tender) => {
      if (items) {
        keys(tender, ['method', 'label', 'amount_minor']);
        return {
          method: method(tender.method),
          label: text(tender.label, 60),
          amount_minor: money(tender.amount_minor),
        };
      }
      keys(tender, ['method', 'label', 'sales_minor', 'refunds_minor', 'count']);
      return {
        method: method(tender.method),
        label: text(tender.label, 60),
        sales_minor: money(tender.sales_minor),
        refunds_minor: money(tender.refunds_minor),
        count: count(tender.count, 1_000_000),
      };
    }),
    ...(value.change_minor === undefined ? {} : { change_minor: money(value.change_minor) }),
    printed_at: value.printed_at,
    terminal_label: text(value.terminal_label, 120),
  };
  return ticket;
}

/** "6 990 ₸", "6 990,50 ₸": the cashier's own money format (apps/pos/src/types.ts money). */
export function tenge(minor) {
  const amount = BigInt(minor);
  const whole = (amount / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${whole}${amount % 100n ? `,${(amount % 100n).toString().padStart(2, '0')}` : ''} ₸`;
}
/** dd.mm.yyyy hh:mm in the branch time zone. */
export function printedAt(value) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Asia/Almaty',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
}

/**
 * The paper, independent of the printer: rows of one ticket in print order. Order and refund
 * tickets: number, pickup, items, totals, tenders, change. Reports: money rows, methods, notes.
 */
export function ticketRows(ticket) {
  const rows = [{ type: 'title', text: ticket.title }];
  if (ticket.display_number) rows.push({ type: 'big', text: `Заказ №${ticket.display_number}` });
  if (ticket.pickup_text) rows.push({ type: 'center', text: ticket.pickup_text });
  rows.push({ type: 'rule' });
  const totals = ticket.totals.map((t) => ({
    type: 'pair',
    left: t.label,
    right: tenge(t.amount_minor),
    bold: itemKind(ticket.kind),
  }));
  if (itemKind(ticket.kind)) {
    for (const line of ticket.lines) {
      rows.push({
        type: 'pair',
        left: `${line.quantity} × ${line.name}`,
        right: tenge(line.total_minor),
      });
      for (const option of line.options) rows.push({ type: 'text', text: `  + ${option}` });
    }
    if (ticket.lines.length) rows.push({ type: 'rule' });
    rows.push(...totals);
    for (const tender of ticket.tenders)
      rows.push({ type: 'pair', left: tender.label, right: tenge(tender.amount_minor) });
    if (ticket.change_minor !== undefined)
      rows.push({ type: 'pair', left: 'Сдача', right: tenge(ticket.change_minor), bold: true });
  } else {
    rows.push(...totals);
    if (ticket.tenders.length) rows.push({ type: 'rule' });
    for (const tender of ticket.tenders)
      rows.push({
        type: 'pair',
        left: `${tender.label} · ${tender.count}`,
        right:
          tenge(tender.sales_minor) +
          (tender.refunds_minor === '0' ? '' : ' / -' + tenge(tender.refunds_minor)),
      });
    if (ticket.lines.length) rows.push({ type: 'rule' });
    for (const line of ticket.lines) rows.push({ type: 'text', text: line });
  }
  rows.push({ type: 'rule' });
  rows.push({ type: 'text', text: ticket.terminal_label });
  rows.push({ type: 'text', text: printedAt(ticket.printed_at) });
  return rows;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
/** Approximate printed height of a ticket in microns, for the driver's custom page size. */
export const ticketHeightMicrons = (rows) => Math.max(60_000, 20_000 + rows.length * 5_000);
/**
 * The HTML of a ticket for the Windows driver: a static document with every text escaped, no
 * script, no external resource (the print window also blocks every request).
 */
export function ticketHtml(ticket) {
  const body = ticketRows(ticket)
    .map((row) => {
      if (row.type === 'rule') return '<hr>';
      if (row.type === 'pair')
        return `<div class="pair${row.bold ? ' bold' : ''}"><span>${escapeHtml(row.left)}</span><b>${escapeHtml(row.right)}</b></div>`;
      return `<div class="${row.type}">${escapeHtml(row.text)}</div>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(ticket.title)}</title>
<style>
@page { margin: 0; }
body { margin: 0; padding: 2mm 3mm; width: 72mm; font: 11pt/1.3 Arial, sans-serif; color: #000; }
.title, .center, .big { text-align: center; }
.title { font-weight: bold; }
.big { font-size: 20pt; font-weight: bold; margin: 1mm 0; }
.pair { display: flex; justify-content: space-between; gap: 2mm; }
.pair b { font-weight: normal; white-space: nowrap; }
.pair.bold, .pair.bold b { font-weight: bold; }
hr { border: 0; border-top: 1px dashed #000; margin: 1.5mm 0; }
</style></head>
<body>
${body}
</body></html>
`;
}

// ---- ESC/POS ----------------------------------------------------------------------------------

const KAZAKH = {
  Ә: 'А',
  ә: 'а',
  Ғ: 'Г',
  ғ: 'г',
  Қ: 'К',
  қ: 'к',
  Ң: 'Н',
  ң: 'н',
  Ө: 'О',
  ө: 'о',
  Ұ: 'У',
  ұ: 'у',
  Ү: 'У',
  ү: 'у',
  Һ: 'Х',
  һ: 'х',
  І: 'I',
  і: 'i',
};
const SPELLED = {
  '₸': 'тг',
  '×': 'x',
  '–': '-',
  '—': '-',
  '−': '-',
  '«': '"',
  '»': '"',
  '„': '"',
  '“': '"',
  '”': '"',
  '’': "'",
  '…': '...',
  '\u00a0': ' ',
  '\u202f': ' ',
};
/** Text a PC866 printer can show: Kazakh letters, the tenge sign and typography spelled out. */
export function printable(value) {
  return [...value].map((c) => KAZAKH[c] ?? SPELLED[c] ?? c).join('');
}
const CP866_EXTRA = { Ё: 0xf0, ё: 0xf1, '°': 0xf8, '·': 0xfa, '№': 0xfc };
/** One byte per character of printable(text); anything outside PC866 becomes '?'. */
export function encodeCp866(value) {
  const bytes = [];
  for (const c of value) {
    const code = c.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) bytes.push(code);
    else if (code >= 0x410 && code <= 0x42f) bytes.push(code - 0x410 + 0x80);
    else if (code >= 0x430 && code <= 0x43f) bytes.push(code - 0x430 + 0xa0);
    else if (code >= 0x440 && code <= 0x44f) bytes.push(code - 0x440 + 0xe0);
    else bytes.push(CP866_EXTRA[c] ?? 0x3f);
  }
  return bytes;
}
/** Word wrap to `width` characters, keeping a leading indent; a word longer than a line is cut. */
export function wrap(value, width) {
  const indent = /^ */.exec(value)[0].slice(0, width - 1);
  const room = width - indent.length;
  const lines = [];
  let line = '';
  for (const word of value.slice(indent.length).split(' ').filter(Boolean)) {
    let rest = word;
    while (rest.length > room) {
      if (line) lines.push(line);
      line = '';
      lines.push(rest.slice(0, room));
      rest = rest.slice(room);
    }
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= room) line += ' ' + rest;
    else {
      lines.push(line);
      line = rest;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines.map((l) => indent + l);
}
/** "Left ... Right" on one line, or the left text wrapped with the amount right-aligned under it. */
export function pairLines(left, right, width) {
  if (left.length + 1 + right.length <= width)
    return [left + ' '.repeat(width - left.length - right.length) + right];
  const lines = wrap(left, width);
  const last = lines.at(-1);
  if (last.length + 1 + right.length <= width)
    lines[lines.length - 1] = last + ' '.repeat(width - last.length - right.length) + right;
  else lines.push(' '.repeat(Math.max(0, width - right.length)) + right.slice(0, width));
  return lines;
}
/** The exact bytes of one ticket for an ESC/POS printer (PC866, 42 columns, partial cut). */
export function escposBytes(ticket, width = ESCPOS_COLUMNS) {
  const out = [...ESC.init, ...ESC.codepage];
  const line = (value) => out.push(...encodeCp866(value), 0x0a);
  for (const row of ticketRows(ticket)) {
    if (row.type === 'rule') {
      line('-'.repeat(width));
      continue;
    }
    if (row.type === 'pair') {
      if (row.bold) out.push(...ESC.boldOn);
      for (const l of pairLines(printable(row.left), printable(row.right), width)) line(l);
      if (row.bold) out.push(...ESC.boldOff);
      continue;
    }
    const value = printable(row.text);
    if (row.type === 'title') {
      out.push(...ESC.center, ...ESC.boldOn);
      for (const l of wrap(value, width)) line(l);
      out.push(...ESC.boldOff, ...ESC.left);
    } else if (row.type === 'big') {
      out.push(...ESC.center, ...ESC.double);
      for (const l of wrap(value, Math.floor(width / 2))) line(l);
      out.push(...ESC.normal, ...ESC.left);
    } else if (row.type === 'center') {
      out.push(...ESC.center);
      for (const l of wrap(value, width)) line(l);
      out.push(...ESC.left);
    } else for (const l of wrap(value, width)) line(l);
  }
  out.push(0x0a, ...ESC.cut);
  return Buffer.from(out);
}

/**
 * Exactly one connection and one write (tools/photo-printer/transport.mjs:9-29). 'failed': the
 * printer was never reached; 'sent': every byte left this computer; 'unknown': the connection
 * broke or stalled after the write began. Never retried here.
 */
export function sendOnce({ host, port = 9100 }, bytes, { timeoutMs = 8000, connect } = {}) {
  return new Promise((resolve) => {
    let attempted = false;
    let settled = false;
    let socket;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(state);
    };
    try {
      socket = (connect ?? createConnection)({ host, port });
    } catch {
      finish('failed');
      return;
    }
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      attempted = true;
      socket.end(bytes, () => finish('sent'));
    });
    socket.once('timeout', () => finish(attempted ? 'unknown' : 'failed'));
    socket.once('error', () => finish(attempted ? 'unknown' : 'failed'));
    socket.once('close', () => finish(attempted ? 'unknown' : 'failed'));
  });
}

const RESULT_STATES = ['sent', 'failed', 'unknown'];
/**
 * The printer of this desk. `printHtml({html, deviceName, heightMicrons})` is the main process's
 * hidden-window print (Windows driver) and answers 'sent' | 'failed' | 'unknown'; a throw or no
 * answer within timeoutMs is 'unknown'. Jobs run one at a time, in order; a fourth waiting job is
 * refused as busy. Results: {state:'sent'|'failed'|'unknown'|'not_configured'|'unsupported', code?}.
 */
export function createPrinter({ printer, printHtml, connect, timeoutMs = 20000 } = {}) {
  let queue = Promise.resolve();
  let waiting = 0;
  const serial = (job) => {
    if (waiting >= 3) return Promise.resolve({ state: 'failed', code: 'PRINTER_BUSY' });
    waiting++;
    const run = queue.then(job).finally(() => waiting--);
    queue = run.catch(() => {});
    return run;
  };
  const bounded = (work) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve('unknown'), timeoutMs);
      Promise.resolve()
        .then(work)
        .then(
          (state) => resolve(RESULT_STATES.includes(state) ? state : 'unknown'),
          () => resolve('unknown'),
        )
        .finally(() => clearTimeout(timer));
    });
  const api = {
    async print(value) {
      let ticket;
      try {
        ticket = parseTicket(value);
      } catch {
        return { state: 'failed', code: 'INVALID_TICKET' };
      }
      if (!printer) return { state: 'not_configured' };
      return serial(async () => {
        if (printer.mode === 'escpos-tcp')
          return { state: await sendOnce(printer, escposBytes(ticket), { connect }) };
        const html = ticketHtml(ticket);
        const heightMicrons = ticketHeightMicrons(ticketRows(ticket));
        return {
          state: await bounded(() =>
            printHtml({ html, deviceName: printer.deviceName, heightMicrons }),
          ),
        };
      });
    },
    /** ESC p through an ESC/POS printer with a drawer on its kick port; nothing else can. */
    async openDrawer() {
      if (!printer) return { state: 'not_configured' };
      if (printer.mode !== 'escpos-tcp' || !printer.drawerKick) return { state: 'unsupported' };
      return serial(async () => ({
        state: await sendOnce(printer, DRAWER_PULSE, { connect }),
      }));
    },
    /** One IPC message of the renderer: {operation:'print', ticket} or {operation:'drawer'}. */
    handle(message) {
      if (plain(message) && message.operation === 'drawer' && Object.keys(message).length === 1)
        return api.openDrawer();
      if (
        plain(message) &&
        message.operation === 'print' &&
        Object.keys(message).length === 2 &&
        'ticket' in message
      )
        return api.print(message.ticket);
      return Promise.resolve({ state: 'failed', code: 'INVALID_REQUEST' });
    },
  };
  return api;
}
