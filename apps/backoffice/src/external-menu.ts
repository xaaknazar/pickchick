/**
 * External menu of the delivery aggregators (Yandex Eda, Glovo) in «Меню и цены».
 *
 * One catalog, one stop list: an aggregator menu is the set of products that carry that
 * aggregator's price (channel_prices_minor.yandex_eda / glovo, cutover Аг4). An empty price means
 * the product is not sold there. The manager types the prices here into the catalog draft; they
 * are saved and published with the usual «Сохранить черновик» / «Опубликовать…». Only the
 * cashier receives them (orders typed in from the aggregator tablets); the kiosk and the app
 * never do. Option surcharges stay the hall surcharges (contracts 5.3, P0).
 */
import { AGGREGATOR_CHANNELS, copy, money, setChannelPrice, channelPriceInput } from './domain.js';
import type { CatalogPayload, PublicationSupport } from './domain.js';
import { element as el, button, field, select } from './dom.js';

type Product = CatalogPayload['products'][number];
export type AggregatorChannel = (typeof AGGREGATOR_CHANNELS)[number];
export const AGGREGATOR_LABELS: Record<AggregatorChannel, string> = {
  yandex_eda: 'Яндекс Еда',
  glovo: 'Glovo',
};
export type ExternalFilter = 'all' | 'yandex_eda' | 'glovo' | 'none';

/** How many products each aggregator sells, and how many are sold on no aggregator. */
export function externalMenuSummary(products: readonly Product[]) {
  const has = (p: Product, c: AggregatorChannel) => p.channel_prices_minor?.[c] !== undefined;
  return {
    total: products.length,
    yandex_eda: products.filter((p) => has(p, 'yandex_eda')).length,
    glovo: products.filter((p) => has(p, 'glovo')).length,
    none: products.filter((p) => !has(p, 'yandex_eda') && !has(p, 'glovo')).length,
  };
}

/**
 * A copy of the product with one aggregator price set from a tenge field (empty removes it),
 * or null when the text is not a valid amount. Every other field stays exactly as it was.
 */
export function withAggregatorPrice(
  product: Product,
  channel: AggregatorChannel,
  input: string,
): Product | null {
  const next = copy(product);
  return setChannelPrice(next, channel, input) ? next : null;
}

/**
 * Products whose empty `to` price takes the `from` price (in iiko the Yandex and Glovo prices
 * matched on every shared article). Filled `to` prices are never overwritten.
 */
export function copyAggregatorPrices(
  products: readonly Product[],
  from: AggregatorChannel,
  to: AggregatorChannel,
): Product[] {
  const changed: Product[] = [];
  for (const p of products) {
    const source = p.channel_prices_minor?.[from];
    if (source === undefined || p.channel_prices_minor?.[to] !== undefined) continue;
    const next = copy(p);
    next.channel_prices_minor = { ...next.channel_prices_minor, [to]: source };
    changed.push(next);
  }
  return changed;
}

export function filterExternal(
  products: readonly Product[],
  query: string,
  filter: ExternalFilter,
): Product[] {
  const q = query.trim().toLocaleLowerCase();
  return products.filter((p) => {
    const prices = p.channel_prices_minor ?? {};
    if (filter === 'yandex_eda' && prices.yandex_eda === undefined) return false;
    if (filter === 'glovo' && prices.glovo === undefined) return false;
    if (filter === 'none' && (prices.yandex_eda !== undefined || prices.glovo !== undefined))
      return false;
    return !q || [p.name.ru, p.name.kk, p.sku, p.id].join(' ').toLocaleLowerCase().includes(q);
  });
}

export type ExternalMenuContext = {
  payload: CatalogPayload;
  support: PublicationSupport | undefined;
  /** Saving is impossible right now (a request is in flight or unconfirmed). */
  disabled: boolean;
  /** Stage changed products into the draft; throws with a message the view shows. */
  apply: (products: Product[]) => void;
};

