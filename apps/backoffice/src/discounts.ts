import { element as el, button, field, select, check } from './dom.js';
import { ApiError, message } from './api.js';
import { almatyDateTime, labelledCards } from './ui-fixes.js';
import {
  guard,
  mayClose,
  readDraft,
  sessionStore,
  settle,
  writeDraft,
  dropDraft,
} from './dialog-guard.js';
import {
  ACTION_LABELS,
  ACTION_REASONS,
  ACTION_TEXTS,
  CHANNEL_LABELS,
  DISCOUNT_BANNER,
  DISCOUNT_CHANNELS,
  DISCOUNT_ERRORS,
  FILTERS,
  HOUR_WINDOWS,
  NAME_MAX,
  WEEKDAYS,
  channelsText,
  conditionsText,
  emptyForm,
  formOf,
  formPayload,
  saveCommand,
  scopeText,
  stateActions,
  stateCommand,
  stateText,
  valueText,
  visible,
  whenText,
  type Discount,
  type DiscountForm,
  type DiscountState,
  type DiscountsView,
  type Filter,
} from './discounts-model.js';

type Data = Record<string, unknown>;
/**
 * What app.ts hands to «Скидки» (lane bo-ui step 7). `execute` sends one command with its reason
 * and answers null on success or the error itself (the page says it in words).
 */
export type DiscountCallbacks = {
  load: (id?: string) => Promise<DiscountsView>;
  execute: (command: Data, reason: string) => Promise<unknown>;
  can: (permission: string) => boolean;
  rights: (permission: string) => string | null;
  /** actor:branch, the key of the editor drafts of this person and branch. */
  scope: () => string;
  changed: () => void;
};
const DRAFT = 'pickchick.backoffice.discount.v1';
/** A discount command error in words: the discount reasons first, then the cabinet's text. */
export function discountErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const precise = error.reason ? DISCOUNT_ERRORS[error.reason] : undefined;
    if (precise) return precise;
    if (!error.reason && DISCOUNT_ERRORS[error.code]) return DISCOUNT_ERRORS[error.code]!;
  }
  return message(error);
}

