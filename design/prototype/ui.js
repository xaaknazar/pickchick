export const groups = {
  mobile: { name: 'Приложение', short: 'Mobile', icon: 'phone', first: 'M06', size: [390, 844] },
  kiosk: { name: 'Киоск iPad', short: 'Киоск', icon: 'tablet', first: 'K03', size: [1024, 1366] },
  pos: { name: 'Касса Windows', short: 'Касса', icon: 'monitor', first: 'P03', size: [1366, 900] },
  kitchen: {
    name: 'Кухня · A / B',
    short: 'Кухня',
    icon: 'flame',
    first: 'D01',
    size: [1440, 900],
  },
  display: { name: 'Табло в зале', short: 'Табло', icon: 'grid', first: 'T01', size: [1920, 1080] },
  backoffice: { name: 'Бэк-офис', short: 'Офис', icon: 'chart', first: 'B02', size: [1440, 960] },
};
export const stateNames = {
  default: 'Основное',
  loading: 'Загрузка',
  empty: 'Нет данных',
  error: 'Ошибка',
  offline: 'Нет связи',
  denied: 'Нет доступа',
  conflict: 'Данные изменились',
  expired: 'Срок истёк',
  limited: 'Лимит попыток',
  paused: 'Пауза',
  pending: 'На проверке',
  rejected: 'Награда не выдана',
};
const paths = {
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
  tablet: '<rect x="3" y="2" width="18" height="20" rx="3"/><path d="M11 18h2"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  flame: '<path d="M12 2c1 6 7 6 7 13a7 7 0 0 1-14 0c0-3 2-5 4-7 0 4 2 4 3 3 2-2 1-6 0-9Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  chart: '<path d="M4 3v18h17M8 16v-5M13 16V7M18 16V4"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  bag: '<path d="M4 7h16l1 14H3L4 7Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  pin: '<path d="M19 9c0 6-7 12-7 12S5 15 5 9a7 7 0 0 1 14 0Z"/><circle cx="12" cy="9" r="2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  wifi: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8 16a6 6 0 0 1 8 0M12 20h.01"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  cup: '<path d="M5 9h12v8a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9ZM17 10h2a3 3 0 0 1 0 6h-2M8 2v3M13 2v3"/>',
  receipt: '<path d="M5 2h14v20l-3-2-4 2-4-2-3 2V2ZM8 7h8M8 11h8M8 15h4"/>',
  game: '<path d="M7 7h10c4 0 6 12 3 13-2 1-4-3-5-3H9c-1 0-3 4-5 3C1 19 3 7 7 7Z"/><path d="M8 10v5M5.5 12.5h5M16 11h.1M18 14h.1"/>',
  refresh: '<path d="M20 7A9 9 0 1 0 21 14M20 2v5h-5"/>',
};
export const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.grid}</svg>`;
export const esc = (v = '') =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export const go = (label, target, variant = '', attrs = '') =>
  `<button class="btn ${variant}" data-go="${target}" ${attrs}>${label}</button>`;
export const act = (label, action, variant = '', attrs = '') =>
  `<button class="btn ${variant}" data-action="${action}" ${attrs}>${label}</button>`;
export const pill = (text, color = '') => `<span class="pill ${color}">${esc(text)}</span>`;
export const notice = (text, color = '') =>
  `<div class="notice ${color}" role="status">${icon('info')}<div>${text}</div></div>`;
export const field = (label, value = '', type = 'text', placeholder = '') =>
  `<label class="form-field">${esc(label)}<input type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" /></label>`;
