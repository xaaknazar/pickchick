import { element as el, button, field, select } from './dom.js';
import { almatyDateTime, labelledCards } from './ui-fixes.js';
import {
  CONSUMPTION_STATES,
  coverageText,
  coverageWarning,
  filterLinks,
  isDraft,
  itemDocument,
  itemNeeds,
  itemReason,
  itemTitle,
  linkStatus,
  linkText,
  modeText,
  needsLink,
  queueActions,
  queueSummary,
  saleLabel,
  stateLabel,
  type ConsumptionView,
  type LinkFilter,
  type MenuLinksView,
} from './autoconsume-model.js';

type Data = Record<string, unknown>;
/**
 * What the stock page hands to «Списание по продажам» (lane bo-ui step 5). `links` exists with
 * capabilities.stock_p1, `consumption` with capabilities.stock_autoconsume. An action is null
 * when the role may not do it; `rights` then says who may, in words.
 */
export type AutoconsumeCallbacks = {
  links: () => Promise<MenuLinksView>;
  consumption?: (state: string, date: string) => Promise<ConsumptionView>;
  editLink: ((item: Data) => void) | null;
  approve: ((items: Data[]) => void) | null;
  mode: ((view: ConsumptionView) => void) | null;
  retry: ((item: Data) => void) | null;
  skip: ((item: Data) => void) | null;
  rights: (permission: string) => string | null;
  /** The branch mode as soon as it is known (the stock page notice follows it). */
  onMode?: (view: ConsumptionView) => void;
};
function table(head: string[], rows: (string | Node)[][], empty: string) {
  const wrap = el('div', 'inventory-table'),
    t = el('table', 'op-table'),
    h = el('thead'),
    tr = el('tr');
  for (const text of head) {
    const th = el('th', '', text);
    th.scope = 'col';
    tr.append(th);
  }
  h.append(tr);
  const body = el('tbody');
  for (const cells of rows) {
    const row = el('tr');
    for (const cell of cells) {
      const td = el('td');
      td.append(cell);
      row.append(td);
    }
    body.append(row);
  }
  t.append(h, body);
  wrap.append(t);
  if (!rows.length) wrap.append(el('p', 'op-note', empty));
  return labelledCards(wrap, head);
}
const failure = (what: string) => `${what} не загрузились. Проверьте связь и нажмите «Обновить».`;

/**
 * «Списание по продажам» of the stock page: the branch mode with its coverage, the queue of the
 * automatic consumption and the menu-stock links table. Loads its own views; a reload of the
 * page snapshot (`stamp`) reloads them.
 */
