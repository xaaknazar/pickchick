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
  ).replace(/\u00a0/g, ' ');
const plural = (n) => {
  const t = n % 10,
    h = n % 100;
  if (t === 1 && h !== 11) return 'позиция';
  if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return 'позиции';
  return 'позиций';
};
const METHOD = {
  cash: ['Қолма-қол ақшамен төлеу', 'Оплата наличными'],
  kaspi_terminal: ['Kaspi терминалында төлеңіз', 'Оплатите на терминале Kaspi'],
  kaspi_manual: ['Kaspi арқылы төлеу', 'Оплата через Kaspi'],
  chocofood: ['ChocoFood арқылы төлеу', 'Оплата ChocoFood'],
  mixed: ['Екі тәсілмен төлеу', 'Оплата двумя способами'],
  other: ['Төлем', 'Оплата'],
};
let shown = '';
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function label(kz, ru) {
  const dt = el('dt', '', kz);
  const small = el('small', '', ru);
  small.lang = 'ru';
  dt.append(small);
  return dt;
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
  const [kz, ru] = METHOD[view.method] ?? ['Төлем', 'Оплата'];
  if (view.method === 'kaspi_terminal' || view.method === 'kaspi_manual') {
    const kaspi = el('img', 'kaspi');
    kaspi.src = '/v2/assets/kaspi.png';
    kaspi.alt = 'Kaspi';
    pay.append(kaspi);
  }
  pay.append(el('p', 'pay-title', kz), el('p', 'ru pay-ru', ru));
  if (view.tendered_minor !== undefined) {
    const box = el('dl', 'cash');
    box.append(label('Алынды', 'Получено'), el('dd', '', money(view.tendered_minor)));
    if (view.change_minor !== undefined)
      box.append(label('Қайтарым', 'Сдача'), el('dd', 'change', money(view.change_minor)));
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
    byId('count').textContent = count + ' дана · ' + count + ' ' + plural(count);
    byId('sum-title').textContent = view.kind === 'pay' ? 'Төлеуге' : 'Барлығы';
    byId('sum-ru').textContent = view.kind === 'pay' ? 'К оплате' : 'Итого';
    const mode = byId('mode');
    mode.textContent =
      view.mode === 'dine' ? 'Залда · В зале' : view.mode === 'take' ? 'Өзіңізбен · С собой' : '';
    mode.hidden = !view.mode;
    drawPay(view);
  }
  if (view.kind === 'done') byId('number').textContent = view.number;
  last = view;
}
draw({ kind: 'idle' });
window.pickchickCustomer?.onView(draw);
