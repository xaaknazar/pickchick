// Customer display: the second screen of a dual-screen cashier monoblock. The cashier's page
// sends a small typed view (what the guest may see: lines, total, method, order number); main
// validates it and passes it to a separate window on the other display. That window has its
// own session and preload, no journal, printer or edge access, and takes no input.
import { readFile } from 'node:fs/promises';

export const CUSTOMER_URL = 'pickchick-pos://app/customer.html';
const MINOR = /^(0|[1-9][0-9]{0,15})$/;
const METHODS = ['cash', 'kaspi_terminal', 'kaspi_manual', 'chocofood', 'mixed', 'other'];
const KINDS = ['idle', 'order', 'pay', 'done'];
const MODES = ['take', 'dine'];

/** Files the customer window may load, with their types. Nothing else is served to it. */
export const CUSTOMER_ASSETS = new Map([
  ['/customer.html', ['v2/customer.html', 'text/html; charset=utf-8']],
  ['/v2/customer.js', ['v2/customer.js', 'text/javascript']],
  ['/v2/customer.css', ['v2/customer.css', 'text/css']],
  ['/v2/assets/logo-sticker.webp', ['v2/assets/logo-sticker.webp', 'image/webp']],
  ['/v2/assets/bg-blue.png', ['v2/assets/bg-blue.png', 'image/png']],
  ['/v2/assets/kaspi.png', ['v2/assets/kaspi.png', 'image/png']],
  ...[
    'golos-text-2f175b8fc40e.woff2',
    'golos-text-f8d71091110f.woff2',
    'montserrat-6438d7b8ea9c.woff2',
    'montserrat-0b00fbd6edcc.woff2',
    // Cyrillic Extended: the Kazakh letters Ә Ғ Қ Ң Ө Ү Һ.
    'golos-text-10aa879203c4.woff2',
    'montserrat-744830a0e77d.woff2',
  ].map((n) => ['/v2/fonts/' + n, ['v2/fonts/' + n, 'font/woff2']]),
]);
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'",
};

/** Only GET of the fixed customer assets on the app origin. */
export function isAllowedCustomerURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'pickchick-pos:' &&
    url.host === 'app' &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password &&
    CUSTOMER_ASSETS.has(url.pathname)
  );
}

export function createCustomerHandler({ assetDir }) {
  return async (request) => {
    if (request.method !== 'GET' || !isAllowedCustomerURL(request.url))
      return new Response('', { status: 404, headers: HEADERS });
    const [file, type] = CUSTOMER_ASSETS.get(new URL(request.url).pathname);
    try {
      const body = await readFile(new URL(file, assetDir));
      return new Response(body, { status: 200, headers: { ...HEADERS, 'Content-Type': type } });
    } catch {
      return new Response('', { status: 404, headers: HEADERS });
    }
  };
}

/**
 * The display for the guest: config `customerDisplay` false turns it off; otherwise the first
 * display that is not the primary one (the cashier's), or null when there is only one.
 */
export function pickCustomerDisplay(displays, primary, config = {}) {
  if (config.customerDisplay === false) return null;
  if (!Array.isArray(displays) || !primary) return null;
  return displays.find((d) => d && d.id !== primary.id) ?? null;
}

const text = (value, max) => {
  if (typeof value !== 'string') throw new Error('INVALID_CUSTOMER_VIEW');
  const chars = [...value];
  if (chars.length > max) throw new Error('INVALID_CUSTOMER_VIEW');
  return value;
};
const minor = (value) => {
  if (typeof value !== 'string' || !MINOR.test(value)) throw new Error('INVALID_CUSTOMER_VIEW');
  return value;
};
const exact = (value, required, optional = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_CUSTOMER_VIEW');
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key))
      throw new Error('INVALID_CUSTOMER_VIEW');
  for (const key of required) if (!(key in value)) throw new Error('INVALID_CUSTOMER_VIEW');
};

/** A clean copy of the view the cashier's page sent, or an error. */
export function validateCustomerView(value) {
  exact(
    value,
    ['kind'],
    ['lines', 'total_minor', 'mode', 'method', 'tendered_minor', 'change_minor', 'number'],
  );
  if (!KINDS.includes(value.kind)) throw new Error('INVALID_CUSTOMER_VIEW');
  if (value.kind === 'idle') {
    exact(value, ['kind']);
    return { kind: 'idle' };
  }
  if (value.kind === 'done') {
    exact(value, ['kind', 'number', 'total_minor']);
    return { kind: 'done', number: text(value.number, 12), total_minor: minor(value.total_minor) };
  }
  exact(
    value,
    ['kind', 'lines', 'total_minor'],
    value.kind === 'pay' ? ['mode', 'method', 'tendered_minor', 'change_minor'] : ['mode'],
  );
  if (!Array.isArray(value.lines) || value.lines.length > 60)
    throw new Error('INVALID_CUSTOMER_VIEW');
  const view = {
    kind: value.kind,
    lines: value.lines.map((line) => {
      exact(line, ['name', 'qty', 'sum_minor'], ['mods']);
      if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > 999)
        throw new Error('INVALID_CUSTOMER_VIEW');
      return {
        name: text(line.name, 80),
        qty: line.qty,
        sum_minor: minor(line.sum_minor),
        ...(line.mods === undefined || line.mods === '' ? {} : { mods: text(line.mods, 200) }),
      };
    }),
    total_minor: minor(value.total_minor),
  };
  if (value.mode !== undefined) {
    if (!MODES.includes(value.mode)) throw new Error('INVALID_CUSTOMER_VIEW');
    view.mode = value.mode;
  }
  if (value.kind === 'pay') {
    if (value.method !== undefined) {
      if (!METHODS.includes(value.method)) throw new Error('INVALID_CUSTOMER_VIEW');
      view.method = value.method;
    }
    if (value.tendered_minor !== undefined) view.tendered_minor = minor(value.tendered_minor);
    if (value.change_minor !== undefined) view.change_minor = minor(value.change_minor);
  }
  return view;
}