/** View state kept between renders (every draft change re-renders the page). */
const view = { query: '', filter: 'all' as ExternalFilter, focus: '', error: '' };

export function renderExternalMenu(content: HTMLElement, ctx: ExternalMenuContext) {
  const products = ctx.payload.products;
  const published = ctx.support?.aggregator_prices === true;
  const panel = el('section', 'panel external-menu');
  panel.dataset.testid = 'external-menu';
  const toolbar = el('div', 'panel-toolbar');
  toolbar.append(el('h2', '', 'Внешнее меню: Яндекс Еда и Glovo'));
  const intro = el('div', 'external-intro');
  panel.append(toolbar, intro);
  intro.append(
    el(
      'p',
      'muted',
      'Меню и стоп-лист одни для всех каналов. Здесь задаются только цены агрегаторов. Позиция продаётся у агрегатора, если у неё есть его цена; пустое поле означает «не продаётся». Доплаты за модификаторы - как в зале. Цены получает только касса: по ним кассир пробивает заказы с планшетов Яндекса и Glovo. Приложение и киоск продают по цене зала.',
    ),
  );
  const status = el(
    'p',
    published ? 'notice' : 'notice warn',
    published
      ? 'Цены агрегаторов включены: после «Сохранить черновик» и «Опубликовать…» касса получит их с новой версией меню.'
      : 'Публикация цен агрегаторов на кассу на сервере ещё не включена. Цены можно вносить и сохранять в черновике, но пока в черновике есть хотя бы одна цена агрегатора, опубликовать меню нельзя. Если нужно опубликовать другие изменения раньше, вносите цены агрегаторов после включения.',
  );
  status.dataset.testid = 'external-menu-status';
  intro.append(status);
  const summary = externalMenuSummary(products);
  const stats = el('div', 'stats');
  for (const [label, value] of [
    ['Позиций в меню', summary.total],
    ['Продаются в Яндекс Еде', summary.yandex_eda],
    ['Продаются в Glovo', summary.glovo],
    ['Без цен агрегаторов', summary.none],
  ] as const) {
    const s = el('div', 'stat');
    s.append(el('span', 'muted', label), el('strong', '', String(value)));
    stats.append(s);
  }
  stats.dataset.testid = 'external-menu-summary';
  intro.append(stats);
  if (view.error) {
    const e = el('p', 'notice error', view.error);
    e.setAttribute('role', 'alert');
    e.dataset.testid = 'external-menu-error';
    intro.append(e);
  }
  const filters = el('div', 'filters');
  const search = field(
    'Поиск',
    view.query,
    (v) => {
      view.query = v;
      rows();
    },
    { id: 'external-search', max: 150 },
  );
  search.querySelector('input')!.placeholder = 'Название или артикул';
  filters.append(
    search,
    select(
      'Показать',
      view.filter,
      [
        { value: 'all', label: 'Все позиции' },
        { value: 'yandex_eda', label: 'Продаются в Яндекс Еде' },
        { value: 'glovo', label: 'Продаются в Glovo' },
        { value: 'none', label: 'Без цен агрегаторов' },
      ],
      (v) => {
        view.filter = v as ExternalFilter;
        rows();
      },
      'external-filter',
    ),
  );
  const copyable = copyAggregatorPrices(products, 'yandex_eda', 'glovo');
  const copyButton = button(
    `Заполнить пустые цены Glovo ценами Яндекса (${copyable.length})`,
    () => {
      if (
        !window.confirm(
          `Подставить цену Яндекс Еды в пустое поле Glovo у ${copyable.length} позиций? Заполненные цены Glovo не изменятся. Изменения попадут только в черновик.`,
        )
      )
        return;
      stage(copyable);
    },
    'button small external-copy',
    'external-copy-yandex-glovo',
  );
  copyButton.disabled = ctx.disabled || !copyable.length;
  filters.append(copyButton);
  panel.append(filters);
  const wrap = el('div', 'table-scroll'),
    table = el('table'),
    head = el('thead'),
    hr = el('tr'),
    body = el('tbody');
  wrap.tabIndex = 0;
  wrap.setAttribute('aria-label', 'Таблица цен агрегаторов, горизонтальная прокрутка');
  for (const h of ['Позиция', 'Цена зала', 'Яндекс Еда, ₸', 'Glovo, ₸']) hr.append(el('th', '', h));
  head.append(hr);
  body.dataset.testid = 'external-rows';
  table.append(head, body);
  wrap.append(table);
  const count = el('p', 'table-count');
  panel.append(wrap, count);
  content.append(panel);
  // Focus that leaves the table on purpose is not restored; a re-render (which removes this
  // panel, and with it the focused field) keeps it.
  panel.addEventListener('focusout', () =>
    setTimeout(() => {
      if (panel.isConnected && !panel.contains(document.activeElement)) view.focus = '';
    }, 0),
  );

  function stage(changed: Product[]) {
    try {
      ctx.apply(changed);
      view.error = '';
    } catch (error) {
      view.error = error instanceof Error ? error.message : String(error);
      // Nothing re-rendered: show the reason in place.
      const old = panel.querySelector('[data-testid="external-menu-error"]');
      const e = el('p', 'notice error', view.error);
      e.setAttribute('role', 'alert');
      e.dataset.testid = 'external-menu-error';
      if (old) old.replaceWith(e);
      else stats.after(e);
    }
  }
  function priceInput(p: Product, channel: AggregatorChannel) {
    const input = el('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.id = input.dataset.testid = `external-${channel}-${p.id}`;
    input.value = channelPriceInput(p, channel);
    input.placeholder = 'не продаётся';
    input.setAttribute('aria-label', `${p.name.ru}: цена в ${AGGREGATOR_LABELS[channel]}, тенге`);
    input.disabled = ctx.disabled;
    input.addEventListener('focusin', () => (view.focus = input.id));
    // Applied on change (leaving the field), after focus has moved: the re-render keeps it.
    input.addEventListener('change', () => {
      const next = withAggregatorPrice(p, channel, input.value);
      if (!next) {
        input.setAttribute('aria-invalid', 'true');
        input.title = 'Введите сумму в тенге, например 2390 или 2390,50';
        return;
      }
      if (channelPriceInput(next, channel) === channelPriceInput(p, channel)) return;
      setTimeout(() => stage([next]), 0);
    });
    return input;
  }
  function rows() {
    body.replaceChildren();
    const visible = filterExternal(products, view.query, view.filter);
    for (const p of visible) {
      const r = el('tr');
      r.dataset.testid = `external-${p.id}`;
      const name = el('td');
      name.append(el('strong', '', p.name.ru), el('small', 'muted', p.sku));
      if (!p.available) name.append(el('small', 'muted', 'Скрыта из меню'));
      const yandex = el('td'),
        glovo = el('td');
      yandex.append(priceInput(p, 'yandex_eda'));
      glovo.append(priceInput(p, 'glovo'));
      r.append(name, el('td', 'price', money(p.price_minor)), yandex, glovo);
      body.append(r);
    }
    if (!visible.length) {
      const r = el('tr'),
        td = el('td', 'empty', 'По запросу ничего не найдено.');
      td.colSpan = 4;
      r.append(td);
      body.append(r);
    }
    count.textContent = `Показано ${visible.length} из ${products.length}`;
  }
  rows();
  // The page attaches this panel after the render; refocus the price field the manager was in.
  const restore = view.focus;
  if (restore)
    requestAnimationFrame(() => {
      const target = panel.querySelector<HTMLElement>('#' + CSS.escape(restore));
      if (target && panel.isConnected && !target.hasAttribute('disabled')) target.focus();
    });
}
