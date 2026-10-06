import { element as el, button, field, select, check } from './dom.js';
import {
  FinanceModel,
  money,
  minor,
  today,
  csv,
  type FinanceEntry,
  type JournalRow,
} from './finance-model.js';

const kinds: Record<string, string> = {
  expense: 'Расход',
  income: 'Поступление',
  transfer: 'Перевод между счетами',
  accrual_expense: 'Начисление расхода',
  accrual_income: 'Начисление дохода',
};
function table(headers: string[], rows: (string | HTMLElement)[][]) {
  const wrap = el('div', 'table-scroll');
  const t = el('table');
  const head = el('thead'),
    tr = el('tr');
  headers.forEach((h) => tr.append(el('th', '', h)));
  head.append(tr);
  const body = el('tbody');
  for (const cells of rows) {
    const r = el('tr');
    for (const c of cells) {
      const td = el('td');
      if (typeof c === 'string') td.textContent = c;
      else td.append(c);
      r.append(td);
    }
    body.append(r);
  }
  if (!rows.length) {
    const td = el('td', 'empty', 'За выбранный период записей нет.');
    td.colSpan = headers.length;
    const r = el('tr');
    r.append(td);
    body.append(r);
  }
  t.append(head, body);
  wrap.append(t);
  return wrap;
}
const options = (v: Record<string, string>) =>
  Object.entries(v).map(([value, label]) => ({ value, label }));
