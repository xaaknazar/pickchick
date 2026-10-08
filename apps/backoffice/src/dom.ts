export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function button(text: string, action: () => void, cls = 'button', testId?: string) {
  const b = element('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', action);
  if (testId) b.dataset.testid = testId;
  return b;
}
export function image(key: string, name = '') {
  if (key === 'generic-drink') {
    const v = element('div', 'image-placeholder', 'Фото не задано');
    v.setAttribute('role', 'img');
    v.setAttribute('aria-label', name ? `${name}: фото не задано` : 'Фото не задано');
    return v;
  }
  const img = element('img');
  img.src = `./assets/${key}`;
  img.alt = name;
  img.loading = 'lazy';
  img.addEventListener('error', () => img.replaceWith(image('generic-drink', name)), {
    once: true,
  });
  return img;
}
export function field(
  label: string,
  value: string,
  onValue: (value: string) => void,
  options: {
    id?: string;
    type?: string;
    max?: number;
    required?: boolean;
    multiline?: boolean;
    readonly?: boolean;
    hint?: string;
  } = {},
) {
  const wrap = element('label', 'field');
  wrap.append(element('span', 'field-label', label));
  const input = options.multiline ? element('textarea') : element('input');
  input.value = value;
  input.required = options.required ?? false;
  input.readOnly = options.readonly ?? false;
  if (options.id) {
    input.id = options.id;
    input.dataset.testid = options.id;
  }
  if (options.max) input.maxLength = options.max;
  if (input instanceof HTMLInputElement) input.type = options.type ?? 'text';
  input.addEventListener('input', () => onValue(input.value));
  wrap.append(input);
  if (options.hint) wrap.append(element('small', 'muted', options.hint));
  return wrap;
}
export function select(
  label: string,
  value: string,
  items: { value: string; label: string }[],
  onValue: (value: string) => void,
  id?: string,
) {
  const wrap = element('label', 'field'),
    input = element('select');
  wrap.append(element('span', 'field-label', label));
  for (const item of items) {
    const o = element('option', '', item.label);
    o.value = item.value;
    input.append(o);
  }
  input.value = value;
  if (id) {
    input.dataset.testid = id;
    input.id = id;
  }
  input.addEventListener('change', () => onValue(input.value));
  wrap.append(input);
  return wrap;
}
export function check(label: string, value: boolean, onValue: (v: boolean) => void, id?: string) {
  const wrap = element('label', 'check'),
    input = element('input');
  input.type = 'checkbox';
  input.checked = value;
  if (id) input.dataset.testid = id;
  input.addEventListener('change', () => onValue(input.checked));
  wrap.append(input, element('span', '', label));
  return wrap;
}
export function grid(...children: Node[]) {
  const n = element('div', 'form-grid');
  n.append(...children);
  return n;
}

/** Decorative, consistent 24 px navigation icons. Labels remain visible and accessible. */
export function navigationIcon(name: string) {
  const paths: Record<string, string> = {
    dash: 'M3 10 12 3 21 10M5 9v12h5v-7h4v7h5V9',
    orders: 'M7 3h10v3H7zM7 4H5v17h14V4h-2M8 11h8M8 16h6',
    items: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    stoplist: 'M8 3h8l5 5v8l-5 5H8l-5-5V8zM8 12h8',
    shifts: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2',
    reports: 'M4 3v18h17M8 16v-5M13 16V7M18 16v-8',
    finance: 'M3 6h18v14H3zM3 6l15-3v3M16 11h5v4h-5z',
    stock: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
    settlements: 'M5 3h14v18l-4-2-3 2-3-2-4 2zM8 8h8M8 12h6',
    promo: 'M3 10v5h4l10 4V5L7 10zM7 15l2 6M21 9v6',
    games: 'M7 7h10l4 11-3 2-4-5h-4l-4 5-3-2zM6 11h5M8.5 8.5v5M16 10h.1M18 13h.1',
    guests:
      'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M2 21v-3a7 7 0 0 1 14 0v3M17 4a4 4 0 0 1 0 8M19 15a5 5 0 0 1 3 4v2',
    tickets: 'M3 4h18v13H9l-6 4zM7 9h10M7 13h7',
    reviews: 'm12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z',
    stations: 'M8 3h8v5H8zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-4h12v4',
    devices: 'M3 4h18v13H3zM8 21h8M12 17v4',
    audit: 'M4 4h16v17H4zM8 8h8M8 12h8M8 16h5',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'nav-icon');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[name] ?? paths['items']!);
  svg.append(path);
  return svg;
}