export class AutoconsumeView {
  private stamp = '';
  private links: MenuLinksView | null = null;
  private linksError = '';
  private queue: ConsumptionView | null = null;
  private queueError = '';
  private filter: LinkFilter = 'all';
  private state = '';
  private date = '';
  private reload: () => void = () => undefined;
  /** The boxes of the last render: a load that ends later draws into the page that is shown. */
  private shown: {
    mode: HTMLElement;
    queue: HTMLElement;
    links: HTMLElement;
    callbacks: AutoconsumeCallbacks;
  } | null = null;
  private draw() {
    const v = this.shown;
    if (!v) return;
    this.drawMode(v.mode, v.callbacks);
    this.drawQueue(v.queue, v.callbacks);
    this.drawLinks(v.links, v.callbacks);
  }
  render(stamp: string, callbacks: AutoconsumeCallbacks) {
    const root = el('div', 'autoconsume');
    root.dataset.testid = 'autoconsume';
    const modeBox = el('section', 'autoconsume-mode'),
      queueBox = el('section', 'autoconsume-queue'),
      linksBox = el('section', 'autoconsume-links');
    this.shown = { mode: modeBox, queue: queueBox, links: linksBox, callbacks };
    const load = () => {
      const jobs: Promise<unknown>[] = [
        callbacks
          .links()
          .then((v) => {
            this.links = v;
            this.linksError = '';
          })
          .catch(() => {
            this.linksError = failure('Связи меню');
          }),
      ];
      if (callbacks.consumption)
        jobs.push(
          callbacks
            .consumption(this.state, this.date)
            .then((v) => {
              this.queue = v;
              this.queueError = '';
              callbacks.onMode?.(v);
            })
            .catch(() => {
              this.queueError = failure('Очередь и режим');
            }),
        );
      void Promise.all(jobs).then(() => this.draw());
    };
    this.reload = load;
    root.append(
      el(
        'p',
        'op-note',
        'Продажи кассы и заказы приложения и киоска списываются по связям «позиция меню - склад», которые утверждает шеф через управляющего. Комбо без своей связи списываются по составу, выход ТТК - как выбрано в техкарте: на сырьё или сам выход (без выбора продажа не спишется). Один документ на заказ.',
      ),
      button('Обновить', load, 'button subtle', 'autoconsume-reload'),
      ...(callbacks.consumption ? [modeBox, queueBox] : []),
      linksBox,
    );
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      load();
    }
    this.draw();
    return root;
  }
  private drawMode(box: HTMLElement, c: AutoconsumeCallbacks) {
    box.replaceChildren(el('h3', '', 'Режим'));
    if (this.queueError) {
      const n = el('p', 'notice error', this.queueError);
      n.setAttribute('role', 'alert');
      box.append(n);
      return;
    }
    const v = this.queue;
    if (!v) {
      box.append(el('p', 'op-note', 'Загружаем режим и очередь...'));
      return;
    }
    const line = el('p', 'autoconsume-mode-line', `Списание по продажам: ${modeText(v.settings)}`);
    line.dataset.testid = 'autoconsume-mode';
    box.append(line);
    if (v.settings.updated_by_name && v.settings.updated_at)
      box.append(
        el(
          'p',
          'op-note',
          `Изменил: ${v.settings.updated_by_name}, ${almatyDateTime(v.settings.updated_at)}.`,
        ),
      );
    const coverage = el('p', 'op-note', coverageText(v.coverage));
    coverage.dataset.testid = 'autoconsume-coverage';
    box.append(coverage);
    const warning = coverageWarning(v.coverage);
    if (warning) {
      const n = el('p', 'notice', warning);
      n.dataset.testid = 'autoconsume-coverage-low';
      box.append(n);
    }
    if (c.mode)
      box.append(button('Изменить режим', () => c.mode!(v), 'button', 'autoconsume-mode-edit'));
    else {
      const r = c.rights('stock.settings');
      if (r) box.append(el('p', 'op-note op-rights', r));
    }
  }
  private drawQueue(box: HTMLElement, c: AutoconsumeCallbacks) {
    box.replaceChildren(el('h3', '', 'Очередь списания'));
    const v = this.queue;
    if (!v) return;
    const summary = el('p', 'op-note', queueSummary(v));
    summary.dataset.testid = 'autoconsume-summary';
    const filters = el('div', 'inventory-filters');
    filters.append(
      select(
        'Состояние',
        this.state,
        [
          { value: '', label: 'Все' },
          ...CONSUMPTION_STATES.map((s) => ({
            value: s,
            label: `${stateLabel(s)} (${v.counts[s] ?? 0})`,
          })),
        ],
        (value) => {
          this.state = value;
        },
        'autoconsume-state',
      ),
      field(
        'День продажи',
        this.date,
        (value) => {
          this.date = value;
        },
        { id: 'autoconsume-date', type: 'date' },
      ),
      button('Показать', () => this.reload(), 'button', 'autoconsume-filter'),
    );
    const mode = v.settings.autoconsume_mode;
    const rows = v.items.map((item) => {
      const actions = el('div', 'autoconsume-actions');
      const allowed = queueActions(item, mode);
      if (allowed.retry && c.retry)
        actions.append(
          button('Повторить', () => c.retry!(item), 'button small', 'autoconsume-retry'),
        );
      if (allowed.skip && c.skip)
        actions.append(
          button(
            'Пропустить с причиной',
            () => c.skip!(item),
            'button small subtle',
            'autoconsume-skip',
          ),
        );
      if ((allowed.retry || allowed.skip) && !c.retry && !c.skip) {
        const r = c.rights('consumption.write');
        if (r) actions.append(el('small', 'muted', r));
      }
      const state = el(
        'span',
        'autoconsume-state-' + String(item['state']),
        stateLabel(item['state']),
      );
      return [
        saleLabel(item),
        almatyDateTime(item['sold_at']),
        state,
        itemReason(item),
        itemNeeds(item),
        itemDocument(item),
        actions.childElementCount ? actions : '-',
      ];
    });
    box.append(
      summary,
      filters,
      table(
        ['Продажа', 'Время продажи', 'Состояние', 'Причина', 'Списание', 'Документ', 'Действия'],
        rows,
        'В очереди нет продаж по выбранным условиям.',
      ),
    );
    if (v.truncated)
      box.append(el('p', 'op-note', 'Показаны последние 200 продаж. Уточните день или состояние.'));
  }
  private drawLinks(box: HTMLElement, c: AutoconsumeCallbacks) {
    box.replaceChildren(el('h3', '', 'Связи меню со складом'));
    if (this.linksError) {
      const n = el('p', 'notice error', this.linksError);
      n.setAttribute('role', 'alert');
      box.append(n);
      return;
    }
    const v = this.links;
    if (!v) {
      box.append(el('p', 'op-note', 'Загружаем меню и связи...'));
      return;
    }
    if (!v.catalog) {
      box.append(el('p', 'notice', 'Меню точки ещё не опубликовано: связывать пока нечего.'));
      return;
    }
    const products = new Map(
      v.items
        .filter((i) => i['kind'] !== 'option')
        .map((i) => [String(i['catalog_key']), String(i['name_ru'])]),
    );
    const missing = v.items.filter(needsLink).length;
    const drafts = v.items.filter(isDraft).length;
    const counts = el(
      'p',
      'op-note',
      `Меню версии ${v.catalog.version}: позиций ${v.coverage.items}, со связью ${v.coverage.linked}, утверждено ${v.coverage.approved}.`,
    );
    counts.dataset.testid = 'autoconsume-links-coverage';
    const filters = el('div', 'inventory-filters');
    filters.append(
      select(
        'Показать',
        this.filter,
        [
          { value: 'all', label: `Все (${v.items.length})` },
          { value: 'missing', label: `Без связи: ${missing}` },
          { value: 'draft', label: `Черновики: ${drafts}` },
        ],
        (value) => {
          this.filter = value as LinkFilter;
          this.drawLinks(box, c);
        },
        'autoconsume-links-filter',
      ),
    );
    if (c.approve && drafts)
      filters.append(
        button(
          `Утвердить черновики (${drafts})`,
          () => c.approve!(v.items.filter(isDraft)),
          'button primary',
          'autoconsume-approve-all',
        ),
      );
    const rights = !c.editLink ? c.rights('menu_links.write') : null;
    const rows = filterLinks(v.items, this.filter).map((item) => {
      const link = item['link'] as Data | null;
      const name = el('div');
      name.append(el('strong', '', itemTitle(item)));
      if (item['kind'] === 'combo' || item['kind'] === 'set')
        name.append(el('small', 'muted', item['kind'] === 'set' ? ' Набор' : ' Комбо'));
      if (item['listed'] !== true) name.append(el('small', 'muted', ' Не в продаже'));
      const actions = el('div', 'autoconsume-actions');
      if (c.editLink)
        actions.append(
          button(
            link ? 'Изменить' : 'Связать',
            () => c.editLink!(item),
            'button small',
            'autoconsume-link-edit',
          ),
        );
      if (c.approve && link && isDraft(item))
        actions.append(
          button(
            'Утвердить',
            () => c.approve!([item]),
            'button small subtle',
            'autoconsume-link-approve',
          ),
        );
      const who = link
        ? `${String(link['updated_by_name'] ?? '')}, ${almatyDateTime(link['updated_at'])}${link['approved_by_name'] ? `. Утвердил: ${String(link['approved_by_name'])}` : ''}`
        : '-';
      return [
        name,
        linkText(link),
        linkStatus(item, products),
        who,
        actions.childElementCount ? actions : '-',
      ];
    });
    box.append(
      counts,
      filters,
      ...(rights ? [el('p', 'op-note op-rights', rights)] : []),
      table(
        ['Позиция меню', 'Связь со складом', 'Статус', 'Изменения', 'Действия'],
        rows,
        'Нет позиций по выбранному фильтру.',
      ),
    );
    if (v.orphans.length)
      box.append(
        el(
          'p',
          'op-note',
          `Связей без позиции в текущем меню: ${v.orphans.length} (${v.orphans.map((o) => String(o['catalog_key'])).join(', ')}). Позицию переименовали в каталоге: свяжите её заново.`,
        ),
      );
  }
}