function download(name: string, rows: string[][]) {
  const a = el('a');
  const url = URL.createObjectURL(new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fresh = (): FinanceEntry => ({
  id: crypto.randomUUID(),
  kind: 'expense',
  amount_minor: '',
  cash_date: today(),
  recognition_date: today(),
  account_id: null,
  to_account_id: null,
  category_id: 'rent',
  center: 'restaurant',
  counterparty: '',
  reference: '',
  note: '',
});

export class FinanceView {
  private tab = 'journal';
  private editing = false;
  private draft = fresh();
  private amount = '';
  private recognize = true;
  private formError = '';
  private detail: JournalRow | null = null;
  private scope = '';
  private accountDraft = { name: '', kind: 'cash', opening_date: today(), opening: '0' };
  private accountOpen = false;
  private periodDraft = { month: '', reason: '' };
  private voidReason = '';
  constructor(
    private model: FinanceModel,
    private changed: () => void,
    private payments: () => void,
  ) {}
  get dirty() {
    return this.editing;
  }
  clear() {
    this.editing = false;
    this.draft = fresh();
    this.amount = '';
    this.formError = '';
    this.detail = null;
    this.accountDraft = { name: '', kind: 'cash', opening_date: today(), opening: '0' };
    this.accountOpen = false;
    this.periodDraft = { month: '', reason: '' };
    this.voidReason = '';
  }
  private act(label: string, fn: () => void, primary = false) {
    const b = button(label, fn, primary ? 'button primary' : 'button');
    b.disabled = !this.model.writable;
    return b;
  }
  render(target: HTMLElement) {
    const m = this.model,
      d = m.data;
    if (this.scope !== m.actor + ':' + m.branch) {
      this.scope = m.actor + ':' + m.branch;
      this.clear();
    }
    if (this.editing && m.lastEntryId === this.draft.id) this.clear();
    const area = el('div', 'finance-workspace');
    target.append(area);
    const toolbar = el('form', 'finance-toolbar');
    const start = field('С даты', m.start, () => {}, {
        type: 'date',
        required: true,
        id: 'finance-start',
      }),
      end = field('По дату', m.end, () => {}, { type: 'date', required: true, id: 'finance-end' });
    const center = select(
      'Подразделение',
      m.center,
      options({
        all: 'Все подразделения',
        restaurant: 'Ресторан',
        workshop: 'Цех',
        office: 'Офис',
        shared: 'Общие',
      }),
      () => {},
      'finance-center',
    );
    const apply = button('Показать', () => {
      if (!toolbar.reportValidity()) return;
      m.start = start.querySelector('input')!.value;
      m.end = end.querySelector('input')!.value;
      m.center = center.querySelector('select')!.value;
      m.page = 0;
      void m.load();
    });
    apply.disabled = m.busy || !!m.pending || this.editing;
    toolbar.append(start, end, center, apply);
    toolbar.addEventListener('submit', (e) => {
      e.preventDefault();
      apply.click();
    });
    area.append(toolbar);
    const tabs = el('nav', 'finance-tabs');
    tabs.setAttribute('aria-label', 'Финансовые отчёты');
    for (const [id, label] of [
      ['journal', 'Журнал операций'],
      ['cash', 'ДДС'],
      ['pnl', 'ОПиУ'],
      ['accounts', 'Счета и периоды'],
    ]) {
      const b = button(
        label!,
        () => {
          m.notice = '';
          this.tab = id!;
          this.changed();
        },
        this.tab === id ? 'button selected' : 'button',
      );
      b.setAttribute('aria-current', this.tab === id ? 'page' : 'false');
      b.disabled = this.editing || m.busy || !!m.pending;
      tabs.append(b);
    }
    const payments = button('Оплаты и чеки', this.payments, 'button subtle');
    payments.disabled = this.editing || m.busy || !!m.pending;
    tabs.append(payments);
    area.append(tabs);
    if (m.error) {
      const n = el('div', 'notice error', m.error);
      n.setAttribute('role', 'alert');
      area.append(n);
    }
    if (m.notice) {
      const n = el('p', 'notice compact', m.notice);
      n.setAttribute('role', 'status');
      area.append(n);
    }
    if (m.pending) {
      const n = el(
        'div',
        'notice',
        'Запрос сохранён, но его результат ещё не подтверждён. Проверка повторит тот же запрос без второй записи.',
      );
      const b = button('Проверить результат', () => void m.recover());
      b.disabled = m.busy;
      n.append(b);
      area.append(n);
    }
    if (!d) {
      area.append(
        el(
          'p',
          'muted',
          m.busy
            ? 'Загружаем финансовый журнал...'
            : 'Нет подтверждённых данных. Нажмите «Показать», чтобы повторить загрузку.',
        ),
      );
      return;
    }
    area.append(
      el(
        'p',
        'finance-source',
        'Управленческий учёт по внесённым операциям. Оплаты приложения, iiko и банковские выписки автоматически сюда не добавляются.',
      ),
    );
    if (this.editing) {
      area.append(this.editor());
      return;
    }
    if (this.detail) {
      area.append(this.details(this.detail));
      return;
    }
    if (this.tab === 'journal') this.journal(area);
    if (this.tab === 'cash' || this.tab === 'pnl') this.report(area, this.tab);
    if (this.tab === 'accounts') this.accounts(area);
  }
  private journal(area: HTMLElement) {
    const m = this.model,
      d = m.data!;
    const top = el('div', 'finance-heading');
    top.append(
      el('h2', '', 'Операции'),
      this.act(
        'Добавить операцию',
        () => {
          this.draft = fresh();
          this.draft.account_id = d.accounts[0]?.id ?? null;
          this.amount = '';
          this.recognize = true;
          this.editing = true;
          this.changed();
        },
        true,
      ),
    );
    area.append(top);
    const filters = el('form', 'finance-toolbar');
    const search = field('Найти в журнале', m.search, () => {}, {
      max: 80,
      hint: 'Документ, контрагент или примечание',
      id: 'finance-search',
    });
    const article = select(
      'Статья журнала',
      m.category,
      [
        { value: '', label: 'Все статьи' },
        ...d.categories.map((c) => ({ value: c.id, label: c.name })),
      ],
      () => {},
      'finance-filter-category',
    );
    const basis = select(
      'Дата отбора',
      m.basis,
      options({ both: 'Оплата или начисление', cash: 'Только движение денег', pnl: 'Только ОПиУ' }),
      () => {},
      'finance-filter-basis',
    );
    const find = button('Найти', () => {
      m.search = search.querySelector('input')!.value;
      m.category = article.querySelector('select')!.value;
      m.basis = basis.querySelector('select')!.value;
      m.page = 0;
      void m.load();
    });
    find.disabled = m.busy;
    filters.append(search, article, basis, find);
    filters.addEventListener('submit', (e) => {
      e.preventDefault();
      find.click();
    });
    area.append(filters);
    if (!d.accounts.length)
      area.append(
        el(
          'p',
          'notice',
          'Начните со вкладки «Счета и периоды»: добавьте кассу или банковский счёт и подтверждённый начальный остаток. Начисления без оплаты можно внести сразу.',
        ),
      );
    const rows = d.journal.map((r) => {
      const e = r.payload;
      const name = el('div');
      name.append(
        button(
          e.reference,
          () => {
            this.detail = r;
            this.changed();
          },
          'finance-link',
        ),
        el('small', 'muted', e.counterparty || 'Контрагент не указан'),
      );
      const value = el('strong', r.void_reason ? 'muted' : '', money(e.amount_minor));
      return [
        e.cash_date ?? e.recognition_date ?? '-',
        name,
        kinds[e.kind] ?? e.kind,
        d.categories.find((c) => c.id === e.category_id)?.name ?? 'Перевод',
        d.centers[e.center] ?? e.center,
        value,
        r.void_reason ? 'Отменена' : 'Проведена',
      ];
    });
    area.append(
      table(
        ['Дата', 'Документ / контрагент', 'Операция', 'Статья', 'Подразделение', 'Сумма', 'Статус'],
        rows,
      ),
    );
    const pages = el('div', 'finance-pagination');
    const back = button('Назад', () => {
        m.page--;
        void m.load();
      }),
      next = button('Далее', () => {
        m.page++;
        void m.load();
      });
    back.disabled = m.page === 0 || m.busy;
    next.disabled = (m.page + 1) * 100 >= d.total || m.busy;
    pages.append(
      el(
        'span',
        'muted',
        `${d.total ? m.page * 100 + 1 : 0}-${Math.min((m.page + 1) * 100, d.total)} из ${d.total}. Итоги отчётов учитывают весь период.`,
      ),
      back,
      next,
      button('CSV этой страницы', () =>
        download('pickchick-operations.csv', [
          [
            'Дата оплаты',
            'Дата ОПиУ',
            'Операция',
            'Статья',
            'Подразделение',
            'Контрагент',
            'Документ',
            'Сумма, тиын',
            'Автор',
            'Статус',
            'Примечание',
          ],
          ...d.journal.map((r) => {
            const e = r.payload;
            return [
              e.cash_date ?? '',
              e.recognition_date ?? '',
              kinds[e.kind]!,
              d.categories.find((c) => c.id === e.category_id)?.name ?? 'Перевод',
              d.centers[e.center]!,
              e.counterparty,
              e.reference,
              e.amount_minor,
              r.author,
              r.void_reason ? 'Отменена' : 'Проведена',
              e.note,
            ];
          }),
        ]),
      ),
    );
    area.append(pages);
  }
  private editor() {
    const m = this.model,
      d = m.data!,
      e = this.draft;
    const form = el('form', 'panel finance-editor');
    form.append(
      el('h2', '', 'Новая операция'),
      el(
        'p',
        'muted',
        'Сначала укажите факт движения денег. Для ОПиУ выберите дату, к которой относится доход или расход.',
      ),
    );
    const grid = el('div', 'finance-form-grid');
    const redraw = () => {
      this.formError = '';
      this.changed();
    };
    grid.append(
      select(
        'Тип операции',
        e.kind,
        options(kinds),
        (v) => {
          e.kind = v;
          const incoming = v.endsWith('income');
          const accrual = v.startsWith('accrual');
          e.category_id = v === 'transfer' ? null : incoming ? 'sales' : 'rent';
          e.to_account_id = null;
          e.cash_date = accrual ? null : today();
          e.account_id = accrual ? null : (d.accounts[0]?.id ?? null);
          this.recognize = v !== 'transfer';
          e.recognition_date = this.recognize ? today() : null;
          redraw();
        },
        'finance-kind',
      ),
    );
    const value = field(
      'Сумма, ₸',
      this.amount,
      (v) => {
        this.amount = v;
      },
      { id: 'finance-amount', required: true, hint: 'Тенге, до двух знаков после запятой' },
    );
    value.querySelector('input')!.inputMode = 'decimal';
    grid.append(value);
    const accrual = e.kind.startsWith('accrual'),
      transfer = e.kind === 'transfer';
    if (!accrual) {
      grid.append(
        field('Дата движения денег', e.cash_date ?? '', (v) => (e.cash_date = v), {
          type: 'date',
          required: true,
          id: 'finance-cash-date',
        }),
        select(
          transfer ? 'Со счёта' : 'Счёт',
          e.account_id ?? '',
          [
            { value: '', label: 'Выберите счёт' },
            ...d.accounts.map((a) => ({ value: a.id, label: a.name })),
          ],
          (v) => (e.account_id = v || null),
          'finance-account',
        ),
      );
    }
    if (transfer)
      grid.append(
        select(
          'На счёт',
          e.to_account_id ?? '',
          [
            { value: '', label: 'Выберите другой счёт' },
            ...d.accounts
              .filter((a) => a.id !== e.account_id)
              .map((a) => ({ value: a.id, label: a.name })),
          ],
          (v) => (e.to_account_id = v || null),
          'finance-to-account',
        ),
      );
    else
      grid.append(
        select(
          'Статья',
          e.category_id ?? '',
          d.categories
            .filter(
              (c) =>
                c.direction === (e.kind.endsWith('income') ? 'in' : 'out') &&
                (accrual ? c.recognition !== 'never' : c.recognition !== 'required'),
            )
            .map((c) => ({ value: c.id, label: c.name })),
          (v) => {
            e.category_id = v;
            const c = d.categories.find((c) => c.id === v)!;
            this.recognize = c.recognition !== 'never';
            e.recognition_date = this.recognize ? (e.recognition_date ?? today()) : null;
            redraw();
          },
          'finance-category',
        ),
      );
    grid.append(
      select(
        'Подразделение',
        e.center,
        options(d.centers),
        (v) => (e.center = v),
        'finance-entry-center',
      ),
    );
    const cat = d.categories.find((c) => c.id === e.category_id);
    if (!transfer && cat?.recognition !== 'never') {
      if (!accrual)
        grid.append(
          check(
            'Включить в ОПиУ',
            this.recognize,
            (v) => {
              this.recognize = v;
              e.recognition_date = v ? today() : null;
              redraw();
            },
            'finance-recognize',
          ),
        );
      if (this.recognize)
        grid.append(
          field(
            'Дата дохода / расхода для ОПиУ',
            e.recognition_date ?? '',
            (v) => (e.recognition_date = v),
            { type: 'date', required: true, id: 'finance-recognition-date' },
          ),
        );
    }
    grid.append(
      field('Контрагент', e.counterparty, (v) => (e.counterparty = v), {
        id: 'finance-counterparty',
        max: 200,
        hint: 'Поставщик, сотрудник или источник поступления',
      }),
      field('Документ / основание', e.reference, (v) => (e.reference = v), {
        id: 'finance-reference',
        required: true,
        max: 200,
        hint: 'Например: накладная №15, аренда за октябрь',
      }),
      field('Примечание', e.note, (v) => (e.note = v), {
        id: 'finance-note',
        multiline: true,
        max: 1000,
      }),
    );
    form.append(grid);
    const effect = transfer
      ? 'Изменятся остатки двух счетов. Общий денежный поток и прибыль не изменятся.'
      : accrual
        ? 'Изменится только ОПиУ. Движения денег не будет.'
        : this.recognize && cat?.recognition !== 'never'
          ? 'Запись попадёт в ДДС и в ОПиУ по соответствующим датам.'
          : 'Запись попадёт только в ДДС. Для признания расхода или дохода внесите отдельное начисление.';
    form.append(el('p', 'notice compact', effect));
    if (this.formError) {
      const n = el('p', 'notice error', this.formError);
      n.setAttribute('role', 'alert');
      form.append(n);
    }
    const save = this.act(
      'Провести операцию',
      () => {
        if (!form.reportValidity()) return;
        try {
          e.amount_minor = minor(this.amount);
          if (!accrual && !e.account_id) throw Error('Выберите денежный счёт.');
          if (transfer && (!e.to_account_id || e.to_account_id === e.account_id))
            throw Error('Выберите другой счёт для перевода.');
          this.formError = '';
          void m
            .send({ type: 'entry', entry: { ...e } }, 'Ввод бухгалтерской операции')
            .then((ok) => {
              if (ok) {
                this.clear();
                this.changed();
              }
            });
        } catch (error) {
          this.formError = (error as Error).message;
          this.changed();
        }
      },
      true,
    );
    const cancel = button('Отменить ввод', () => {
      if (window.confirm('Отменить несохранённый ввод?')) {
        this.clear();
        this.changed();
      }
    });
    cancel.disabled = m.busy || !!m.pending;
    const actions = el('div', 'finance-actions');
    actions.append(save, cancel);
    form.append(actions);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      save.click();
    });
    form
      .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input,select,textarea',
      )
      .forEach((i) => (i.disabled = m.busy || !!m.pending));
    return form;
  }
  private details(r: JournalRow) {
    const m = this.model,
      d = m.data!,
      e = r.payload,
      p = el('section', 'panel finance-editor');
    p.append(
      el('h2', '', e.reference),
      el(
        'p',
        'muted',
        `Автор: ${r.author}. Внесено: ${new Date(r.created_at).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}`,
      ),
    );
    p.append(
      table(
        ['Поле', 'Значение'],
        [
          ['Тип', kinds[e.kind] ?? e.kind],
          ['Сумма', money(e.amount_minor)],
          ['Дата движения денег', e.cash_date ?? '-'],
          ['Дата ОПиУ', e.recognition_date ?? '-'],
          ['Счёт', d.accounts.find((a) => a.id === e.account_id)?.name ?? '-'],
          ['На счёт', d.accounts.find((a) => a.id === e.to_account_id)?.name ?? '-'],
          ['Статья', d.categories.find((c) => c.id === e.category_id)?.name ?? '-'],
          ['Подразделение', d.centers[e.center] ?? e.center],
          ['Контрагент', e.counterparty || '-'],
          ['Примечание', e.note || '-'],
        ],
      ),
    );
    if (r.void_reason)
      p.append(
        el(
          'p',
          'notice',
          `Отменена: ${r.void_reason}. Автор отмены: ${r.void_author}. Исходная запись сохранена.`,
        ),
      );
    const back = button('К журналу', () => {
      this.detail = null;
      this.voidReason = '';
      this.changed();
    });
    back.disabled = m.busy || !!m.pending;
    p.append(back);
    if (!r.void_reason) {
      const correction = el('details', 'finance-correction');
      correction.open = !!this.voidReason;
      correction.append(
        el('summary', '', 'Исправить ошибочную запись'),
        el(
          'p',
          'muted',
          'Отмена исключит запись из отчётов, сохранив её в истории. После этого внесите новую операцию.',
        ),
        field('Причина отмены', this.voidReason, (v) => (this.voidReason = v), {
          required: true,
          max: 500,
        }),
      );
      correction.append(
        this.act('Отменить запись', () => {
          if (this.voidReason.trim().length < 3) {
            m.error = 'Укажите причину отмены, минимум 3 символа.';
            this.changed();
            return;
          }
          void m.send({ type: 'void', id: e.id }, this.voidReason).then((ok) => {
            if (ok) {
              this.detail = null;
              this.voidReason = '';
              this.changed();
            }
          });
        }),
      );
      p.append(correction);
    }
    p.append(
      this.act('Повторить как новую', () => {
        this.draft = {
          ...e,
          id: crypto.randomUUID(),
          cash_date: e.cash_date ? today() : null,
          recognition_date: e.recognition_date ? today() : null,
        };
        const n = BigInt(e.amount_minor);
        this.amount = `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
        this.recognize = !!e.recognition_date;
        this.detail = null;
        this.editing = true;
        this.changed();
      }),
    );
    return p;
  }
  private report(area: HTMLElement, kind: string) {
    const m = this.model,
      d = m.data!,
      pnl = kind === 'pnl';
    const lines: string[][] = [];
    const grouped: Record<string, bigint> = {};
    let incoming = 0n,
      outgoing = 0n;
    const heading = el('div', 'finance-heading');
    heading.append(el('h2', '', pnl ? 'Отчёт о прибылях и убытках' : 'Движение денежных средств'));
    area.append(heading);
    area.append(
      el(
        'p',
        'muted',
        pnl
          ? 'По дате признания дохода или расхода. Закупки, оборудование, авансы и возврат вложений сами по себе не уменьшают прибыль.'
          : 'По дате фактического платежа. Переводы между своими счетами исключены из поступлений и выплат.',
      ),
    );
    const groupNames = pnl
      ? d.groups
      : {
          operating: 'Операционная деятельность',
          investing: 'Инвестиционная деятельность',
          financing: 'Финансовая деятельность',
        };
    for (const [key, label] of Object.entries(groupNames)) {
      if (key === 'none') continue;
      const rows: (string | HTMLElement)[][] = [];
      let subtotal = 0n;
      for (const c of d.categories.filter((c) => (pnl ? c.group : c.cashflow) === key)) {
        const matches = d.summaries.filter((s) => s.category_id === c.id);
        const sum = matches.reduce((n, s) => n + BigInt(pnl ? s.pnl_minor : s.cash_minor), 0n);
        if (!sum) continue;
        const signed = c.direction === 'in' ? sum : -sum;
        subtotal += signed;
        if (c.direction === 'in') incoming += sum;
        else outgoing += sum;
        const detail = el('details');
        detail.append(el('summary', '', c.name));
        for (const s of matches) {
          const value = pnl ? s.pnl_minor : s.cash_minor;
          if (value !== '0')
            detail.append(el('p', 'muted', `${d.centers[s.center]}: ${money(value)}`));
        }
        detail.append(
          button(
            'Показать операции',
            () => {
              m.category = c.id;
              m.basis = pnl ? 'pnl' : 'cash';
              m.search = '';
              m.page = 0;
              this.tab = 'journal';
              void m.load();
            },
            'finance-link',
          ),
        );
        rows.push([
          detail,
          c.direction === 'in' ? 'Доход / поступление' : 'Расход / выплата',
          money(sum.toString()),
        ]);
        lines.push([
          label,
          c.name,
          c.direction === 'in' ? 'Поступление' : 'Расход',
          sum.toString(),
        ]);
      }
      grouped[key] = subtotal;
      if (rows.length) {
        const section = el('section', 'finance-report-group');
        const h = el('div', 'finance-heading');
        h.append(el('h3', '', label), el('strong', 'finance-number', money(subtotal.toString())));
        section.append(h, table(['Статья', 'Направление', 'Сумма'], rows));
        area.append(section);
      }
    }
    const total = el('section', 'finance-totals');
    const profit = (keys: string[]) => keys.reduce((n, k) => n + (grouped[k] ?? 0n), 0n).toString();
    const totals = pnl
      ? [
          ['Выручка', profit(['revenue'])],
          ['Валовая прибыль после комиссий', profit(['revenue', 'commission', 'cogs'])],
          ['После потерь', profit(['revenue', 'commission', 'cogs', 'loss'])],
          [
            'Операционная прибыль / убыток',
            profit(Object.keys(grouped).filter((k) => k !== 'nonoperating')),
          ],
          ['Результат по внесённым данным', (incoming - outgoing).toString()],
        ]
      : [
          ['Поступления', incoming.toString()],
          ['Выплаты', outgoing.toString()],
          ['Чистый денежный поток', (incoming - outgoing).toString()],
        ];
    total.append(
      table(
        ['Итог', 'Сумма'],
        totals.map(([label, v]) => [label!, money(v!)]),
      ),
    );
    heading.after(total);
    heading.append(
      button('Скачать отчёт CSV', () =>
        download(`pickchick-${pnl ? 'pnl' : 'cash'}-${m.start}-${m.end}.csv`, [
          ['Отчёт', pnl ? 'ОПиУ' : 'ДДС'],
          ['Период', m.start, m.end],
          ['Подразделение', m.center === 'all' ? 'Все' : d.centers[m.center]!],
          ['Группа', 'Статья', 'Направление', 'Сумма, тиын'],
          ...lines,
          [],
          ...totals.map(([label, v]) => [label!, v!]),
        ]),
      ),
    );
    if (!d.summaries.length)
      area.append(
        el(
          'p',
          'notice',
          'Нет внесённых данных за период. Нулевые итоги не подтверждают отсутствие продаж или расходов ресторана.',
        ),
      );
    if (pnl)
      area.append(
        el(
          'p',
          'finance-source',
          'Полноту выручки, себестоимости, остатков и начислений проверяет бухгалтер перед закрытием месяца. Автоматического расчёта себестоимости из закупок и норм пока нет.',
        ),
      );
  }
  private accounts(area: HTMLElement) {
    const m = this.model,
      d = m.data!;
    area.append(
      el('h2', '', 'Денежные счета'),
      el(
        'p',
        'muted',
        'Остатки по всем подразделениям точки. Начальный остаток вводится на начало выбранного дня и не считается доходом.',
      ),
    );
    area.append(
      table(
        [
          'Счёт',
          'Дата начала',
          'На начало периода',
          'Начальные остатки новых счетов',
          'Приход',
          'Расход',
          'На конец периода',
        ],
        d.accounts.map((a) => [
          a.name,
          a.opening_date,
          money(a.before_minor),
          money(a.introduced_minor),
          money(a.in_minor),
          money(a.out_minor),
          money(a.after_minor),
        ]),
      ),
    );
    const add = el('details', 'panel finance-editor');
    add.open = this.accountOpen;
    add.addEventListener('toggle', () => {
      this.accountOpen = add.open;
    });
    add.append(el('summary', '', 'Добавить денежный счёт'));
    const draft = this.accountDraft;
    const form = el('form', 'finance-form-grid');
    form.append(
      field('Название счёта', draft.name, (v) => (draft.name = v), { required: true, max: 100 }),
      select(
        'Вид счёта',
        draft.kind,
        options({
          cash: 'Наличные',
          bank: 'Банковский счёт',
          wallet: 'Расчёты с платёжным сервисом',
        }),
        (v) => (draft.kind = v),
      ),
      field('Начало учёта', draft.opening_date, (v) => (draft.opening_date = v), {
        type: 'date',
        required: true,
      }),
      field('Начальный остаток, ₸', draft.opening, (v) => (draft.opening = v), {
        required: true,
        hint: 'Подтвердите по кассе или выписке. Ноль допустим.',
      }),
    );
    const save = this.act(
      'Добавить счёт',
      () => {
        if (!form.reportValidity()) return;
        try {
          const normalized = draft.opening.trim();
          const sign = normalized.startsWith('-') ? '-' : '';
          const raw = normalized.replace(/^-/, '');
          const opening_minor = /^0([.,]00?)?$/.test(raw) ? '0' : sign + minor(raw);
          void m
            .send(
              {
                type: 'account',
                id: crypto.randomUUID(),
                name: draft.name,
                kind: draft.kind,
                opening_date: draft.opening_date,
                opening_minor,
              },
              'Открытие управленческого денежного счёта',
            )
            .then((ok) => {
              if (ok) {
                this.accountDraft = { name: '', kind: 'cash', opening_date: today(), opening: '0' };
                this.accountOpen = false;
                this.changed();
              }
            });
        } catch (e) {
          m.error = (e as Error).message;
          this.changed();
        }
      },
      true,
    );
    form.append(save);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      save.click();
    });
    add.append(form);
    area.append(add);
    const period = el('section', 'panel finance-editor');
    if (!this.periodDraft.month) this.periodDraft.month = m.start.slice(0, 7) + '-01';
    const month = this.periodDraft.month;
    const state = d.periods.find((p) => p.month === month);
    period.append(
      el('h2', '', 'Закрытие месяца'),
      el(
        'p',
        'muted',
        'Закрытый месяц защищён от новых проводок и отмен. Повторное открытие требует причины и сохраняется в аудите.',
      ),
      field(
        'Месяц',
        month.slice(0, 7),
        (v) => {
          this.periodDraft.month = v + '-01';
          this.changed();
        },
        { type: 'month', required: true, id: 'finance-period-month' },
      ),
      field(
        'Причина закрытия / открытия',
        this.periodDraft.reason,
        (v) => (this.periodDraft.reason = v),
        {
          required: true,
          max: 500,
        },
      ),
    );
    const change = (closed: boolean) => {
      if (!/^\d{4}-\d{2}-01$/.test(month) || this.periodDraft.reason.trim().length < 3) {
        m.error = 'Выберите месяц и укажите причину, минимум 3 символа.';
        this.changed();
        return;
      }
      const current = d.periods.find((p) => p.month === month);
      void m.send(
        { type: 'period', month, closed, expected_revision: current?.revision ?? 0 },
        this.periodDraft.reason,
      );
    };
    period.append(
      el('p', '', `Статус ${month.slice(0, 7)}: ${state?.closed ? 'закрыт' : 'открыт'}`),
      this.act('Закрыть месяц', () => change(true)),
      this.act('Открыть для исправлений', () => change(false)),
      table(
        ['Месяц', 'Статус', 'Версия'],
        d.periods.map((p) => [
          p.month.slice(0, 7),
          p.closed ? 'Закрыт' : 'Открыт',
          String(p.revision),
        ]),
      ),
    );
    area.append(period);
  }
}
