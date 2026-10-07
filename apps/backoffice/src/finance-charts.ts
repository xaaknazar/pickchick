import { element as el } from './dom.js';
import { money, type FinanceSnapshot } from './finance-model.js';
import { chartWidth, percent, reportData, timeSeries, type Basis } from './finance-report.js';

export function expenseChart(d: FinanceSnapshot, basis: Basis, open: (category: string) => void) {
  const section = el('section', 'finance-chart');
  section.append(el('h3', '', 'На что уходят деньги'));
  if (basis === 'pnl') section.querySelector('h3')!.textContent = 'Структура расходов';
  const report = reportData(d, basis);
  const entries = report.lines
    .filter((c) => c.direction === 'out' && c.value > 0n)
    .sort((a, b) =>
      a.value === b.value ? a.name.localeCompare(b.name, 'ru') : a.value > b.value ? -1 : 1,
    );
  if (!entries.length) {
    section.append(el('p', 'muted', 'За этот период расходы не внесены.'));
    return section;
  }
  section.append(el('p', 'muted', 'Крупнейшие статьи. Нажмите на статью, чтобы открыть операции.'));
  const list = el('ol', 'finance-ranking');
  const top = entries.slice(0, 6);
  const rest = entries.slice(6).reduce((n, c) => n + c.value, 0n);
  const maximum = entries[0]!.value > rest ? entries[0]!.value : rest;
  const row = (name: string, value: bigint, id?: string) => {
    const item = el('li');
    const caption = el('div', 'finance-rank-label');
    const label = id ? el('button', 'finance-link', name) : el('span', '', name);
    if (id) label.addEventListener('click', () => open(id));
    caption.append(label, el('strong', '', money(String(value))));
    const track = el('div', 'finance-track');
    track.setAttribute('aria-hidden', 'true');
    const bar = el('span');
    bar.style.width = `${chartWidth(value, maximum)}%`;
    track.append(bar);
    item.append(
      caption,
      track,
      el('small', 'muted', `${percent(value, report.outgoing)} всех расходов`),
    );
    list.append(item);
  };
  top.forEach((c) => row(c.name, c.value, c.id));
  if (rest) row('Остальные статьи', rest);
  section.append(list);
  return section;
}

const svgNS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const node = document.createElementNS(svgNS, tag);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
  return node;
}
export function trendChart(d: FinanceSnapshot, basis: Basis, start: string, end: string) {
  const section = el('section', 'finance-chart');
  const series = timeSeries(d, basis, start, end);
  section.append(el('h3', '', 'Динамика за период'));
  if (!series) {
    section.append(
      el(
        'p',
        'muted',
        'Динамика появится после обновления финансового API. Итоги периода доступны ниже.',
      ),
    );
    return section;
  }
  const { points, monthly } = series;
  const incoming = basis === 'cash' ? 'Поступления' : 'Доходы';
  const outgoing = basis === 'cash' ? 'Выплаты' : 'Расходы';
  const max = points.reduce(
    (n, p) =>
      n > p.incoming && n > p.outgoing ? n : p.incoming > p.outgoing ? p.incoming : p.outgoing,
    0n,
  );
  if (!max) {
    section.append(el('p', 'muted', 'Добавьте операции за этот период, чтобы увидеть динамику.'));
    return section;
  }
  const legend = el('p', 'finance-legend');
  legend.append(
    el('span', 'finance-in', incoming),
    el('span', 'finance-out', outgoing),
    el('span', 'muted', monthly ? 'По месяцам, ₸' : 'По дням, ₸'),
  );
  section.append(legend);
  const graphic = svg('svg', {
    viewBox: '0 0 640 265',
    role: 'img',
    'aria-label': `${incoming} и ${outgoing.toLocaleLowerCase('ru')} ${monthly ? 'по месяцам' : 'по дням'}. Точные значения в таблице под графиком.`,
  });
  for (let step = 0; step <= 2; step++) {
    const y = 30 + step * 95;
    graphic.append(svg('line', { x1: 8, x2: 632, y1: y, y2: y, stroke: '#d9e1ea' }));
  }
  const width = 616 / Math.max(points.length, 1);
  points.forEach((p, i) => {
    const group = svg('g', {});
    const label = monthly
      ? p.date.slice(5) + '.' + p.date.slice(0, 4)
      : p.date.slice(8) + '.' + p.date.slice(5, 7);
    const title = svg('title', {});
    title.textContent = `${label}: ${incoming} ${money(String(p.incoming))}, ${outgoing} ${money(String(p.outgoing))}`;
    group.append(title);
    [p.incoming, p.outgoing].forEach((v, index) => {
      const h = chartWidth(v, max) * 1.9;
      group.append(
        svg('rect', {
          x: 12 + i * width + index * width * 0.38,
          y: 220 - h,
          width: width * 0.32,
          height: h,
          rx: 1,
          fill: index ? '#b6450c' : '#0047bb',
        }),
      );
    });
    if (i % Math.ceil(points.length / 6) === 0 || i === points.length - 1) {
      const text = svg('text', { x: 12 + i * width, y: 247, fill: '#526175', 'font-size': 12 });
      text.textContent = label;
      group.append(text);
    }
    graphic.append(group);
  });
  section.append(
    el('p', 'muted finance-chart-scale', `Шкала: от 0 до ${money(String(max))}`),
    graphic,
  );
  const detail = el('details', 'finance-chart-data');
  detail.append(el('summary', '', 'Точные значения по датам'));
  const table = el('table');
  const head = el('thead'),
    header = el('tr');
  [monthly ? 'Месяц' : 'Дата', incoming, outgoing, 'Разница'].forEach((label) =>
    header.append(el('th', '', label)),
  );
  head.append(header);
  const body = el('tbody');
  points.forEach((p) => {
    const row = el('tr');
    [
      p.date,
      money(String(p.incoming)),
      money(String(p.outgoing)),
      money(String(p.incoming - p.outgoing)),
    ].forEach((value) => row.append(el('td', '', value)));
    body.append(row);
  });
  table.append(head, body);
  const scroll = el('div', 'table-scroll');
  scroll.append(table);
  detail.append(scroll);
  section.append(detail);
  return section;
}