function dialog(title: string, sub: string, testId: string) {
  const d = el('dialog', 'op-dialog dc-dialog'),
    head = el('div', 'panel-head'),
    close = button(
      'Закрыть',
      () => {
        if (!mayClose(d)) return;
        d.close();
        d.remove();
      },
      'button subtle',
      'dc-close',
    );
  d.dataset.testid = testId;
  head.append(el('h2', '', title), close);
  d.append(head);
  if (sub) d.append(el('p', 'op-note', sub));
  document.body.append(d);
  d.showModal();
  d.addEventListener('close', () => d.remove(), { once: true });
  return d;
}
function table(head: readonly string[], rows: (string | Node)[][], empty: string) {
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
function fieldset(legend: string, testId: string) {
  const f = el('fieldset', 'dc-group');
  f.dataset.testid = testId;
  f.append(el('legend', '', legend));
  return f;
}

/**
 * «Скидки» (design-bo-ui 5.8): the banner that the POS does not apply discounts yet, the list with
 * state, period and conditions, the editor (create, edit), switch on and off, the archive and the
 * history of a discount. The manager edits (discounts.write); every other role reads and is told
 * why the buttons are missing. Loads its own view.
 */
export class DiscountsPage {
  private view: DiscountsView | null = null;
  private error = '';
  private loading = false;
  private loadedFor = '';
  private filter: Filter = 'live';
  constructor(private cb: DiscountCallbacks) {}
  clear() {
    this.view = null;
    this.error = '';
    this.loadedFor = '';
    this.filter = 'live';
  }
  async reload() {
    this.loading = true;
    this.cb.changed();
    try {
      this.view = await this.cb.load();
      this.error = '';
    } catch {
      this.error = 'Скидки не загрузились. Проверьте связь и нажмите «Обновить».';
    } finally {
      this.loading = false;
      this.cb.changed();
    }
  }
  render(host: HTMLElement) {
    const scope = this.cb.scope();
    if (this.loadedFor !== scope && !this.loading) {
      this.loadedFor = scope;
      void this.reload();
    }
    const p = el('section', 'panel discounts');
    p.dataset.testid = 'discounts';
    const banner = el('p', 'notice dc-banner');
    banner.setAttribute('role', 'status');
    banner.dataset.testid = 'dc-banner';
    banner.append(el('strong', '', DISCOUNT_BANNER));
    const head = el('div', 'panel-head');
    head.append(el('h2', '', 'Скидки'));
    const tools = el('div', 'op-actions');
    tools.append(button('Обновить', () => void this.reload(), 'button subtle', 'dc-refresh'));
    const write = this.cb.can('discounts.write');
    const why = write ? null : this.cb.rights('discounts.write');
    if (write)
      tools.append(button('Новая скидка', () => this.editor(null), 'button primary', 'dc-new'));
    head.append(tools);
    p.append(head, banner);
    p.append(
      el(
        'p',
        'op-note',
        'Скидки создаются и меняются только здесь. На кассе скидку выберет кассир, а начальник смены подтвердит её своим PIN, если это отмечено в условиях. Изменённая скидка снова становится черновиком: её нужно включить заново.',
      ),
    );
    if (why) {
      const n = el('p', 'op-note dc-rights', why);
      n.dataset.testid = 'dc-rights';
      p.append(n);
    }
    host.append(p);
    if (this.error) {
      const e = el('p', 'notice error', this.error);
      e.setAttribute('role', 'alert');
      p.append(e);
    }
    const v = this.view;
    if (!v) {
      p.append(el('p', 'op-note', this.loading ? 'Загружаем скидки...' : ''));
      return;
    }
    if (!v.catalog)
      p.append(
        el(
          'p',
          'op-note',
          'Меню точки ещё не опубликовано: пока можно сделать только скидку на всё меню.',
        ),
      );
    const bar = el('div', 'dc-bar');
    bar.append(
      select(
        'Показать',
        this.filter,
        FILTERS.map(([value, label]) => ({ value, label })),
        (value) => {
          this.filter = value as Filter;
          this.cb.changed();
        },
        'dc-filter',
      ),
    );
    p.append(bar);
    const head2 = ['Скидка', 'На что и где', 'Когда', 'Условия', 'Состояние', ''];
    const list = visible(v.discounts, this.filter);
    const lines = (...parts: (string | HTMLElement)[]) => {
      const box = el('div', 'dc-cell');
      box.append(...parts.map((x) => (typeof x === 'string' ? el('span', '', x) : x)));
      return box;
    };
    const rows = list.map((d) => {
      const state = el('span', `dc-state dc-state-${d.state}`, stateText(d));
      state.dataset.testid = 'dc-state';
      const value = el('span', 'dc-value', valueText(d));
      value.dataset.testid = 'dc-value-text';
      const actions = el('div', 'op-actions dc-actions');
      if (write && d.state !== 'archived')
        actions.append(button('Изменить', () => this.editor(d), 'button subtle', 'dc-edit'));
      if (write)
        for (const next of stateActions(d))
          actions.append(
            button(
              ACTION_LABELS[next],
              () => this.stateDialog(d, next),
              next === 'active' ? 'button' : 'button subtle',
              'dc-to-' + next,
            ),
          );
      actions.append(button('История', () => void this.history(d), 'button subtle', 'dc-history'));
      return [
        lines(el('span', 'dc-name', d.name), value),
        lines(
          scopeText(d.scope, v.catalog, d.unknown_items),
          el('span', 'muted', 'Каналы: ' + channelsText(d.scope.channels)),
        ),
        whenText(d.schedule),
        conditionsText(d),
        lines(
          state,
          el(
            'small',
            'muted',
            `Изменена ${almatyDateTime(d.updated_at)}${d.updated_by_name ? ', ' + d.updated_by_name : ''}`,
          ),
        ),
        actions,
      ];
    });
    const wrap = table(
      head2,
      rows,
      v.discounts.length
        ? 'В этом списке скидок нет. Выберите другой фильтр.'
        : 'Скидок пока нет. На запуске скидок нет: их можно подготовить заранее.',
    );
    wrap.dataset.testid = 'dc-table';
    p.append(wrap);
    if (v.truncated)
      p.append(el('p', 'op-note', 'Показаны первые 200 скидок: остальные - в архиве.'));
  }

  private draftKey(id: string) {
    return `${DRAFT}:${this.cb.scope()}:${id}`;
  }
  /** Create (d = null) or edit a discount; the input survives a reload of the tab. */
  private editor(d: Discount | null) {
    const v = this.view;
    if (!v) return;
    const id = d?.id ?? crypto.randomUUID();
    const store = sessionStore();
    const key = this.draftKey(d ? d.id : 'new');
    type Draft = { id: string; revision: number; form: DiscountForm; reason: string };
    const saved = readDraft<Draft>(store, key);
    const restored = saved && saved.revision === (d?.revision ?? 0) ? saved : null;
    const form: DiscountForm = restored?.form ?? (d ? formOf(d) : emptyForm());
    const discountId = restored?.id ?? id;
    let reason = restored?.reason ?? (d ? 'Изменение скидки' : 'Новая скидка');
    const box = dialog(
      d ? 'Изменить скидку' : 'Новая скидка',
      d?.state === 'active'
        ? 'Скидка сейчас включена. После сохранения она станет черновиком: проверьте её и включите снова.'
        : 'Скидка сохраняется черновиком. Включите её, когда проверите условия.',
      'dc-editor',
    );
    guard(box, {
      question: 'Закрыть окно? Несохранённые изменения скидки пропадут.',
      store,
      key,
      dirty: restored !== null,
    });
    const persist = () =>
      writeDraft(store, key, { id: discountId, revision: d?.revision ?? 0, form, reason });
    if (restored) {
      const n = el('p', 'notice', 'Восстановлен несохранённый ввод.');
      n.dataset.testid = 'dc-restored';
      box.append(n);
    }
    const change = (fn: () => void) => () => {
      fn();
      persist();
    };
    box.append(
      field(
        'Название (его увидит кассир)',
        form.name,
        (value) => change(() => (form.name = value))(),
        { id: 'dc-name', max: NAME_MAX, required: true },
      ),
    );
    const valueField = field(
      form.kind === 'percent' ? 'Процент скидки, %' : 'Сумма скидки, ₸',
      form.value,
      (value) => change(() => (form.value = value))(),
      {
        id: 'dc-value',
        hint:
          form.kind === 'percent'
            ? 'От 1 до 100, например 10 или 12,5.'
            : 'Сколько тенге снять с подходящих позиций чека, например 500.',
      },
    );
    const kind = select(
      'Вид скидки',
      form.kind,
      [
        { value: 'percent', label: 'Процент от суммы' },
        { value: 'amount', label: 'Сумма в тенге' },
      ],
      (value) => {
        form.kind = value === 'amount' ? 'amount' : 'percent';
        form.value = '';
        persist();
        const fresh = field(
          form.kind === 'percent' ? 'Процент скидки, %' : 'Сумма скидки, ₸',
          '',
          (text) => change(() => (form.value = text))(),
          {
            id: 'dc-value',
            hint:
              form.kind === 'percent'
                ? 'От 1 до 100, например 10 или 12,5.'
                : 'Сколько тенге снять с подходящих позиций чека, например 500.',
          },
        );
        current.replaceWith(fresh);
        current = fresh;
      },
      'dc-kind',
    );
    let current = valueField;
    const row = el('div', 'form-grid');
    row.append(kind, valueField);
    box.append(row);

    const channels = fieldset('Где действует', 'dc-channels');
    for (const code of DISCOUNT_CHANNELS)
      channels.append(
        check(
          CHANNEL_LABELS[code]!,
          form.channels.includes(code),
          (on) =>
            change(() => {
              form.channels = on
                ? [...form.channels, code]
                : form.channels.filter((c) => c !== code);
            })(),
          'dc-channel-' + code,
        ),
      );
    channels.append(
      el(
        'small',
        'muted',
        'ChocoFood - чек зала с оплатой ChocoFood. Приложение и киоск применят скидки позже, вместе с кассой.',
      ),
    );
    box.append(channels);

    const items = fieldset('На что', 'dc-items');
    const pick = el('div', 'dc-pick');
    const catalog = v.catalog;
    pick.hidden = form.whole;
    items.append(
      check(
        'Всё меню',
        form.whole,
        (on) =>
          change(() => {
            form.whole = on;
            pick.hidden = on;
          })(),
        'dc-whole',
      ),
    );
    if (!catalog) {
      pick.append(
        el('p', 'op-note', 'Меню не опубликовано: выбрать категории и позиции пока нельзя.'),
      );
    } else {
      const toggle = (list: 'categories' | 'products', code: string) => (on: boolean) =>
        change(() => {
          form[list] = on ? [...form[list], code] : form[list].filter((c) => c !== code);
        })();
      pick.append(el('p', 'dc-sub', 'Категории целиком'));
      const cats = el('div', 'dc-checks');
      for (const c of catalog.categories)
        cats.append(
          check(
            c.name,
            form.categories.includes(c.id),
            toggle('categories', c.id),
            'dc-cat-' + c.id,
          ),
        );
      pick.append(cats, el('p', 'dc-sub', 'Отдельные позиции'));
      for (const c of catalog.categories) {
        const products = catalog.products.filter((x) => x.category_id === c.id);
        if (!products.length) continue;
        const group = el('div', 'dc-checks');
        group.append(el('span', 'dc-cat-name', c.name + ':'));
        for (const x of products)
          group.append(
            check(
              x.name,
              form.products.includes(x.id),
              toggle('products', x.id),
              'dc-prod-' + x.id,
            ),
          );
        pick.append(group);
      }
      const gone = [
        ...form.categories.filter((id) => !catalog.categories.some((c) => c.id === id)),
        ...form.products.filter((id) => !catalog.products.some((x) => x.id === id)),
      ];
      if (gone.length) {
        const n = el(
          'p',
          'notice error',
          `Этого уже нет в опубликованном меню: ${gone.join(', ')}. Оно будет убрано из скидки при сохранении.`,
        );
        n.dataset.testid = 'dc-gone';
        pick.append(n);
        form.categories = form.categories.filter((id) =>
          catalog.categories.some((c) => c.id === id),
        );
        form.products = form.products.filter((id) => catalog.products.some((x) => x.id === id));
      }
    }
    items.append(pick);
    box.append(items);

    const when = fieldset('Когда', 'dc-when');
    const dates = el('div', 'form-grid');
    const start = field(
      'С даты',
      form.startDay,
      (value) => change(() => (form.startDay = value))(),
      {
        id: 'dc-start',
      },
    );
    const end = field(
      'По дату включительно',
      form.endDay,
      (value) => change(() => (form.endDay = value))(),
      {
        id: 'dc-end',
      },
    );
    start.querySelector('input')!.type = end.querySelector('input')!.type = 'date';
    dates.append(start, end);
    when.append(dates, el('small', 'muted', 'Даты по времени Алматы. Пустые поля - без срока.'));
    const days = el('div', 'dc-checks');
    days.append(el('span', 'dc-cat-name', 'Дни недели:'));
    WEEKDAYS.forEach((label, i) =>
      days.append(
        check(
          label,
          form.weekdays.includes(i + 1),
          (on) =>
            change(() => {
              form.weekdays = on
                ? [...form.weekdays, i + 1]
                : form.weekdays.filter((d) => d !== i + 1);
            })(),
          'dc-day-' + (i + 1),
        ),
      ),
    );
    when.append(days);
    const hours = el('div', 'dc-hours');
    const drawHours = () => {
      hours.replaceChildren(
        el('span', 'dc-cat-name', form.hours.length ? 'Часы:' : 'Часы: весь день'),
      );
      form.hours.forEach((h, i) => {
        const line = el('div', 'dc-hour');
        const from = field('С', h.from, (value) => change(() => (h.from = value))(), {
          id: `dc-from-${i}`,
        });
        const to = field('До', h.to, (value) => change(() => (h.to = value))(), {
          id: `dc-to-${i}`,
        });
        from.querySelector('input')!.placeholder = '12:00';
        to.querySelector('input')!.placeholder = '15:00';
        line.append(
          from,
          to,
          button(
            'Убрать',
            () => {
              form.hours.splice(i, 1);
              persist();
              drawHours();
              box.dispatchEvent(new Event('change'));
            },
            'button subtle',
            `dc-hour-remove-${i}`,
          ),
        );
        hours.append(line);
      });
      if (form.hours.length)
        hours.append(el('small', 'muted', 'Время ЧЧ:ММ по Алматы; «До 24:00» - до конца дня.'));
      if (form.hours.length < HOUR_WINDOWS)
        hours.append(
          button(
            'Добавить часы',
            () => {
              form.hours.push({ from: '', to: '' });
              persist();
              drawHours();
              box.dispatchEvent(new Event('change'));
            },
            'button subtle',
            'dc-hour-add',
          ),
        );
    };
    drawHours();
    when.append(hours);
    box.append(when);

    const terms = fieldset('Условия', 'dc-terms');
    terms.append(
      check(
        'Нужен PIN начальника смены на кассе',
        form.pin,
        (on) => change(() => (form.pin = on))(),
        'dc-pin',
      ),
      check(
        'Можно вместе с другими скидками',
        form.combinable,
        (on) => change(() => (form.combinable = on))(),
        'dc-combinable',
      ),
    );
    box.append(terms);
    box.append(
      field(
        'Причина или комментарий для журнала',
        reason,
        (value) => {
          reason = value;
          persist();
        },
        { id: 'dc-reason', max: 500, required: true },
      ),
    );
    const error = el('div', 'notice error op-form-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const show = (lines: string[]) => {
      error.replaceChildren(...lines.map((line) => el('p', '', line)));
      error.hidden = !lines.length;
    };
    // The reasons of the last attempt go away as soon as the manager changes something.
    box.addEventListener('input', () => show([]));
    const save = button(
      'Сохранить черновик',
      () =>
        void (async () => {
          const out = formPayload(form);
          const lines = [...out.errors];
          if (reason.trim().length < 3)
            lines.push('Укажите причину или комментарий: минимум 3 символа.');
          if (lines.length || !out.payload) {
            show(lines);
            return;
          }
          show([]);
          save.disabled = true;
          const failed = await this.cb.execute(
            saveCommand(discountId, d?.revision ?? 0, out.payload),
            reason.trim(),
          );
          save.disabled = false;
          if (failed) {
            show([discountErrorText(failed)]);
            return;
          }
          dropDraft(store, key);
          settle(box);
          await this.reload();
          box.close();
        })(),
      'button primary',
      'dc-save',
    );
    box.append(error, save);
  }
  private stateDialog(d: Discount, next: DiscountState) {
    const box = dialog(`${ACTION_LABELS[next]}: ${d.name}`, ACTION_TEXTS[next], 'dc-state-dialog');
    let reason = ACTION_REASONS[next];
    box.append(
      field('Причина или комментарий для журнала', reason, (value) => (reason = value), {
        id: 'dc-state-reason',
        max: 500,
        required: true,
      }),
    );
    const error = el('p', 'notice error op-form-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const ok = button(
      ACTION_LABELS[next],
      () =>
        void (async () => {
          if (reason.trim().length < 3) {
            error.textContent = 'Укажите причину или комментарий: минимум 3 символа.';
            error.hidden = false;
            return;
          }
          ok.disabled = true;
          const failed = await this.cb.execute(stateCommand(d.id, d.revision, next), reason.trim());
          ok.disabled = false;
          if (failed) {
            error.textContent = discountErrorText(failed);
            error.hidden = false;
            return;
          }
          settle(box);
          await this.reload();
          box.close();
        })(),
      next === 'archived' ? 'button danger' : 'button primary',
      'dc-state-confirm',
    );
    box.append(error, ok);
  }
  private async history(d: Discount) {
    const box = dialog(
      `История: ${d.name}`,
      'Каждое сохранение и смена состояния - отдельная версия.',
      'dc-history-dialog',
    );
    const note = el('p', 'op-note', 'Загружаем историю...');
    box.append(note);
    try {
      const v = await this.cb.load(d.id);
      const head = [
        'Версия',
        'Когда',
        'Кто',
        'Состояние',
        'Скидка',
        'На что',
        'Где',
        'Когда действует',
        'Условия',
      ];
      const rows = (v.history ?? []).map((r) => [
        String(r.revision),
        almatyDateTime(r.changed_at),
        r.changed_by_name ?? 'Автор не найден',
        stateText({ state: r.state, period: 'always' }).replace(', без срока', ''),
        valueText(r),
        scopeText(r.scope, v.catalog),
        channelsText(r.scope.channels),
        whenText(r.schedule),
        conditionsText(r),
      ]);
      note.replaceWith(table(head, rows, 'Версий нет.'));
      if (v.history_truncated) box.append(el('p', 'op-note', 'Показаны последние 100 версий.'));
    } catch (e) {
      note.className = 'notice error';
      note.textContent = discountErrorText(e);
    }
  }
}
