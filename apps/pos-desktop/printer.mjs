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
export const TICKET_KINDS = ['order', 'x_report', 'z_report', 'refund', 'fiscal'];
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
/**
 * Fiscal receipt (automatic Webkassa, packages/local-orders webkassa-fiscal.ts): the print form
 * Webkassa made, line by line as it is (48 columns of an 80 mm printer, spaces kept), Style 1
 * bold, Type 2 the receipt link drawn as the QR matrix the point server computed.
 */
function parseReceipt(value) {
  keys(
    value,
    ['display_number', 'lines'],
    ['pickup_text', 'comment', 'cashier', 'cash_tendered_minor', 'change_minor'],
  );
  return {
    display_number: text(value.display_number, 12),
    lines: list(value.lines, 100).map((line) => {
      keys(line, ['name', 'options']);
      return {
        name: text(line.name, 160),
        options: list(line.options, 30).map((option) => text(option, 120)),
      };
    }),
    ...(value.pickup_text === undefined ? {} : { pickup_text: text(value.pickup_text, 120) }),
    ...(value.comment === undefined ? {} : { comment: text(value.comment, 120) }),
    ...(value.cashier === undefined ? {} : { cashier: text(value.cashier, 40) }),
    ...(value.cash_tendered_minor === undefined
      ? {}
      : { cash_tendered_minor: money(value.cash_tendered_minor) }),
    ...(value.change_minor === undefined ? {} : { change_minor: money(value.change_minor) }),
  };
}
function parseFiscal(value) {
  keys(value, ['kind', 'fiscal_lines', 'printed_at', 'terminal_label'], ['receipt']);
  if (typeof value.printed_at !== 'string' || !Number.isFinite(Date.parse(value.printed_at)))
    throw new Error('INVALID_TICKET');
  const lines = list(value.fiscal_lines, 400, 1).map((line) => {
    keys(line, ['type', 'value', 'style'], ['qr']);
    if (![0, 2].includes(line.type) || ![0, 1].includes(line.style))
      throw new Error('INVALID_TICKET');
    if (typeof line.value !== 'string' || line.value.length > 600 || CONTROL.test(line.value))
      throw new Error('INVALID_TICKET');
    if (line.type === 0)
      return { type: 0, value: line.value.replace(/\s+$/, ''), style: line.style };
    const qr = list(line.qr, 177, 21);
    if (qr.some((row) => typeof row !== 'string' || row.length !== qr.length || /[^01]/.test(row)))
      throw new Error('INVALID_TICKET');
    if (!/^https?:\/\/\S+$/.test(line.value)) throw new Error('INVALID_TICKET');
    return { type: 2, value: line.value, style: 0, qr };
  });
  return {
    kind: 'fiscal',
    title: 'Фискальный чек',
    fiscal_lines: lines,
    ...(value.receipt === undefined ? {} : { receipt: parseReceipt(value.receipt) }),
    printed_at: value.printed_at,
    terminal_label: text(value.terminal_label, 120),
  };
}

