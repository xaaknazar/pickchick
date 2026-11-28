// The guest's screen of a dual-screen till. Main sends a validated view; this page only draws it.
// Kinds: idle (welcome), order (lines and total), pay (amount and how to pay), done (number).
const screen = document.getElementById('screen');
const lines = document.getElementById('lines');
const byId = (id) => document.getElementById(id);
const money = (minor) =>
  (
    Number(BigInt(minor) / 100n).toLocaleString('ru-RU') +
    (BigInt(minor) % 100n ? ',' + String(BigInt(minor) % 100n).padStart(2, '0') : '') +
    ' ₸'
  ).replace(/ /g, ' ');
const plural = (n) => {
  const t = n % 10,
    h = n % 100;
  if (t === 1 && h !== 11) return 'позиция';
  if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return 'позиции';
  return 'позиций';
};
const METHOD = {
  cash: ['Оплата наличными', 'Қолма-қол ақшамен төлеу'],
  kaspi_terminal: ['Оплатите на терминале Kaspi', 'Kaspi терминалында төлеңіз'],
  kaspi_manual: ['Оплата через Kaspi', 'Kaspi арқылы төлеу'],
  chocofood: ['Оплата ChocoFood', 'ChocoFood арқылы төлеу'],
  mixed: ['Оплата двумя способами', 'Екі тәсілмен төлеу'],
  other: ['Оплата', 'Төлем'],
};
let shown = '';
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function drawLines(view, previous) {
  const before = new Map(
    (previous?.lines ?? []).map((l) => [l.name + '|' + (l.mods ?? ''), l.qty]),
  );
  lines.replaceChildren(
    ...view.lines.map((line) => {
      const row = el('li', 'line');
      const key = line.name + '|' + (line.mods ?? '');
      if (before.get(key) !== line.qty) row.classList.add('fresh');
      row.append(el('span', 'qty', '×' + line.qty));
      const name = el('div', 'name');
      name.append(el('strong', '', line.name));
      if (line.mods) name.append(el('small', '', line.mods));
      row.append(name, el('b', 'line-sum', money(line.sum_minor)));
      return row;
    }),
  );
  const last = lines.querySelector('.fresh') ?? lines.lastElementChild;
  last?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function drawPay(view) {
  const pay = byId('pay');
  pay.replaceChildren();
  if (view.kind !== 'pay') return;
  const [ru, kz] = METHOD[view.method] ?? ['Оплата', 'Төлем'];
  if (view.method === 'kaspi_terminal' || view.method === 'kaspi_manual') {
    const kaspi = el('img', 'kaspi');
    kaspi.src = '/v2/assets/kaspi.png';
    kaspi.alt = 'Kaspi';
    pay.append(kaspi);
  }
  pay.append(el('p', 'pay-title', ru), el('p', 'kz pay-kz', kz));
  if (view.tendered_minor !== undefined) {
    const box = el('dl', 'cash');
    box.append(el('dt', '', 'Получено'), el('dd', '', money(view.tendered_minor)));
    if (view.change_minor !== undefined)
      box.append(el('dt', '', 'Сдача'), el('dd', 'change', money(view.change_minor)));
    pay.append(box);
  }
}
let last = null;
function draw(view) {
  const key = JSON.stringify(view);
  if (key === shown) return;
  shown = key;
  screen.className = 'screen ' + (view.kind === 'pay' ? 'order paying' : view.kind);
  if (view.kind === 'order' || view.kind === 'pay') {
    drawLines(view, last?.lines ? last : null);
    const count = view.lines.reduce((n, l) => n + l.qty, 0);
    byId('total').textContent = money(view.total_minor);
    byId('count').textContent = count + ' ' + plural(count);
    byId('sum-title').textContent = view.kind === 'pay' ? 'К оплате' : 'Итого';
    byId('sum-kz').textContent = view.kind === 'pay' ? 'Төлеуге' : 'Барлығы';
    const mode = byId('mode');
    mode.textContent =
      view.mode === 'dine' ? 'В зале · Залда' : view.mode === 'take' ? 'С собой · Өзіңізбен' : '';
    mode.hidden = !view.mode;
    drawPay(view);
  }
  if (view.kind === 'done') byId('number').textContent = view.number;
  last = view;
}
draw({ kind: 'idle' });
window.pickchickCustomer?.onView(draw);