export const summary = (lines) =>
  lines
    .map(
      ([label, value, total]) =>
        `<div class="summary-row ${total ? 'total' : ''}"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join('');
export const navList = (items) =>
  `<div class="card flush">${items.map(([title, sub, target]) => `<button class="list-item" data-go="${target}"><span><strong>${title}</strong><small>${sub}</small></span>${icon('arrow')}</button>`).join('')}</div>`;
export const products = [
  {
    name: 'Pick Combo',
    desc: 'Фингерсы, соус и напиток',
    price: 3490,
    image: 'mockup/i7.jpg',
    category: 'Комбо',
  },
  {
    name: 'Master Combo',
    desc: 'Фингерсы, соус и напиток',
    price: 5690,
    image: 'mockup/i8.jpg',
    category: 'Комбо',
  },
  {
    name: 'Burger Combo',
    desc: 'Фингерсы, соус и напиток',
    price: 6290,
    image: 'mockup/i9.jpg',
    category: 'Комбо',
  },
  {
    name: 'Solo Combo',
    desc: 'Фингерсы, соус и напиток',
    price: 2490,
    image: 'mockup/i10.jpg',
    category: 'Комбо',
  },
  {
    name: 'Finger Duo',
    desc: 'Фингерсы, соус и напиток',
    price: 5690,
    image: 'mockup/i11.jpg',
    category: 'На двоих',
  },
  {
    name: 'Mix Duo',
    desc: 'Фингерсы, соус и напиток',
    price: 6290,
    image: 'mockup/i13.jpg',
    category: 'На двоих',
  },
  {
    name: '25 Fingers',
    desc: 'Фингерсы, соус и напиток',
    price: 12990,
    image: 'mockup/i14.jpg',
    category: 'На компанию',
  },
  {
    name: 'Фингерс',
    desc: 'Куриный фингерс',
    price: 590,
    image: 'mockup/i4.jpg',
    category: 'Допы',
  },
  {
    name: 'Тост',
    desc: 'К любимому комбо',
    price: 290,
    image: 'mockup/i5.jpg',
    category: 'Допы',
  },
  {
    name: 'Coca-Cola',
    desc: '0,5 л',
    price: 690,
    image: 'mockup/i2.jpg',
    category: 'Напитки',
  },
  {
    name: 'Фирменный соус',
    desc: 'К любимому хрусту',
    price: 290,
    image: 'mockup/i18.jpg',
    category: 'Соусы',
  },
];
export const money = (n) => new Intl.NumberFormat('ru-RU').format(n) + ' ₸';
export const photo = (name, alt, cls = '') =>
  `<img class="${cls}" src="/design/prototype/assets/${name}" alt="${esc(alt)}" />`;
export function productGrid(target, category = 'Все') {
  const items =
    category === 'Все' || category === 'Популярное'
      ? products
      : products.filter((p) => p.category === category);
  return items.length
    ? `<div class="product-grid">${items.map((p, i) => `<button class="product-card" data-go="${target}" data-product="${products.indexOf(p)}">${photo(p.image, p.name)}<div class="product-copy"><h3>${p.name}</h3><small>${i === 0 ? 'Выбор гостей' : 'Свежее приготовление'}</small><div class="price-line"><span>${money(p.price)}</span><span class="add-mark" aria-hidden="true">+</span></div></div></button>`).join('')}</div>`
    : notice('В этой категории пока нет доступных блюд. Выберите другую категорию.');
}
export const categories = (chosen = 'Все') =>
  `<div class="chips" aria-label="Категории меню">${['Все', 'Комбо', 'На двоих', 'На компанию', 'Допы', 'Напитки', 'Соусы'].map((c) => `<button class="chip ${c === chosen ? 'selected' : ''}" data-category="${c}" aria-pressed="${c === chosen}">${c}</button>`).join('')}</div>`;
export const timeline = (items) =>
  `<div class="timeline">${items.map(([label, sub, state]) => `<div class="timeline-item ${state}"><span class="timeline-dot"></span><div><strong>${label}</strong><small>${sub}</small></div></div>`).join('')}</div>`;
export function table(headers, rows, target) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th scope="col">${h}</th>`).join('')}<th scope="col">Действие</th></tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}<td><button class="table-action" data-go="${target}">Открыть ${icon('arrow')}</button></td></tr>`).join('')}</tbody></table></div>`;
}
export function qr() {
  return `<div class="qr-demo" role="img" aria-label="Декоративный пример QR, не содержит токен и не сканируется">${Array.from({ length: 81 }, (_, i) => `<i class="${(i * 7 + (i % 9)) % 5 > 2 ? 'blank' : ''}"></i>`).join('')}</div><p class="qr-caption">Демонстрационный QR · не для оплаты</p>`;
}
export const brands = (label) =>
  `<div class="app-logo">${photo('brand-logo.png', 'PickChick')}<span>PickChick <span class="muted">/ ${label}</span></span></div>`;