export function parseTicket(value) {
  if (plain(value) && value.kind === 'fiscal') return parseFiscal(value);
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
 * PickChick logo for thermal paper: the badge in black as an inline SVG path (the print window
 * loads no images), traced from apps/pos/src/v2/assets/logo.png at 220 x 202 dots.
 */
export const RECEIPT_LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 202" width="30mm" shape-rendering="crispEdges"><path fill="#000" d="M156 3h14v1h-14zM154 4h21v1h-21zM153 5h25v1h-25zM151 6h30v1h-30zM150 7h33v1h-33zM149 8h35v1h-35zM148 9h38v1h-38zM147 10h40v1h-40zM147 11h41v1h-41zM146 12h43v1h-43zM145 13h47v1h-47zM145 14h16v1h-16zM162 14h32v1h-32zM144 15h16v1h-16zM165 15h31v1h-31zM144 16h17v1h-17zM167 16h30v1h-30zM143 17h18v1h-18zM168 17h6v1h-6zM177 17h21v1h-21zM143 18h19v1h-19zM169 18h5v1h-5zM178 18h21v1h-21zM127 19h11v1h-11zM142 19h20v1h-20zM170 19h5v1h-5zM179 19h21v1h-21zM122 20h19v1h-19zM142 20h21v1h-21zM171 20h4v1h-4zM180 20h21v1h-21zM118 21h45v1h-45zM172 21h3v1h-3zM181 21h21v1h-21zM112 22h51v1h-51zM172 22h3v1h-3zM181 22h21v1h-21zM106 23h49v1h-49zM156 23h7v1h-7zM172 23h3v1h-3zM182 23h21v1h-21zM99 24h55v1h-55zM158 24h4v1h-4zM172 24h2v1h-2zM182 24h4v1h-4zM188 24h15v1h-15zM93 25h62v1h-62zM159 25h3v1h-3zM172 25h2v1h-2zM182 25h4v1h-4zM188 25h15v1h-15zM86 26h69v1h-69zM160 26h2v1h-2zM172 26h1v1h-1zM182 26h3v1h-3zM189 26h15v1h-15zM80 27h75v1h-75zM182 27h2v1h-2zM189 27h15v1h-15zM73 28h82v1h-82zM182 28h2v1h-2zM190 28h14v1h-14zM67 29h88v1h-88zM181 29h2v1h-2zM190 29h14v1h-14zM61 30h71v1h-71zM134 30h21v1h-21zM190 30h15v1h-15zM54 31h73v1h-73zM135 31h20v1h-20zM189 31h2v1h-2zM193 31h12v1h-12zM47 32h75v1h-75zM135 32h20v1h-20zM193 32h12v1h-12zM41 33h80v1h-80zM134 33h20v1h-20zM193 33h12v1h-12zM34 34h86v1h-86zM134 34h20v1h-20zM193 34h12v1h-12zM26 35h80v1h-80zM114 35h6v1h-6zM134 35h20v1h-20zM192 35h13v1h-13zM17 36h84v1h-84zM114 36h6v1h-6zM133 36h21v1h-21zM192 36h12v1h-12zM12 37h82v1h-82zM97 37h4v1h-4zM114 37h5v1h-5zM133 37h21v1h-21zM187 37h2v1h-2zM190 37h14v1h-14zM9 38h78v1h-78zM97 38h4v1h-4zM114 38h5v1h-5zM133 38h22v1h-22zM188 38h16v1h-16zM8 39h72v1h-72zM97 39h4v1h-4zM114 39h5v1h-5zM132 39h23v1h-23zM189 39h15v1h-15zM7 40h68v1h-68zM98 40h3v1h-3zM114 40h4v1h-4zM132 40h24v1h-24zM190 40h15v1h-15zM6 41h67v1h-67zM98 41h3v1h-3zM114 41h4v1h-4zM132 41h22v1h-22zM155 41h1v1h-1zM191 41h14v1h-14zM5 42h67v1h-67zM98 42h3v1h-3zM114 42h4v1h-4zM131 42h22v1h-22zM192 42h14v1h-14zM5 43h51v1h-51zM64 43h7v1h-7zM98 43h3v1h-3zM114 43h4v1h-4zM131 43h22v1h-22zM192 43h15v1h-15zM4 44h47v1h-47zM64 44h6v1h-6zM98 44h3v1h-3zM114 44h3v1h-3zM131 44h12v1h-12zM150 44h4v1h-4zM177 44h11v1h-11zM193 44h14v1h-14zM4 45h38v1h-38zM47 45h3v1h-3zM64 45h6v1h-6zM98 45h3v1h-3zM114 45h3v1h-3zM130 45h13v1h-13zM150 45h2v1h-2zM153 45h4v1h-4zM161 45h29v1h-29zM194 45h14v1h-14zM3 46h30v1h-30zM48 46h2v1h-2zM64 46h5v1h-5zM98 46h3v1h-3zM114 46h3v1h-3zM130 46h13v1h-13zM149 46h1v1h-1zM154 46h17v1h-17zM173 46h2v1h-2zM178 46h6v1h-6zM188 46h2v1h-2zM194 46h15v1h-15zM3 47h21v1h-21zM48 47h2v1h-2zM64 47h4v1h-4zM98 47h3v1h-3zM114 47h2v1h-2zM130 47h13v1h-13zM148 47h1v1h-1zM152 47h18v1h-18zM173 47h1v1h-1zM178 47h3v1h-3zM189 47h2v1h-2zM195 47h15v1h-15zM3 48h13v1h-13zM48 48h2v1h-2zM64 48h4v1h-4zM98 48h3v1h-3zM114 48h2v1h-2zM129 48h13v1h-13zM146 48h2v1h-2zM151 48h8v1h-8zM160 48h9v1h-9zM172 48h1v1h-1zM177 48h4v1h-4zM190 48h1v1h-1zM196 48h14v1h-14zM3 49h12v1h-12zM48 49h2v1h-2zM64 49h4v1h-4zM98 49h3v1h-3zM114 49h2v1h-2zM129 49h13v1h-13zM145 49h2v1h-2zM150 49h8v1h-8zM160 49h8v1h-8zM171 49h1v1h-1zM176 49h5v1h-5zM196 49h15v1h-15zM3 50h12v1h-12zM48 50h2v1h-2zM64 50h4v1h-4zM98 50h3v1h-3zM114 50h2v1h-2zM129 50h14v1h-14zM144 50h1v1h-1zM149 50h9v1h-9zM161 50h5v1h-5zM169 50h2v1h-2zM175 50h6v1h-6zM197 50h15v1h-15zM3 51h12v1h-12zM48 51h2v1h-2zM64 51h4v1h-4zM84 51h1v1h-1zM98 51h3v1h-3zM114 51h1v1h-1zM128 51h16v1h-16zM147 51h10v1h-10zM161 51h4v1h-4zM168 51h2v1h-2zM174 51h7v1h-7zM198 51h14v1h-14zM3 52h12v1h-12zM48 52h2v1h-2zM64 52h4v1h-4zM81 52h5v1h-5zM98 52h3v1h-3zM114 52h1v1h-1zM128 52h15v1h-15zM146 52h11v1h-11zM161 52h3v1h-3zM167 52h2v1h-2zM173 52h7v1h-7zM198 52h15v1h-15zM3 53h12v1h-12zM48 53h2v1h-2zM64 53h4v1h-4zM81 53h5v1h-5zM98 53h3v1h-3zM114 53h1v1h-1zM128 53h29v1h-29zM162 53h1v1h-1zM166 53h1v1h-1zM172 53h8v1h-8zM199 53h14v1h-14zM3 54h12v1h-12zM48 54h2v1h-2zM64 54h4v1h-4zM81 54h5v1h-5zM98 54h3v1h-3zM114 54h1v1h-1zM127 54h29v1h-29zM162 54h1v1h-1zM165 54h1v1h-1zM171 54h9v1h-9zM199 54h15v1h-15zM3 55h12v1h-12zM48 55h2v1h-2zM64 55h4v1h-4zM81 55h5v1h-5zM98 55h3v1h-3zM127 55h31v1h-31zM163 55h2v1h-2zM169 55h10v1h-10zM200 55h14v1h-14zM3 56h12v1h-12zM48 56h2v1h-2zM64 56h4v1h-4zM81 56h5v1h-5zM97 56h4v1h-4zM127 56h33v1h-33zM163 56h2v1h-2zM168 56h10v1h-10zM200 56h15v1h-15zM3 57h12v1h-12zM48 57h2v1h-2zM64 57h4v1h-4zM81 57h5v1h-5zM97 57h4v1h-4zM126 57h25v1h-25zM159 57h2v1h-2zM165 57h12v1h-12zM201 57h14v1h-14zM3 58h12v1h-12zM48 58h2v1h-2zM64 58h4v1h-4zM81 58h5v1h-5zM95 58h6v1h-6zM126 58h21v1h-21zM160 58h2v1h-2zM166 58h10v1h-10zM201 58h15v1h-15zM3 59h12v1h-12zM29 59h5v1h-5zM48 59h2v1h-2zM64 59h4v1h-4zM81 59h5v1h-5zM93 59h8v1h-8zM126 59h16v1h-16zM161 59h2v1h-2zM169 59h4v1h-4zM202 59h14v1h-14zM3 60h12v1h-12zM29 60h5v1h-5zM48 60h2v1h-2zM64 60h4v1h-4zM81 60h5v1h-5zM90 60h11v1h-11zM126 60h12v1h-12zM162 60h2v1h-2zM198 60h1v1h-1zM201 60h15v1h-15zM3 61h12v1h-12zM29 61h5v1h-5zM48 61h2v1h-2zM64 61h4v1h-4zM82 61h5v1h-5zM88 61h13v1h-13zM126 61h10v1h-10zM163 61h2v1h-2zM198 61h18v1h-18zM3 62h12v1h-12zM29 62h5v1h-5zM48 62h3v1h-3zM65 62h3v1h-3zM82 62h19v1h-19zM126 62h11v1h-11zM162 62h2v1h-2zM199 62h18v1h-18zM3 63h12v1h-12zM29 63h5v1h-5zM48 63h3v1h-3zM65 63h3v1h-3zM82 63h19v1h-19zM127 63h11v1h-11zM159 63h5v1h-5zM200 63h17v1h-17zM3 64h12v1h-12zM29 64h5v1h-5zM47 64h4v1h-4zM65 64h3v1h-3zM82 64h19v1h-19zM128 64h12v1h-12zM150 64h9v1h-9zM162 64h2v1h-2zM201 64h16v1h-16zM3 65h12v1h-12zM29 65h5v1h-5zM48 65h3v1h-3zM65 65h3v1h-3zM82 65h19v1h-19zM128 65h14v1h-14zM161 65h4v1h-4zM202 65h15v1h-15zM3 66h12v1h-12zM29 66h5v1h-5zM48 66h3v1h-3zM65 66h3v1h-3zM82 66h19v1h-19zM129 66h15v1h-15zM159 66h7v1h-7zM203 66h14v1h-14zM3 67h12v1h-12zM29 67h5v1h-5zM48 67h3v1h-3zM65 67h3v1h-3zM82 67h19v1h-19zM129 67h19v1h-19zM157 67h10v1h-10zM203 67h14v1h-14zM3 68h12v1h-12zM29 68h5v1h-5zM48 68h3v1h-3zM65 68h3v1h-3zM82 68h19v1h-19zM130 68h38v1h-38zM194 68h2v1h-2zM204 68h13v1h-13zM3 69h12v1h-12zM29 69h5v1h-5zM48 69h3v1h-3zM65 69h3v1h-3zM82 69h19v1h-19zM130 69h19v1h-19zM153 69h16v1h-16zM195 69h3v1h-3zM204 69h13v1h-13zM3 70h12v1h-12zM29 70h5v1h-5zM48 70h3v1h-3zM65 70h3v1h-3zM82 70h19v1h-19zM131 70h17v1h-17zM153 70h8v1h-8zM163 70h6v1h-6zM195 70h5v1h-5zM205 70h12v1h-12zM3 71h12v1h-12zM29 71h5v1h-5zM48 71h3v1h-3zM65 71h3v1h-3zM82 71h19v1h-19zM131 71h17v1h-17zM153 71h8v1h-8zM163 71h6v1h-6zM195 71h22v1h-22zM3 72h12v1h-12zM29 72h5v1h-5zM48 72h3v1h-3zM65 72h3v1h-3zM82 72h19v1h-19zM132 72h15v1h-15zM153 72h8v1h-8zM163 72h6v1h-6zM186 72h1v1h-1zM195 72h22v1h-22zM3 73h12v1h-12zM29 73h5v1h-5zM48 73h3v1h-3zM65 73h3v1h-3zM82 73h19v1h-19zM132 73h15v1h-15zM153 73h7v1h-7zM163 73h6v1h-6zM186 73h2v1h-2zM195 73h21v1h-21zM3 74h12v1h-12zM29 74h5v1h-5zM47 74h4v1h-4zM65 74h3v1h-3zM82 74h19v1h-19zM133 74h13v1h-13zM153 74h7v1h-7zM163 74h6v1h-6zM186 74h4v1h-4zM195 74h21v1h-21zM3 75h12v1h-12zM29 75h2v1h-2zM47 75h4v1h-4zM65 75h3v1h-3zM82 75h19v1h-19zM116 75h1v1h-1zM133 75h12v1h-12zM154 75h4v1h-4zM163 75h5v1h-5zM186 75h7v1h-7zM195 75h21v1h-21zM3 76h12v1h-12zM47 76h4v1h-4zM65 76h3v1h-3zM82 76h20v1h-20zM116 76h2v1h-2zM134 76h11v1h-11zM164 76h3v1h-3zM186 76h29v1h-29zM3 77h12v1h-12zM47 77h4v1h-4zM65 77h3v1h-3zM82 77h20v1h-20zM115 77h3v1h-3zM134 77h10v1h-10zM185 77h30v1h-30zM3 78h12v1h-12zM46 78h5v1h-5zM65 78h3v1h-3zM82 78h13v1h-13zM98 78h4v1h-4zM115 78h4v1h-4zM135 78h8v1h-8zM185 78h29v1h-29zM3 79h12v1h-12zM46 79h5v1h-5zM65 79h3v1h-3zM82 79h10v1h-10zM98 79h4v1h-4zM115 79h4v1h-4zM135 79h7v1h-7zM184 79h30v1h-30zM3 80h12v1h-12zM45 80h6v1h-6zM65 80h3v1h-3zM82 80h7v1h-7zM99 80h3v1h-3zM115 80h5v1h-5zM136 80h5v1h-5zM181 80h32v1h-32zM3 81h12v1h-12zM44 81h7v1h-7zM65 81h3v1h-3zM82 81h5v1h-5zM99 81h3v1h-3zM115 81h5v1h-5zM136 81h4v1h-4zM177 81h35v1h-35zM3 82h12v1h-12zM43 82h8v1h-8zM65 82h3v1h-3zM82 82h5v1h-5zM99 82h3v1h-3zM115 82h6v1h-6zM137 82h3v1h-3zM143 82h2v1h-2zM173 82h38v1h-38zM3 83h12v1h-12zM42 83h9v1h-9zM65 83h3v1h-3zM82 83h5v1h-5zM99 83h3v1h-3zM115 83h6v1h-6zM137 83h8v1h-8zM169 83h41v1h-41zM3 84h12v1h-12zM41 84h10v1h-10zM65 84h3v1h-3zM82 84h5v1h-5zM99 84h3v1h-3zM115 84h7v1h-7zM138 84h7v1h-7zM165 84h18v1h-18zM184 84h25v1h-25zM3 85h12v1h-12zM38 85h13v1h-13zM65 85h3v1h-3zM82 85h5v1h-5zM99 85h3v1h-3zM115 85h7v1h-7zM139 85h5v1h-5zM160 85h19v1h-19zM184 85h24v1h-24zM3 86h12v1h-12zM36 86h15v1h-15zM65 86h3v1h-3zM82 86h4v1h-4zM99 86h3v1h-3zM115 86h8v1h-8zM139 86h5v1h-5zM156 86h19v1h-19zM184 86h22v1h-22zM3 87h12v1h-12zM33 87h18v1h-18zM65 87h4v1h-4zM82 87h4v1h-4zM99 87h3v1h-3zM115 87h8v1h-8zM140 87h3v1h-3zM152 87h19v1h-19zM184 87h20v1h-20zM3 88h12v1h-12zM31 88h20v1h-20zM65 88h4v1h-4zM82 88h4v1h-4zM99 88h3v1h-3zM115 88h8v1h-8zM140 88h3v1h-3zM148 88h21v1h-21zM183 88h19v1h-19zM3 89h12v1h-12zM30 89h21v1h-21zM65 89h4v1h-4zM82 89h3v1h-3zM99 89h3v1h-3zM115 89h9v1h-9zM140 89h3v1h-3zM144 89h24v1h-24zM183 89h16v1h-16zM3 90h12v1h-12zM29 90h22v1h-22zM65 90h4v1h-4zM99 90h3v1h-3zM115 90h9v1h-9zM140 90h27v1h-27zM183 90h13v1h-13zM3 91h12v1h-12zM29 91h22v1h-22zM65 91h4v1h-4zM99 91h3v1h-3zM115 91h10v1h-10zM137 91h19v1h-19zM160 91h7v1h-7zM182 91h13v1h-13zM3 92h12v1h-12zM29 92h22v1h-22zM65 92h4v1h-4zM99 92h3v1h-3zM115 92h10v1h-10zM135 92h17v1h-17zM160 92h7v1h-7zM182 92h13v1h-13zM3 93h12v1h-12zM29 93h22v1h-22zM65 93h4v1h-4zM99 93h3v1h-3zM115 93h11v1h-11zM133 93h15v1h-15zM160 93h6v1h-6zM182 93h12v1h-12zM3 94h12v1h-12zM29 94h22v1h-22zM65 94h4v1h-4zM99 94h3v1h-3zM115 94h11v1h-11zM130 94h15v1h-15zM160 94h6v1h-6zM182 94h12v1h-12zM3 95h12v1h-12zM29 95h22v1h-22zM65 95h4v1h-4zM99 95h3v1h-3zM115 95h30v1h-30zM160 95h6v1h-6zM181 95h13v1h-13zM3 96h12v1h-12zM30 96h21v1h-21zM65 96h4v1h-4zM99 96h3v1h-3zM113 96h22v1h-22zM142 96h3v1h-3zM160 96h5v1h-5zM181 96h12v1h-12zM3 97h12v1h-12zM30 97h21v1h-21zM65 97h5v1h-5zM99 97h3v1h-3zM109 97h21v1h-21zM142 97h3v1h-3zM160 97h5v1h-5zM181 97h12v1h-12zM3 98h12v1h-12zM30 98h21v1h-21zM65 98h6v1h-6zM99 98h3v1h-3zM106 98h20v1h-20zM142 98h3v1h-3zM160 98h5v1h-5zM180 98h13v1h-13zM3 99h12v1h-12zM30 99h21v1h-21zM65 99h7v1h-7zM97 99h24v1h-24zM142 99h3v1h-3zM159 99h6v1h-6zM180 99h12v1h-12zM3 100h12v1h-12zM30 100h21v1h-21zM65 100h8v1h-8zM92 100h25v1h-25zM142 100h3v1h-3zM159 100h5v1h-5zM180 100h12v1h-12zM3 101h12v1h-12zM30 101h21v1h-21zM65 101h9v1h-9zM88 101h27v1h-27zM142 101h3v1h-3zM159 101h5v1h-5zM179 101h13v1h-13zM3 102h12v1h-12zM30 102h21v1h-21zM65 102h11v1h-11zM84 102h16v1h-16zM106 102h8v1h-8zM142 102h3v1h-3zM159 102h5v1h-5zM179 102h12v1h-12zM3 103h12v1h-12zM30 103h21v1h-21zM64 103h32v1h-32zM106 103h7v1h-7zM142 103h3v1h-3zM159 103h5v1h-5zM179 103h12v1h-12zM4 104h11v1h-11zM30 104h21v1h-21zM61 104h31v1h-31zM106 104h6v1h-6zM142 104h3v1h-3zM159 104h4v1h-4zM178 104h13v1h-13zM4 105h11v1h-11zM30 105h21v1h-21zM59 105h33v1h-33zM106 105h6v1h-6zM142 105h3v1h-3zM159 105h4v1h-4zM178 105h12v1h-12zM4 106h12v1h-12zM30 106h21v1h-21zM57 106h25v1h-25zM87 106h4v1h-4zM106 106h5v1h-5zM142 106h3v1h-3zM159 106h4v1h-4zM178 106h12v1h-12zM4 107h12v1h-12zM30 107h22v1h-22zM55 107h23v1h-23zM87 107h4v1h-4zM106 107h5v1h-5zM142 107h3v1h-3zM159 107h3v1h-3zM177 107h13v1h-13zM4 108h12v1h-12zM29 108h45v1h-45zM87 108h4v1h-4zM106 108h4v1h-4zM142 108h3v1h-3zM159 108h3v1h-3zM177 108h12v1h-12zM4 109h12v1h-12zM28 109h45v1h-45zM87 109h4v1h-4zM106 109h4v1h-4zM142 109h3v1h-3zM159 109h3v1h-3zM177 109h12v1h-12zM4 110h12v1h-12zM23 110h36v1h-36zM66 110h7v1h-7zM87 110h4v1h-4zM106 110h4v1h-4zM142 110h3v1h-3zM159 110h3v1h-3zM177 110h12v1h-12zM4 111h50v1h-50zM66 111h7v1h-7zM87 111h4v1h-4zM106 111h4v1h-4zM142 111h3v1h-3zM159 111h2v1h-2zM176 111h13v1h-13zM4 112h48v1h-48zM66 112h7v1h-7zM87 112h4v1h-4zM106 112h4v1h-4zM142 112h3v1h-3zM159 112h2v1h-2zM176 112h12v1h-12zM4 113h39v1h-39zM49 113h3v1h-3zM67 113h6v1h-6zM87 113h4v1h-4zM106 113h4v1h-4zM125 113h4v1h-4zM142 113h3v1h-3zM159 113h2v1h-2zM176 113h12v1h-12zM4 114h34v1h-34zM49 114h3v1h-3zM67 114h6v1h-6zM87 114h4v1h-4zM106 114h4v1h-4zM125 114h4v1h-4zM142 114h3v1h-3zM159 114h2v1h-2zM175 114h13v1h-13zM4 115h29v1h-29zM49 115h3v1h-3zM67 115h6v1h-6zM87 115h4v1h-4zM106 115h4v1h-4zM125 115h4v1h-4zM142 115h3v1h-3zM159 115h1v1h-1zM175 115h12v1h-12zM4 116h24v1h-24zM49 116h3v1h-3zM67 116h6v1h-6zM87 116h4v1h-4zM106 116h4v1h-4zM125 116h4v1h-4zM142 116h3v1h-3zM159 116h1v1h-1zM175 116h12v1h-12zM4 117h21v1h-21zM49 117h3v1h-3zM67 117h6v1h-6zM87 117h4v1h-4zM106 117h4v1h-4zM125 117h4v1h-4zM142 117h3v1h-3zM159 117h1v1h-1zM174 117h13v1h-13zM4 118h20v1h-20zM49 118h3v1h-3zM67 118h6v1h-6zM87 118h4v1h-4zM106 118h4v1h-4zM125 118h4v1h-4zM142 118h3v1h-3zM159 118h1v1h-1zM174 118h12v1h-12zM4 119h19v1h-19zM49 119h3v1h-3zM67 119h6v1h-6zM87 119h4v1h-4zM106 119h4v1h-4zM125 119h4v1h-4zM141 119h4v1h-4zM174 119h12v1h-12zM4 120h18v1h-18zM49 120h3v1h-3zM67 120h6v1h-6zM87 120h4v1h-4zM106 120h4v1h-4zM125 120h4v1h-4zM139 120h6v1h-6zM173 120h13v1h-13zM4 121h17v1h-17zM49 121h3v1h-3zM67 121h6v1h-6zM87 121h4v1h-4zM106 121h4v1h-4zM125 121h4v1h-4zM137 121h8v1h-8zM173 121h12v1h-12zM4 122h16v1h-16zM49 122h3v1h-3zM67 122h6v1h-6zM87 122h4v1h-4zM106 122h4v1h-4zM125 122h4v1h-4zM135 122h10v1h-10zM173 122h12v1h-12zM4 123h16v1h-16zM49 123h3v1h-3zM67 123h6v1h-6zM87 123h4v1h-4zM106 123h4v1h-4zM125 123h5v1h-5zM134 123h11v1h-11zM172 123h13v1h-13zM4 124h15v1h-15zM49 124h3v1h-3zM67 124h6v1h-6zM87 124h4v1h-4zM106 124h4v1h-4zM125 124h5v1h-5zM132 124h13v1h-13zM172 124h13v1h-13zM4 125h15v1h-15zM49 125h3v1h-3zM67 125h6v1h-6zM87 125h4v1h-4zM106 125h4v1h-4zM125 125h20v1h-20zM172 125h13v1h-13zM4 126h15v1h-15zM49 126h3v1h-3zM67 126h6v1h-6zM87 126h4v1h-4zM106 126h4v1h-4zM125 126h20v1h-20zM172 126h13v1h-13zM4 127h14v1h-14zM49 127h3v1h-3zM67 127h6v1h-6zM87 127h4v1h-4zM106 127h4v1h-4zM125 127h20v1h-20zM173 127h12v1h-12zM4 128h14v1h-14zM34 128h2v1h-2zM49 128h3v1h-3zM67 128h6v1h-6zM87 128h4v1h-4zM106 128h4v1h-4zM125 128h20v1h-20zM173 128h13v1h-13zM4 129h14v1h-14zM33 129h4v1h-4zM49 129h3v1h-3zM67 129h6v1h-6zM87 129h4v1h-4zM106 129h4v1h-4zM125 129h20v1h-20zM173 129h13v1h-13zM4 130h14v1h-14zM32 130h5v1h-5zM49 130h3v1h-3zM67 130h6v1h-6zM87 130h4v1h-4zM106 130h4v1h-4zM125 130h20v1h-20zM174 130h12v1h-12zM4 131h14v1h-14zM32 131h5v1h-5zM49 131h3v1h-3zM67 131h6v1h-6zM87 131h4v1h-4zM106 131h4v1h-4zM125 131h20v1h-20zM174 131h13v1h-13zM4 132h14v1h-14zM32 132h5v1h-5zM49 132h3v1h-3zM67 132h6v1h-6zM87 132h4v1h-4zM106 132h4v1h-4zM125 132h20v1h-20zM175 132h12v1h-12zM4 133h14v1h-14zM32 133h5v1h-5zM49 133h3v1h-3zM67 133h6v1h-6zM87 133h4v1h-4zM106 133h4v1h-4zM125 133h20v1h-20zM175 133h13v1h-13zM4 134h14v1h-14zM32 134h5v1h-5zM48 134h4v1h-4zM67 134h6v1h-6zM87 134h4v1h-4zM106 134h4v1h-4zM125 134h20v1h-20zM175 134h13v1h-13zM4 135h13v1h-13zM32 135h5v1h-5zM46 135h6v1h-6zM67 135h6v1h-6zM87 135h4v1h-4zM106 135h4v1h-4zM125 135h20v1h-20zM176 135h12v1h-12zM4 136h13v1h-13zM32 136h5v1h-5zM44 136h8v1h-8zM67 136h6v1h-6zM87 136h4v1h-4zM106 136h4v1h-4zM125 136h20v1h-20zM176 136h13v1h-13zM4 137h13v1h-13zM32 137h5v1h-5zM42 137h10v1h-10zM67 137h5v1h-5zM87 137h4v1h-4zM106 137h4v1h-4zM125 137h20v1h-20zM177 137h12v1h-12zM4 138h13v1h-13zM32 138h5v1h-5zM40 138h12v1h-12zM67 138h4v1h-4zM87 138h4v1h-4zM106 138h4v1h-4zM125 138h20v1h-20zM177 138h13v1h-13zM4 139h13v1h-13zM32 139h20v1h-20zM66 139h3v1h-3zM87 139h4v1h-4zM106 139h4v1h-4zM125 139h20v1h-20zM177 139h13v1h-13zM4 140h13v1h-13zM32 140h20v1h-20zM87 140h4v1h-4zM106 140h4v1h-4zM125 140h20v1h-20zM178 140h12v1h-12zM4 141h13v1h-13zM32 141h20v1h-20zM87 141h4v1h-4zM106 141h4v1h-4zM125 141h20v1h-20zM178 141h13v1h-13zM4 142h13v1h-13zM32 142h20v1h-20zM87 142h4v1h-4zM106 142h4v1h-4zM125 142h20v1h-20zM178 142h13v1h-13zM4 143h13v1h-13zM32 143h20v1h-20zM87 143h4v1h-4zM106 143h4v1h-4zM125 143h20v1h-20zM179 143h12v1h-12zM4 144h13v1h-13zM32 144h20v1h-20zM87 144h4v1h-4zM106 144h4v1h-4zM125 144h20v1h-20zM162 144h1v1h-1zM179 144h13v1h-13zM4 145h13v1h-13zM33 145h19v1h-19zM87 145h4v1h-4zM106 145h4v1h-4zM125 145h20v1h-20zM161 145h2v1h-2zM180 145h12v1h-12zM4 146h13v1h-13zM33 146h19v1h-19zM87 146h4v1h-4zM106 146h4v1h-4zM125 146h20v1h-20zM161 146h3v1h-3zM180 146h13v1h-13zM4 147h13v1h-13zM33 147h19v1h-19zM87 147h4v1h-4zM106 147h4v1h-4zM125 147h12v1h-12zM142 147h3v1h-3zM160 147h4v1h-4zM180 147h13v1h-13zM4 148h13v1h-13zM33 148h19v1h-19zM87 148h4v1h-4zM106 148h4v1h-4zM125 148h9v1h-9zM142 148h3v1h-3zM160 148h4v1h-4zM181 148h12v1h-12zM4 149h14v1h-14zM33 149h19v1h-19zM87 149h4v1h-4zM106 149h4v1h-4zM125 149h6v1h-6zM142 149h3v1h-3zM160 149h5v1h-5zM181 149h13v1h-13zM4 150h14v1h-14zM33 150h19v1h-19zM87 150h4v1h-4zM106 150h4v1h-4zM125 150h5v1h-5zM142 150h3v1h-3zM160 150h5v1h-5zM182 150h12v1h-12zM4 151h14v1h-14zM33 151h19v1h-19zM72 151h1v1h-1zM87 151h4v1h-4zM106 151h4v1h-4zM125 151h4v1h-4zM142 151h3v1h-3zM160 151h5v1h-5zM182 151h12v1h-12zM4 152h14v1h-14zM33 152h19v1h-19zM70 152h3v1h-3zM87 152h4v1h-4zM106 152h4v1h-4zM125 152h4v1h-4zM142 152h3v1h-3zM160 152h6v1h-6zM182 152h13v1h-13zM4 153h14v1h-14zM33 153h19v1h-19zM68 153h5v1h-5zM87 153h4v1h-4zM106 153h4v1h-4zM125 153h4v1h-4zM142 153h3v1h-3zM160 153h6v1h-6zM183 153h12v1h-12zM4 154h14v1h-14zM33 154h19v1h-19zM67 154h6v1h-6zM87 154h4v1h-4zM106 154h4v1h-4zM125 154h4v1h-4zM142 154h3v1h-3zM160 154h6v1h-6zM183 154h13v1h-13zM4 155h14v1h-14zM33 155h19v1h-19zM66 155h7v1h-7zM87 155h4v1h-4zM106 155h4v1h-4zM125 155h4v1h-4zM142 155h3v1h-3zM160 155h7v1h-7zM183 155h13v1h-13zM4 156h14v1h-14zM33 156h13v1h-13zM49 156h3v1h-3zM66 156h7v1h-7zM87 156h4v1h-4zM106 156h4v1h-4zM125 156h4v1h-4zM142 156h3v1h-3zM160 156h7v1h-7zM184 156h12v1h-12zM4 157h14v1h-14zM33 157h10v1h-10zM49 157h3v1h-3zM66 157h7v1h-7zM87 157h4v1h-4zM106 157h4v1h-4zM125 157h4v1h-4zM142 157h3v1h-3zM160 157h7v1h-7zM184 157h13v1h-13zM4 158h14v1h-14zM33 158h8v1h-8zM49 158h3v1h-3zM67 158h6v1h-6zM87 158h4v1h-4zM106 158h4v1h-4zM125 158h4v1h-4zM142 158h3v1h-3zM160 158h8v1h-8zM185 158h12v1h-12zM4 159h14v1h-14zM33 159h5v1h-5zM49 159h3v1h-3zM67 159h6v1h-6zM87 159h4v1h-4zM106 159h4v1h-4zM125 159h4v1h-4zM142 159h3v1h-3zM160 159h8v1h-8zM185 159h13v1h-13zM4 160h14v1h-14zM33 160h4v1h-4zM49 160h3v1h-3zM67 160h6v1h-6zM87 160h4v1h-4zM106 160h4v1h-4zM125 160h1v1h-1zM142 160h3v1h-3zM160 160h8v1h-8zM185 160h13v1h-13zM4 161h14v1h-14zM33 161h4v1h-4zM49 161h3v1h-3zM67 161h6v1h-6zM87 161h4v1h-4zM106 161h4v1h-4zM142 161h3v1h-3zM160 161h9v1h-9zM186 161h12v1h-12zM4 162h14v1h-14zM33 162h4v1h-4zM49 162h3v1h-3zM67 162h6v1h-6zM87 162h4v1h-4zM106 162h4v1h-4zM142 162h3v1h-3zM160 162h9v1h-9zM186 162h13v1h-13zM4 163h14v1h-14zM33 163h4v1h-4zM49 163h3v1h-3zM67 163h6v1h-6zM87 163h4v1h-4zM106 163h4v1h-4zM142 163h3v1h-3zM160 163h9v1h-9zM186 163h13v1h-13zM4 164h14v1h-14zM33 164h4v1h-4zM49 164h3v1h-3zM67 164h6v1h-6zM87 164h4v1h-4zM106 164h4v1h-4zM142 164h3v1h-3zM160 164h10v1h-10zM187 164h12v1h-12zM4 165h14v1h-14zM33 165h4v1h-4zM49 165h3v1h-3zM67 165h6v1h-6zM87 165h4v1h-4zM106 165h4v1h-4zM142 165h3v1h-3zM160 165h10v1h-10zM187 165h13v1h-13zM4 166h14v1h-14zM33 166h4v1h-4zM49 166h3v1h-3zM67 166h6v1h-6zM87 166h4v1h-4zM106 166h4v1h-4zM142 166h3v1h-3zM160 166h10v1h-10zM188 166h12v1h-12zM4 167h14v1h-14zM33 167h4v1h-4zM49 167h3v1h-3zM67 167h6v1h-6zM87 167h4v1h-4zM106 167h4v1h-4zM142 167h3v1h-3zM160 167h11v1h-11zM188 167h12v1h-12zM4 168h14v1h-14zM33 168h3v1h-3zM49 168h3v1h-3zM67 168h6v1h-6zM87 168h4v1h-4zM106 168h5v1h-5zM142 168h3v1h-3zM160 168h11v1h-11zM188 168h12v1h-12zM4 169h14v1h-14zM49 169h3v1h-3zM67 169h6v1h-6zM87 169h4v1h-4zM106 169h5v1h-5zM142 169h3v1h-3zM160 169h11v1h-11zM189 169h11v1h-11zM4 170h14v1h-14zM49 170h3v1h-3zM67 170h6v1h-6zM87 170h4v1h-4zM106 170h6v1h-6zM142 170h3v1h-3zM160 170h12v1h-12zM188 170h12v1h-12zM4 171h14v1h-14zM49 171h3v1h-3zM67 171h6v1h-6zM87 171h4v1h-4zM106 171h8v1h-8zM142 171h3v1h-3zM158 171h14v1h-14zM184 171h16v1h-16zM4 172h14v1h-14zM49 172h3v1h-3zM67 172h6v1h-6zM87 172h4v1h-4zM106 172h9v1h-9zM139 172h6v1h-6zM154 172h19v1h-19zM175 172h25v1h-25zM4 173h14v1h-14zM49 173h3v1h-3zM67 173h7v1h-7zM87 173h4v1h-4zM103 173h13v1h-13zM136 173h10v1h-10zM149 173h51v1h-51zM4 174h14v1h-14zM49 174h3v1h-3zM67 174h9v1h-9zM87 174h4v1h-4zM100 174h17v1h-17zM132 174h67v1h-67zM4 175h14v1h-14zM49 175h3v1h-3zM67 175h12v1h-12zM87 175h4v1h-4zM97 175h21v1h-21zM128 175h71v1h-71zM4 176h14v1h-14zM49 176h3v1h-3zM67 176h15v1h-15zM87 176h4v1h-4zM95 176h24v1h-24zM125 176h73v1h-73zM4 177h14v1h-14zM49 177h3v1h-3zM66 177h132v1h-132zM4 178h15v1h-15zM49 178h3v1h-3zM66 178h131v1h-131zM4 179h16v1h-16zM48 179h4v1h-4zM66 179h130v1h-130zM4 180h17v1h-17zM45 180h7v1h-7zM63 180h132v1h-132zM4 181h19v1h-19zM41 181h11v1h-11zM58 181h135v1h-135zM5 182h19v1h-19zM37 182h15v1h-15zM54 182h136v1h-136zM5 183h21v1h-21zM34 183h147v1h-147zM6 184h21v1h-21zM30 184h142v1h-142zM6 185h158v1h-158zM6 186h149v1h-149zM7 187h139v1h-139zM8 188h129v1h-129zM8 189h120v1h-120zM9 190h110v1h-110zM10 191h100v1h-100zM11 192h91v1h-91zM12 193h81v1h-81zM13 194h71v1h-71zM14 195h61v1h-61zM16 196h50v1h-50zM17 197h40v1h-40zM20 198h28v1h-28zM22 199h18v1h-18z"/></svg>';
const SEPARATOR = /^-{8,}$/;
const squeeze = (value) => value.replace(/\s+/g, ' ').trim();
/** A Webkassa line in both languages, «Чек/Чек №1» shortened to «Чек №1». */
const both = (value) => squeeze(value).replace(/(^|\s)([^\s/]+)\/\2(?=[\s:]|$)/g, '$1$2');
/** «Қолма-қол/Наличные: 100,00» -> «Наличные: 100,00»: the Russian half of a bilingual label. */
export const russian = (value) =>
  squeeze(value)
    .replace(/^[^/\d]*?\//, '')
    .replace(/(^|\s)[^\s/\d.:]+\/(?=[^\s/\d])/g, '$1');
/** «1 500,00» -> «1 500 ₸», «12,50» -> «12,50 ₸» (Webkassa prints tenge with two decimals). */
const money2 = (value) => `${value.replace(/,00$/, '')} ₸`;
const AMOUNT = /(-?\d[\d ]*,\d{2})$/;
/** Kazakh line printed above the cashier's Russian pickup text (receipt in both languages). */
export function kazakhPickup(value) {
  if (value === 'Забрать на выдаче') return 'Беру орнынан алыңыз';
  if (value === 'Заказ из киоска') return 'Киосктан тапсырыс';
  const delivery = /^Выдача доставки( · .*)$/.exec(value);
  return delivery ? `Жеткізуге беру${delivery[1]}` : null;
}
/**
 * The branded receipt (owner 26.11): the Webkassa print form cut into its sections and laid out
 * to read easily: logo and order number on top, the goods with what the guest chose under each,
 * totals in large type, then every fiscal requisite of the form (taxpayer, ИИН/БИН, shift and
 * receipt numbers, ФП, time, address, ОФД and the check site, QR, ИНК, РНМ, ЗНМ). Left out: the
 * cabinet's cashbox title and the cabinet owner's name as cashier (the shift cashier's first name
 * is printed instead). Null when the form does not have the expected sections: then the form is
 * printed exactly as Webkassa made it. Since 26.11 (owner's pick) every label is in Kazakh and
 * Russian: Webkassa's own bilingual lines are kept, ours are written in both languages.
 */
export function brandedFiscalRows(ticket) {
  const receipt = ticket.receipt;
  if (!receipt) return null;
  const sections = [[]];
  for (const line of ticket.fiscal_lines) {
    if (line.type === 0 && SEPARATOR.test(line.value.trim())) sections.push([]);
    else sections.at(-1).push(line);
  }
  // Cut by content, not by an exact count of 48-dash lines: Webkassa may split a block in two.
  const moneyAt = sections.findIndex((s) => s.some((line) => /ИТОГО/.test(line.value)));
  const tail = sections.findIndex(
    (s, i) => i > moneyAt && s.some((line) => line.type === 2 || /ФИСКАЛЬНЫЙ ЧЕК/.test(line.value)),
  );
  let goodsEnd = moneyAt - 1;
  while (goodsEnd >= 2 && !sections[goodsEnd].some((line) => /Стоимость/.test(line.value)))
    goodsEnd--;
  if (moneyAt < 3 || tail < 0 || goodsEnd < 2) return null;
  const [header, info] = sections;
  const goods = sections.slice(2, goodsEnd + 1).flat();
  const money = sections.slice(goodsEnd + 1, moneyAt + 1).flat();
  const requisites = sections.slice(moneyAt + 1, tail).flat();
  const tailLines = sections.slice(tail).flat();
  if (header.length < 2 || !info.length || !goods.length) return null;
  const items = [];
  for (const line of goods) {
    const value = squeeze(line.value);
    const start = /^(\d+)\.\s+(.*)$/.exec(value);
    if (start) items.push({ name: start[2], qty: null, cost: null, notes: [] });
    // Lines before the first position («Тапсырыс нөмірі/Номер заказа: 24» since the point sends
    // ExternalOrderNumber): the big order number on top already says it.
    else if (!items.length) continue;
    else {
      const item = items.at(-1);
      const r = russian(value);
      if (item.qty === null && / x /.test(r) && !/Стоимость/.test(r)) item.qty = value;
      else if (/Стоимость/.test(r) && AMOUNT.test(r)) item.cost = AMOUNT.exec(r)[1];
      else if (item.qty === null && item.cost === null) item.name += ` ${value}`;
      else item.notes.push(value);
    }
  }
  if (!items.length || items.some((item) => item.cost === null)) return null;

  const rows = [{ type: 'logo' }];
  for (const line of header) rows.push({ type: 'small', text: both(line.value) });
  rows.push({ type: 'center', text: 'Тапсырыс / Заказ' });
  rows.push({ type: 'big', text: `№${receipt.display_number}` });
  if (receipt.pickup_text) {
    const kk = kazakhPickup(receipt.pickup_text);
    if (kk) rows.push({ type: 'center', text: kk });
    rows.push({ type: 'center', text: receipt.pickup_text });
  }
  rows.push({ type: 'rule' });
  for (const [index, item] of items.entries()) {
    rows.push({ type: 'item', left: item.name, right: money2(item.cost) });
    if (item.qty) {
      const [qty, price] = item.qty.split(' x ');
      rows.push({ type: 'note', text: price ? `${qty} × ${money2(price.trim())}` : item.qty });
    }
    const ours = receipt.lines[index];
    if (ours && squeeze(ours.name).toLowerCase() === squeeze(item.name).toLowerCase())
      for (const option of ours.options) rows.push({ type: 'note', text: `+ ${option}` });
    for (const note of item.notes) rows.push({ type: 'note', text: note });
  }
  if (receipt.comment) rows.push({ type: 'text', text: `Ескерту/Комментарий: ${receipt.comment}` });
  rows.push({ type: 'rule' });
  // Total first, then how it was paid (Webkassa prints the payments above the total).
  const paid = [];
  for (const line of money) {
    const value = squeeze(line.value);
    const amount = AMOUNT.exec(value);
    if (!amount) {
      if (value) paid.push({ type: 'text', text: value });
      continue;
    }
    const label = value.slice(0, amount.index).replace(/[:\s]+$/, '');
    if (/ИТОГО/.test(label))
      rows.push({ type: 'total', left: 'Барлығы/Итого', right: money2(amount[1]) });
    else paid.push({ type: 'pair', left: label, right: money2(amount[1]) });
  }
  rows.push(...paid);
  if (receipt.cash_tendered_minor)
    rows.push({
      type: 'pair',
      left: 'Алынды/Получено',
      right: tenge(receipt.cash_tendered_minor),
    });
  if (receipt.change_minor && receipt.change_minor !== '0')
    rows.push({
      type: 'pair',
      left: 'Қайтарым/Сдача',
      right: tenge(receipt.change_minor),
      bold: true,
    });
  rows.push({ type: 'rule' });
  for (const line of info.slice(1)) {
    const value = both(line.value);
    if (value && !/Кассир/i.test(value)) rows.push({ type: 'small', text: value });
  }
  if (receipt.cashier) rows.push({ type: 'small', text: `Кассир: ${receipt.cashier}` });
  rows.push(...requisiteRows(requisites));
  for (const line of tailLines) {
    if (line.type === 2) rows.push({ type: 'qr', text: line.value, qr: line.qr });
    else {
      const value = both(line.value);
      if (!value) continue;
      if (/ФИСКАЛЬНЫЙ ЧЕК/.test(value)) {
        rows.push({ type: 'title', text: 'Фискалдық чек' });
        rows.push({ type: 'title', text: 'Фискальный чек' });
      } else rows.push({ type: 'small', text: value });
    }
  }
  rows.push({ type: 'rule' });
  rows.push({ type: 'center', text: 'PickChick-ті таңдағаныңызға рахмет!' });
  rows.push({ type: 'center', text: 'Спасибо, что выбрали PickChick!' });
  rows.push({ type: 'small', text: 'pickchick.kz' });
  return rows;
}

/**
 * The requisites block of the form, shortened (owner 26.11) but keeping what the law asks for:
 * ФП and time as they are, the address in Kazakh and in Russian, the ОФД and the site to check
 * the receipt on one bilingual line each, the offline note in both languages.
 */
export function requisiteRows(lines) {
  const rows = [];
  const address = [];
  let site = null;
  let offline = false;
  let stage = 'head';
  for (const line of lines) {
    const raw = squeeze(line.value);
    if (!raw) continue;
    if (/автоном/i.test(raw)) {
      offline = true;
      continue;
    }
    if (/^ФДО:/.test(raw)) continue;
    if (/^ОФД:/.test(raw)) {
      stage = 'ofd';
      rows.push({ type: 'small', text: raw.replace(/^ОФД:/, 'ФДО/ОФД:') });
      continue;
    }
    if (stage === 'ofd' || stage === 'site' || /тексеру|проверки/i.test(raw)) {
      stage = 'site';
      const url = /([a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?)$/i.exec(raw);
      if (url && !site) site = url[1];
      continue;
    }
    if (/^(ФБ\/)?ФП:|Время:/.test(russian(raw)) && stage === 'head') {
      rows.push({ type: 'small', text: both(raw) });
      continue;
    }
    address.push(raw);
  }
  if (address.length) {
    const joined = address.join(' ');
    const ru = /(^|\s)(г\.\s?|город\s|[А-Я][а-я]+ская обл)/.exec(joined);
    const split = ru && ru.index > 0;
    rows.splice(
      rows.length - (rows.some((r) => /ОФД:/.test(r.text)) ? 1 : 0),
      0,
      ...(split
        ? [
            { type: 'small', text: `Мекенжай: ${joined.slice(0, ru.index).trim()}` },
            { type: 'small', text: `Адрес: ${joined.slice(ru.index).trim()}` },
          ]
        : [{ type: 'small', text: `Мекенжай/Адрес: ${joined}` }]),
    );
  }
  if (site) rows.push({ type: 'small', text: `Чекті тексеру/Проверка чека: ${site}` });
  if (offline) {
    rows.push({ type: 'small', text: 'Чек автономды режимде құрастырылған' });
    rows.push({ type: 'small', text: 'Чек сформирован в автономном режиме' });
  }
  return rows;
}

/**
 * The paper, independent of the printer: rows of one ticket in print order. Order and refund
 * tickets: number, pickup, items, totals, tenders, change. Reports: money rows, methods, notes.
 */
export function ticketRows(ticket) {
  if (ticket.kind === 'fiscal')
    return (
      brandedFiscalRows(ticket) ??
      ticket.fiscal_lines.map((line) =>
        line.type === 2
          ? { type: 'qr', text: line.value, qr: line.qr }
          : { type: 'mono', text: line.value, bold: line.style === 1 },
      )
    );
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
export const ticketHeightMicrons = (rows) =>
  Math.max(
    60_000,
    20_000 + rows.reduce((sum, row) => sum + (row.type === 'qr' ? 45_000 : 5_000), 0),
  );
/** A QR matrix as a static SVG (no script, no external resource), 40 mm wide with a quiet zone. */
export function qrSvg(matrix) {
  const size = matrix.length + 8;
  const cells = [];
  matrix.forEach((row, y) => {
    for (let x = 0; x < row.length; x++)
      if (row[x] === '1') cells.push(`M${x + 4} ${y + 4}h1v1h-1z`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="40mm" height="40mm" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${cells.join('')}" fill="#000"/></svg>`;
}
/**
 * The HTML of a ticket for the Windows driver: a static document with every text escaped, no
 * script, no external resource (the print window also blocks every request).
 */
export function ticketHtml(ticket) {
  const body = ticketRows(ticket)
    .map((row) => {
      if (row.type === 'rule') return '<hr>';
      if (row.type === 'qr') return `<div class="qr">${qrSvg(row.qr)}</div>`;
      if (row.type === 'logo') return `<div class="logo">${RECEIPT_LOGO_SVG}</div>`;
      if (row.type === 'item' || row.type === 'total')
        return `<div class="${row.type}"><span>${escapeHtml(row.left)}</span><b>${escapeHtml(row.right)}</b></div>`;
      if (row.type === 'mono')
        return `<div class="mono${row.bold ? ' bold' : ''}">${escapeHtml(row.text) || '&nbsp;'}</div>`;
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
body { margin: 0; padding: 2mm 2mm; width: 72mm; box-sizing: border-box; overflow-wrap: anywhere; font: 11pt/1.3 Arial, sans-serif; color: #000; }
.title, .center, .big { text-align: center; }
.title { font-weight: bold; }
.big { font-size: 20pt; font-weight: bold; margin: 1mm 0; }
.pair { display: flex; justify-content: space-between; gap: 2mm; }
.pair b { font-weight: normal; white-space: nowrap; }
.pair.bold, .pair.bold b { font-weight: bold; }
hr { border: 0; border-top: 1px dashed #000; margin: 1.5mm 0; }
.mono { font: 8.4pt/1.25 'Courier New', monospace; white-space: pre; overflow: hidden; }
.mono.bold { font-weight: bold; }
.qr { text-align: center; margin: 2mm 0; }
.logo { text-align: center; margin: 0 0 1mm; }
.item, .total { display: flex; justify-content: space-between; gap: 2mm; }
.item { font-weight: bold; margin-top: 1.2mm; }
.item b, .total b { white-space: nowrap; }
.note { padding-left: 4mm; font-size: 10pt; }
.total { font-size: 15pt; font-weight: bold; margin: 0.5mm 0; }
.small { text-align: center; font-size: 8.5pt; line-height: 1.25; }
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
/** GS ( k: the printer's own QR (model 2, module 6 dots, correction M) of an ASCII link. */
export function escposQr(value) {
  const data = [...value].map((c) => c.charCodeAt(0) & 0x7f);
  const length = data.length + 3;
  return [
    ...[0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00],
    ...[0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06],
    ...[0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31],
    ...[0x1d, 0x28, 0x6b, length & 0xff, length >> 8, 0x31, 0x50, 0x30, ...data],
    ...[0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30],
  ];
}
export function escposBytes(ticket, width = ESCPOS_COLUMNS) {
  const out = [...ESC.init, ...ESC.codepage];
  const line = (value) => out.push(...encodeCp866(value), 0x0a);
  if (ticket.kind === 'fiscal' && !brandedFiscalRows(ticket)) {
    // Webkassa lays the receipt out for 48 columns (Font A of an 80 mm printer).
    for (const row of ticketRows(ticket)) {
      if (row.type === 'qr') {
        out.push(...ESC.center, ...escposQr(row.text), 0x0a, ...ESC.left);
        continue;
      }
      if (row.bold) out.push(...ESC.boldOn);
      const value = printable(row.text);
      for (const l of value.length <= 48 ? [value] : wrap(value, 48)) line(l);
      if (row.bold) out.push(...ESC.boldOff);
    }
    out.push(0x0a, ...ESC.cut);
    return Buffer.from(out);
  }
  for (const row of ticketRows(ticket)) {
    if (row.type === 'rule') {
      line('-'.repeat(width));
      continue;
    }
    if (row.type === 'qr') {
      out.push(...ESC.center, ...escposQr(row.text), 0x0a, ...ESC.left);
      continue;
    }
    if (row.type === 'logo') {
      out.push(...ESC.center, ...ESC.double, ...ESC.boldOn);
      line('PICK CHICK');
      out.push(...ESC.boldOff, ...ESC.normal, ...ESC.left);
      continue;
    }
    if (row.type === 'item' || row.type === 'total') {
      out.push(...ESC.boldOn);
      for (const l of pairLines(printable(row.left), printable(row.right), width)) line(l);
      out.push(...ESC.boldOff);
      continue;
    }
    if (row.type === 'note') {
      for (const l of wrap(printable(`  ${row.text}`), width)) line(l);
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
    } else if (row.type === 'center' || row.type === 'small') {
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
