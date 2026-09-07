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
