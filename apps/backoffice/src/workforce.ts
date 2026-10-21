import { element as el, button, field, select, grid } from './dom.js';
import {
  WorkforceModel,
  type WorkRecord,
  type EmployeeRecord,
  today,
  money,
  minor,
  csv,
  hours,
  localDateTime,
  intervalSeconds,
} from './workforce-model.js';

type Data = Record<string, unknown>;
type Form = {
  kind: string;
  id: string;
  revision: number;
  values: Record<string, string>;
  active: boolean;
};
const labels: Record<string, string> = {
  staff: 'Сотрудник',
  working: 'Работает',
  inactive: 'Не работает',
  unknown: 'Статус нужно уточнить',
  draft: 'Черновик',
  published: 'Опубликована',
  cancelled: 'Отменена',
  approved: 'Подтверждено',
  voided: 'Аннулировано',
  worked: 'Работал',
  day_off: 'Выходной',
  absence: 'Неявка',
  leave: 'Отпуск',
  sick: 'Больничный',
  manager: 'Управляющий',
  cashier: 'Кассир',
  cook: 'Повар',
  assembler: 'Сборщик',
};
const issues: Record<string, string> = {
  UNAPPROVED_PAYROLL: 'Начисление ждёт проверки',
  MISSING_PAYROLL_BASE: 'Не задана база начисления',
  MISSING_RATE: 'Не задана ставка',
  MISSING_TIME: 'Нет подтверждённого табеля',
  UNAPPROVED_TIME: 'Табель ждёт проверки',
  UNAPPROVED_BONUS: 'Премия ждёт подтверждения',
};
const decimalHours = (milliseconds: number) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(milliseconds / 3600000);
const dateText = (v: string) =>
  v ? new Date(v.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('ru-RU') : '-';
const addDays = (v: string, n: number) =>
  new Date(Date.parse(v + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const status = (v: unknown) => labels[String(v)] ?? String(v ?? '-');
const spanText = (spans: { start: string; end: string }[]) =>
  spans
    .map(
      (s) =>
        `${localDateTime(s.start).slice(11)} - ${localDateTime(s.end).slice(11)}${localDateTime(s.end).slice(0, 10) !== localDateTime(s.start).slice(0, 10) ? ' (+1 день)' : ''}`,
    )
    .join(', ');

export class WorkforceView {
  private tab = 'plan';
  private range = 'month';
  private day = today();
  private displayedMonth = '';
  private employee = '';
  private form: Form | null = null;
  private formError = '';
  constructor(
    private model: WorkforceModel,
    private changed: () => void,
  ) {}
  get dirty() {
    return this.form !== null;
  }
  clear() {
    this.form = null;
    this.formError = '';
  }
  private name(id: unknown) {
    return (
      this.model.data?.employees.find((e) => e.id === id)?.payload.name ?? 'Сотрудник недоступен'
    );
  }
  private button(text: string, action: () => void, primary = false) {
    const b = button(text, action, primary ? 'button primary' : 'button');
    b.disabled = !this.model.writable;
    return b;
  }
  private recordActions(kind: string, record: WorkRecord | EmployeeRecord) {
    const actions = el('div', 'wf-row-actions');
    actions.append(this.button('Изменить', () => this.edit(kind, record)));
    const remove = this.button('Удалить', () => {
      this.form = {
        kind: 'delete',
        id: record.id,
        revision: record.revision,
        active: false,
        values: {
          target_kind: kind,
          name:
            kind === 'employee'
              ? String(record.payload['name'])
              : this.name((record.payload as Data)['employee_id']),
          reason: '',
        },
      };
      this.formError = '';
      this.changed();
      this.focusEditor();
    });
    remove.classList.add('wf-delete');
    actions.append(remove);
    return actions;
  }
  private focusEditor() {
    requestAnimationFrame(() => {
      const editor = document.querySelector<HTMLElement>('.wf-editor');
      editor?.scrollIntoView({ block: 'center', behavior: 'auto' });
      editor?.querySelector<HTMLElement>('input, select, textarea')?.focus({ preventScroll: true });
    });
  }
  private download(title: string, rows: string[][]) {
    const a = el('a');
    const url = URL.createObjectURL(new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' }));
    a.href = url;
    a.download = `PickChick-${title}-${this.model.month.slice(0, 7)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private table(headers: string[], rows: (string | HTMLElement)[][], empty: string) {
    if (!rows.length) return el('p', 'wf-empty', empty);
    const wrap = el('div', 'wf-table-wrap'),
      table = el('table', 'wf-table'),
      head = el('thead'),
      tr = el('tr'),
      body = el('tbody');
    wrap.tabIndex = 0;
    wrap.setAttribute('aria-label', 'Таблица, можно прокручивать по горизонтали');
    headers.forEach((v) => {
      const th = el('th', '', v);
      th.scope = 'col';
      tr.append(th);
    });
    head.append(tr);
    rows.forEach((row) => {
      const tr = el('tr');
      row.forEach((v) => {
        const td = el('td');
        td.append(v);
        tr.append(td);
      });
      body.append(tr);
    });
    table.append(head, body);
    wrap.append(table);
    return wrap;
  }
  private matching(r: WorkRecord) {
    if (r.payload['deleted']) return false;
    if (this.employee && r.payload['employee_id'] !== this.employee) return false;
    const p = r.payload,
      date =
        r.kind === 'plan'
          ? localDateTime(String(p['start'])).slice(0, 10)
          : String(p['date'] ?? p['effective_date'] ?? p['month']);
    if (r.kind === 'rate') return true;
    if (r.kind === 'bonus' || r.kind === 'payroll') return date === this.model.month;
    if (this.range === 'day') return date === this.day;
    if (this.range === 'week') {
      const offset = (new Date(this.day + 'T12:00:00Z').getUTCDay() + 6) % 7;
      const start = addDays(this.day, -offset);
      return date >= start && date < addDays(start, 7);
    }
    return date.slice(0, 7) === this.model.month.slice(0, 7);
  }
  render(host: HTMLElement) {
    const root = el('section', 'workforce');
    root.dataset.testid = 'workforce';
    host.append(root);
    const top = el('div', 'wf-header');
    const title = el('div');
    title.append(
      el('h2', '', 'Смены и команда'),
      el('p', 'muted', 'Планируйте график, подтверждайте часы и контролируйте начисления.'),
    );
    top.append(title);
    root.append(top);
    if (this.model.error) {
      const error = el('div', 'wf-alert', this.model.error);
      error.setAttribute('role', 'alert');
      root.append(error);
    }
    if (this.model.notice) {
      const notice = el('p', 'wf-notice', this.model.notice);
      notice.setAttribute('role', 'status');
      root.append(notice);
    }
    if (this.model.pending)
      root.append(
        el(
          'p',
          'wf-alert',
          'Результат последней операции ещё не подтверждён. Новые записи временно заблокированы.',
        ),
        button('Проверить результат', () => {
          void this.model.recover().then((ok) => {
            if (ok) {
              this.clear();
              this.changed();
            }
          });
        }),
      );
    const data = this.model.data;
    if (!data) {
      root.append(
        el(
          'p',
          'wf-empty',
          this.model.busy ? 'Загружаем график и табель...' : 'Данные не загружены.',
        ),
        button('Повторить загрузку', () => void this.model.load()),
      );
      return;
    }
    if (this.displayedMonth !== this.model.month) {
      this.displayedMonth = this.model.month;
      this.day = today().slice(0, 7) === this.model.month.slice(0, 7) ? today() : this.model.month;
    }
    const filters = el('div', 'wf-toolbar');
    const changeMonth = (year: string, month: string) => {
      this.model.month = `${year}-${month}-01`;
      this.day = this.model.month;
      void this.model.load();
    };
    const selectedYear = this.model.month.slice(0, 4);
    const years = [
      ...new Set([...Array.from({ length: 101 }, (_, i) => String(2000 + i)), selectedYear]),
    ].sort();
    filters.append(
      select(
        'Месяц',
        this.model.month.slice(5, 7),
        [
          'Январь',
          'Февраль',
          'Март',
          'Апрель',
          'Май',
          'Июнь',
          'Июль',
          'Август',
          'Сентябрь',
          'Октябрь',
          'Ноябрь',
          'Декабрь',
        ].map((label, i) => ({ value: String(i + 1).padStart(2, '0'), label })),
        (v) => changeMonth(selectedYear, v),
      ),
      select(
        'Год',
        selectedYear,
        years.map((value) => ({ value, label: value })),
        (v) => changeMonth(v, this.model.month.slice(5, 7)),
      ),
      select(
        'Сотрудник',
        this.employee,
        [
          { value: '', label: 'Вся команда' },
          ...data.employees
            .filter((e) => !e.payload.deleted)
            .map((e) => ({ value: e.id, label: e.payload.name })),
        ],
        (v) => {
          this.employee = v;
          this.changed();
        },
      ),
      button('Обновить', () => void this.model.load()),
    );
    filters.querySelectorAll('select').forEach((control) => {
      control.setAttribute(
        'aria-label',
        control.parentElement!.querySelector('.field-label')!.textContent!,
      );
    });
    filters
      .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
        'input,select,button',
      )
      .forEach((n) => (n.disabled = this.model.busy || Boolean(this.model.pending) || this.dirty));
    root.append(filters);
    const nav = el('nav', 'wf-tabs');
    nav.setAttribute('aria-label', 'Управление сменами');
    for (const [id, label] of [
      ['plan', 'График'],
      ['time', 'Табель'],
      ['pay', 'Начисления'],
      ['team', 'Сотрудники'],
      ['history', 'История'],
    ]) {
      const b = button(
        label!,
        () => {
          if (this.dirty && !window.confirm('Отменить несохранённый ввод?')) return;
          this.clear();
          this.tab = id!;
          this.changed();
        },
        this.tab === id ? 'button selected' : 'button',
      );
      b.setAttribute('aria-current', this.tab === id ? 'page' : 'false');
      nav.append(b);
    }
    root.append(nav);
    if (this.form) {
      this.editor(root);
      return;
    }
    if (['plan', 'time'].includes(this.tab)) {
      const bar = el('div', 'wf-actions');
      const rangeField = el('div', 'field wf-range-field');
      const rangeButtons = el('div', 'wf-range-buttons');
      rangeButtons.setAttribute('role', 'group');
      rangeButtons.setAttribute('aria-label', 'Вид графика');
      rangeField.append(el('span', 'field-label', 'Вид графика'), rangeButtons);
      bar.append(rangeField);
      for (const [v, label] of [
        ['day', 'День'],
        ['week', 'Неделя'],
        ['month', 'Месяц'],
      ]) {
        const b = button(
          label!,
          () => {
            this.range = v!;
            this.changed();
          },
          this.range === v ? 'button selected' : 'button',
        );
        b.setAttribute('aria-pressed', String(this.range === v));
        rangeButtons.append(b);
      }
      if (this.range !== 'month')
        bar.append(
          field(
            'Дата',
            this.day,
            (v) => {
              if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
                this.day = v;
                const month = v.slice(0, 7) + '-01';
                if (month !== this.model.month) {
                  this.displayedMonth = month;
                  this.model.month = month;
                  void this.model.load();
                } else this.changed();
              }
            },
            { type: 'date' },
          ),
        );
      bar.append(
        this.button(
          this.tab === 'plan' ? 'Добавить смену' : 'Внести явку',
          () => this.edit(this.tab),
          true,
        ),
      );
      root.append(bar);
      if (this.tab === 'time')
        root.append(
          el(
            'p',
            'wf-note',
            `BioCheck пока не подключён. Вводите фактические часы или интервалы вручную. Пустая ячейка не означает выходной. ${data.period.closed ? 'Месячный табель закрыт.' : 'Табель открыт.'}`,
          ),
        );
      const records = data.records
        .filter((r) => r.kind === this.tab && this.matching(r))
        .sort((a, b) =>
          String(a.payload['start'] ?? a.payload['date']).localeCompare(
            String(b.payload['start'] ?? b.payload['date']),
          ),
        );
      if (this.range === 'month') {
        this.monthGrid(root, records);
        return;
      }
      const rows = records.map((r) => {
        const p = r.payload;
        const spans =
          this.tab === 'plan'
            ? [{ start: String(p['start']), end: String(p['end']) }]
            : (p['intervals'] as { start: string; end: string }[]);
        const date =
          this.tab === 'plan' ? localDateTime(String(p['start'])).slice(0, 10) : String(p['date']);
        const total =
          (p['paid_duration_ms'] !== undefined
            ? Number(p['paid_duration_ms']) / 1000
            : intervalSeconds(spans)) -
          (this.tab === 'plan' ? Number(p['unpaid_break_minutes']) * 60 : 0);
        const actions = this.recordActions(r.kind, r);
        if (this.tab === 'plan')
          actions.append(this.button('+7 дней', () => this.edit('plan', r, true)));
        return [
          dateText(date),
          this.name(p['employee_id']),
          p['paid_duration_ms'] !== undefined
            ? 'Длительность, без времени прихода'
            : spans.length
              ? spanText(spans)
              : status(p['attendance']),
          hours(total),
          status(p['status']),
          actions,
        ];
      });
      root.append(
        this.table(
          ['Дата', 'Сотрудник', 'Интервалы', 'Часы', 'Статус', 'Действия'],
          rows,
          this.tab === 'plan'
            ? 'В этом периоде ещё нет смен. Добавьте первую смену сотрудника.'
            : 'Явки ещё не внесены. Плановые смены не считаются отработанными.',
        ),
      );
      root.append(
        button('Скачать CSV', () =>
          this.download(this.tab, [
            ['Дата', 'Сотрудник', 'Интервалы', 'Часы', 'Статус'],
            ...rows.map((r) => r.slice(0, 5).map(String)),
          ]),
        ),
      );
      return;
    }
    if (this.tab === 'team') {
      const bar = el('div', 'wf-actions');
      bar.append(
        this.button('Добавить сотрудника', () => this.edit('employee'), true),
        this.button('Добавить ставку', () => this.edit('rate')),
      );
      root.append(bar);
      root.append(
        this.table(
          ['Сотрудник', 'Роль', 'Статус', 'Действия'],
          data.employees
            .filter((e) => !e.payload.deleted && (!this.employee || e.id === this.employee))
            .map((e) => [
              e.payload.name,
              e.payload.position ?? status(e.payload.role),
              status(e.payload.employment_status ?? (e.payload.active ? 'working' : 'inactive')),
              this.recordActions('employee', e),
            ]),
          'Добавьте сотрудников, чтобы составлять график и табель.',
        ),
      );
      root.append(
        el('h2', '', 'Почасовые ставки'),
        el(
          'p',
          'muted',
          'Новая дата - новая ставка. Исправления открытого периода сохраняются в истории.',
        ),
      );
      root.append(
        this.table(
          ['Сотрудник', 'Действует с', 'Ставка / час', 'Действия'],
          data.records
            .filter((r) => r.kind === 'rate' && this.matching(r))
            .sort((a, b) =>
              String(b.payload['effective_date']).localeCompare(
                String(a.payload['effective_date']),
              ),
            )
            .map((r) => [
              this.name(r.payload['employee_id']),
              dateText(String(r.payload['effective_date'])) +
                (r.payload['valid_until']
                  ? ' - ' + dateText(String(r.payload['valid_until']))
                  : ''),
              money(String(r.payload['hourly_minor'])),
              this.recordActions('rate', r),
            ]),
          'Ставки ещё не заданы. Без ставки начисление не подтверждается.',
        ),
      );
      return;
    }
    if (this.tab === 'history') {
      root.append(
        el(
          'p',
          'muted',
          `Последние ${data.audit_limit} действий. Отмена записи не удаляет её историю.`,
        ),
      );
      root.append(
        this.table(
          ['Когда', 'Автор', 'Действие', 'Причина', 'Изменения'],
          data.audit.map((a) => {
            const details = el('details');
            details.append(el('summary', '', 'Посмотреть'));
            for (const [label, raw] of [
              ['До', a.before_value],
              ['После', a.after_value],
            ] as const) {
              const d = el('div', 'wf-history');
              d.append(el('h3', '', label));
              const value = raw as Data | null;
              const payload = (value?.['payload'] ?? value?.['command'] ?? value) as Data | null;
              if (!payload) d.append(el('p', '', 'Нет записи'));
              else
                for (const [k, v] of Object.entries(payload)) {
                  if (
                    [
                      'id',
                      'request_id',
                      'type',
                      'revision',
                      'kind',
                      'source_event_ids',
                      'records',
                      'snapshot',
                    ].includes(k)
                  )
                    continue;
                  const names: Record<string, string> = {
                    employee_id: 'Сотрудник',
                    deleted: 'Удалено',
                    date: 'Дата',
                    start: 'Начало',
                    end: 'Конец',
                    status: 'Статус',
                    hourly_minor: 'Ставка',
                    effective_date: 'Действует с',
                    name: 'Название',
                    active: 'Активен',
                    role: 'Роль',
                    note: 'Примечание',
                    attendance: 'Явка',
                    intervals: 'Интервалы',
                    amount_minor: 'Премия',
                    reason: 'Причина',
                    month: 'Месяц',
                    closed: 'Закрыт',
                    position: 'Должность',
                    employment_status: 'Статус сотрудника',
                    paid_duration_ms: 'Оплачиваемые часы',
                    base_override_minor: 'База вручную',
                    items: 'Доплаты и удержания',
                    valid_until: 'Действует по',
                    unpaid_break_minutes: 'План перерыва, мин',
                    target: 'План KPI',
                    actual: 'Факт KPI',
                    evidence: 'Основание',
                  };
                  if (!names[k]) continue;
                  let text = String(v);
                  if (k === 'employee_id') text = this.name(v);
                  else if (k.endsWith('_minor'))
                    text = v === null ? 'Автоматически' : money(String(v));
                  else if (k === 'paid_duration_ms') text = decimalHours(Number(v));
                  else if (k === 'items')
                    text = (v as { name: string; effect: string; amount_minor: string }[])
                      .map(
                        (i) =>
                          `${i.name}: ${i.effect === 'deduction' ? '-' : '+'}${money(i.amount_minor)}`,
                      )
                      .join('; ');
                  else if (k === 'intervals')
                    text = spanText(v as { start: string; end: string }[]);
                  else if (['status', 'attendance', 'role', 'employment_status'].includes(k))
                    text = status(v);
                  else if (typeof v === 'boolean') text = v ? 'Да' : 'Нет';
                  d.append(el('p', '', `${names[k]}: ${text}`));
                }
              details.append(d);
            }
            return [
              new Date(a.created_at).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }),
              a.author ?? a.actor_id,
              a.action === 'workforce.delete'
                ? 'Удаление записи'
                : a.action === 'workforce.period'
                  ? 'Закрытие / открытие табеля'
                  : a.action === 'save:employee'
                    ? 'Карточка сотрудника'
                    : a.action === 'workforce.import'
                      ? 'Импорт явок'
                      : 'Изменение записи',
              a.reason,
              details,
            ];
          }),
          'Изменений пока нет.',
        ),
      );
      return;
    }
    this.payrollTable(root);
    const breakdown = el('details', 'wf-calculation');
    breakdown.append(el('summary', '', 'Расчёт по часам, ставки и проверка табеля'));
    root.append(breakdown);
    const calc = data.calculation;
    const lines = calc.lines.filter((r) => !this.employee || r.employee_id === this.employee);
    const problems = calc.issues.filter((r) => !this.employee || r.employee_id === this.employee);
    const linked = new Set(
      data.records
        .filter(
          (r) => r.kind === 'time' && !r.payload['deleted'] && r.payload['status'] === 'approved',
        )
        .flatMap((r) => r.payload['source_event_ids'] as string[]),
    );
    const unresolved = data.events.filter(
      (e) =>
        (!this.employee || e.employee_id === this.employee) &&
        localDateTime(e.occurred_at).slice(0, 7) === this.model.month.slice(0, 7) &&
        !linked.has(e.id),
    ).length;
    breakdown.append(
      el('h2', '', 'Предварительные начисления'),
      el(
        'p',
        'wf-note',
        'Базовая оплата за подтверждённые часы и утверждённые премии. Доплаты за ночные, сверхурочные и праздничные часы, налоги и удержания здесь не рассчитаны. Это не сумма к выплате.',
      ),
    );
    const summary = el('div', 'wf-summary');
    for (const [label, value] of [
      ['Подтверждённые часы', hours(lines.reduce((n, r) => n + r.seconds, 0))],
      ['База + премии', money(String(lines.reduce((n, r) => n + BigInt(r.total_minor), 0n)))],
      ['Требуют проверки', String(problems.length + unresolved)],
      ['Табель всей точки', data.period.closed ? 'Закрыт' : 'Открыт'],
    ]) {
      const cell = el('div');
      cell.append(el('span', 'muted', label), el('strong', '', value));
      summary.append(cell);
    }
    breakdown.append(summary);
    if (problems.length || unresolved) {
      const box = el('div', 'wf-alert');
      box.append(el('strong', '', 'Расчёт неполный - проверьте записи'));
      problems.forEach((i) =>
        box.append(el('p', '', `${this.name(i.employee_id)}: ${issues[i.code] ?? i.code}`)),
      );
      if (unresolved) box.append(el('p', '', `Не разобрано отметок устройства: ${unresolved}`));
      breakdown.append(box);
    }
    const rows = lines.map((r) => [
      this.name(r.employee_id),
      hours(r.seconds),
      r.unknown_clock_seconds ? 'Время не указано' : hours(r.night_seconds),
      money(r.base_minor),
      money(r.bonus_minor),
      money(r.total_minor),
    ]);
    const headers = [
      'Сотрудник',
      'Часы',
      'Из них ночные',
      'Базовая оплата',
      'Премии',
      'Предварительно',
    ];
    breakdown.append(
      this.table(headers, rows, 'После подтверждения явок здесь появится расчёт по сотрудникам.'),
    );
    const bar = el('div', 'wf-actions');
    bar.append(
      button('Скачать CSV', () =>
        this.download('начисления', [
          ['Предварительный расчёт, не ведомость выплаты'],
          headers,
          ...rows,
        ]),
      ),
      this.button('Добавить премию', () => this.edit('bonus')),
      this.button(data.period.closed ? 'Переоткрыть табель' : 'Закрыть табель', () =>
        this.edit('period'),
      ),
    );
    breakdown.append(bar, el('h2', '', 'Премии KPI'));
    breakdown.append(
      this.table(
        ['Сотрудник', 'Показатель', 'План / факт', 'Сумма', 'Статус', 'Действия'],
        data.records
          .filter((r) => r.kind === 'bonus' && this.matching(r))
          .map((r) => [
            this.name(r.payload['employee_id']),
            String(r.payload['name']),
            `${r.payload['target']} / ${r.payload['actual']}`,
            money(String(r.payload['amount_minor'])),
            status(r.payload['status']),
            this.recordActions('bonus', r),
          ]),
        'Автоматические KPI не назначены. Можно добавить премию с подтверждённым основанием.',
      ),
    );
  }
  private monthGrid(root: HTMLElement, records: WorkRecord[]) {
    const month = this.model.month;
    const count = new Date(
      Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
    ).getUTCDate();
    const days = Array.from(
      { length: count },
      (_, i) => month.slice(0, 8) + String(i + 1).padStart(2, '0'),
    );
    const people = this.model.data!.employees.filter(
      (e) => !e.payload.deleted && (!this.employee || e.id === this.employee),
    );
    const totals = new Map<string, number>();
    const rows = people.map((e) => {
      const title = el('div', 'wf-person');
      title.append(
        el('strong', '', e.payload.name),
        el('small', 'muted', e.payload.position ?? status(e.payload.role)),
      );
      let sum = 0,
        shifts = 0;
      const cells = days.map((date) => {
        const entries = records.filter(
          (r) =>
            r.payload['employee_id'] === e.id &&
            (this.tab === 'plan'
              ? localDateTime(String(r.payload['start'])).slice(0, 10)
              : r.payload['date']) === date &&
            !['cancelled', 'voided'].includes(String(r.payload['status'])),
        );
        const duration = entries.reduce(
          (n, r) =>
            n +
            (this.tab === 'plan'
              ? Date.parse(String(r.payload['end'])) -
                Date.parse(String(r.payload['start'])) -
                Number(r.payload['unpaid_break_minutes']) * 60000
              : Number(
                  r.payload['paid_duration_ms'] ??
                    intervalSeconds(r.payload['intervals'] as { start: string; end: string }[]) *
                      1000,
                )),
          0,
        );
        sum += duration;
        if (duration) shifts++;
        const b = button(
          entries.length
            ? duration
              ? decimalHours(duration)
              : status(entries[0]!.payload['attendance'])
            : '+',
          () => {
            this.day = date;
            this.edit(this.tab, entries[0]);
            if (this.form) {
              this.form.values['employee_id'] = e.id;
              this.form.values['date'] = date;
              this.changed();
            }
          },
          'wf-day-cell',
        );
        b.disabled = !this.model.writable || this.model.data!.period.closed;
        b.setAttribute(
          'aria-label',
          `${e.payload.name}, ${dateText(date)}: ${entries.length ? decimalHours(duration) + ' ч' : 'нет записи'}`,
        );
        b.title = entries.map((r) => status(r.payload['status'])).join(', ') || 'Добавить запись';
        if (entries.some((r) => r.payload['status'] === 'draft')) {
          b.classList.add('wf-draft');
          b.append(el('span', 'wf-cell-note', 'черн.'));
        }
        if (entries.length > 1) b.append(el('span', 'wf-cell-note', `${entries.length} смены`));
        return b;
      });
      totals.set(e.id, sum);
      return [title, ...cells, decimalHours(sum), String(shifts)];
    });
    root.append(
      el(
        'p',
        'muted',
        `Нажмите на день сотрудника, чтобы внести или исправить запись. Всего: ${decimalHours([...totals.values()].reduce((a, b) => a + b, 0))} ч. Часы в десятичном формате. В итог входят черновики; начисления используют только подтверждённый факт.`,
      ),
    );
    const table = this.table(
      ['Сотрудник', ...days.map((d) => d.slice(8)), 'Часы', 'Дни'],
      rows,
      'Добавьте сотрудника, чтобы вести месячный табель.',
    );
    table.classList.add('wf-month-grid');
    root.append(table);
    root.append(
      button('Скачать CSV', () =>
        this.download(this.tab, [
          ['Сотрудник', ...days.map((d) => d.slice(8)), 'Часы', 'Дни'],
          ...rows.map((r, i) => [
            people[i]!.payload.name,
            ...r
              .slice(1)
              .map((x) =>
                typeof x === 'string' ? x : x.textContent === '+' ? '' : (x.textContent ?? ''),
              ),
          ]),
        ]),
      ),
    );
  }
  private payrollTable(root: HTMLElement) {
    const data = this.model.data!;
    root.append(
      el('h2', '', 'Ведомость начислений'),
      el(
        'p',
        'muted',
        'База, доплаты, авансы и удержания по каждому сотруднику. Исходные суммы Excel сохранены для сверки. Подтверждение ведомости не отправляет деньги и не рассчитывает налоги.',
      ),
    );
    const payroll = (data.calculation.payroll ?? [])
      .filter((p) => !this.employee || p.employee_id === this.employee)
      .sort((a, b) => this.name(a.employee_id).localeCompare(this.name(b.employee_id), 'ru'));
    const summary = el('div', 'wf-summary wf-payroll-summary');
    const sum = (
      key: 'base_minor' | 'bonus_minor' | 'additions_minor' | 'deductions_minor' | 'total_minor',
    ) => payroll.reduce((n, p) => n + BigInt(p[key]), 0n);
    for (const [label, amount] of [
      ['Начислено', sum('base_minor') + sum('bonus_minor') + sum('additions_minor')],
      ['Авансы и удержания', sum('deductions_minor')],
      ['Остаток по ведомости', sum('total_minor')],
    ] as const) {
      const cell = el('div');
      cell.append(el('span', 'muted', label), el('strong', '', money(String(amount))));
      summary.append(cell);
    }
    root.append(summary);
    const rows = payroll.map((p) => {
      const record = data.records.find((r) => r.id === p.id)!;
      const source = record.payload['source'] as
        | {
            sheet: string;
            row: number;
            cells: { cell: string; label: string; value: string; formula: string }[];
            issues: string[];
          }
        | undefined;
      const details = el('details');
      details.append(el('summary', '', 'Исходные данные'));
      if (source) {
        details.append(el('p', 'muted', `${source.sheet}, строка ${source.row}`));
        source.issues.forEach((issue) => details.append(el('p', 'wf-alert', issue)));
        details.append(
          this.table(
            ['Ячейка', 'Поле', 'Значение', 'Формула'],
            source.cells.map((c) => [c.cell, c.label, c.value, c.formula || '-']),
            'Нет исходных полей',
          ),
        );
      } else details.append(el('p', '', 'Введено в кабинете'));
      const total = el('div');
      total.append(el('strong', '', money(p.total_minor)));
      if (p.source_net_minor !== null && p.total_minor !== p.source_net_minor)
        total.append(el('small', 'wf-difference', `В Excel: ${money(p.source_net_minor)}`));
      return [
        this.name(p.employee_id),
        money(p.base_minor),
        money(String(BigInt(p.additions_minor) + BigInt(p.bonus_minor))),
        money(p.deductions_minor),
        total,
        status(p.status),
        this.recordActions('payroll', record),
        details,
      ];
    });
    const worksheet = this.table(
      [
        'Сотрудник',
        'База',
        'Доплаты / KPI',
        'Удержано / аванс',
        'Остаток по ведомости',
        'Статус',
        'Действия',
        'Сверка',
      ],
      rows,
      'Ведомость ещё не создана. Добавьте начисление сотруднику.',
    );
    worksheet.classList.add('wf-payroll-table');
    root.append(worksheet);
    const actions = el('div', 'wf-actions');
    actions.append(
      this.button(
        'Сформировать по табелю',
        () => {
          void this.model.send(
            { type: 'generate_payroll', month: this.model.month },
            'Формирование ведомости по подтверждённому табелю',
          );
        },
        true,
      ),
      this.button('Добавить вручную', () => this.edit('payroll')),
    );
    actions.append(
      button('Скачать ведомость CSV', () =>
        this.download('ведомость', [
          ['Сотрудник', 'База', 'Доплаты / KPI', 'Авансы / удержания', 'Остаток', 'Статус'],
          ...payroll.map((p) => [
            this.name(p.employee_id),
            money(p.base_minor),
            money(String(BigInt(p.additions_minor) + BigInt(p.bonus_minor))),
            money(p.deductions_minor),
            money(p.total_minor),
            status(p.status),
          ]),
        ]),
      ),
    );
    root.append(actions);
  }
  private edit(kind: string, record?: WorkRecord | EmployeeRecord, duplicate = false) {
    const p = (record?.payload ?? {}) as Data;
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(p)) if (typeof v !== 'object') values[k] = String(v);
    values['employee_id'] ??=
      this.employee ||
      this.model.data?.employees.find((e) => e.payload.active)?.id ||
      this.model.data?.employees.find((e) => !e.payload.deleted)?.id ||
      '';
    values['date'] ??= this.day;
    values['effective_date'] ??= today();
    values['status'] ??= 'draft';
    values['attendance'] ??= 'worked';
    values['reason'] = '';
    values['role'] ??= 'cook';
    values['employment_status'] ??= p['active'] === false ? 'inactive' : 'working';
    if (kind === 'plan') {
      values['start'] = p['start'] ? localDateTime(String(p['start'])) : this.day + 'T09:00';
      values['end'] = p['end'] ? localDateTime(String(p['end'])) : this.day + 'T18:00';
      if (duplicate) {
        for (const k of ['start', 'end'])
          values[k] = addDays(values[k]!.slice(0, 10), 7) + values[k]!.slice(10);
        values['status'] = 'draft';
      }
    }
    if (kind === 'time') {
      values['entry_mode'] =
        p['paid_duration_ms'] !== undefined || !record ? 'duration' : 'intervals';
      values['paid_hours'] =
        p['paid_duration_ms'] !== undefined ? String(Number(p['paid_duration_ms']) / 3600000) : '';
      values['intervals'] =
        (p['intervals'] as { start: string; end: string }[] | undefined)
          ?.map((s) => `${localDateTime(s.start).slice(11)}-${localDateTime(s.end).slice(11)}`)
          .join('\n') ?? '';
    }
    if (kind === 'payroll') {
      values['base_override_minor'] =
        p['base_override_minor'] == null ? '' : String(Number(p['base_override_minor']) / 100);
      values['items'] = JSON.stringify(p['items'] ?? []);
    }
    for (const k of ['hourly_minor', 'amount_minor'])
      if (p[k] !== undefined) values[k] = String(Number(p[k]) / 100);
    this.form = {
      kind,
      id: duplicate ? '' : (record?.id ?? ''),
      revision: duplicate ? 0 : (record?.revision ?? 0),
      values,
      active: p['active'] !== false,
    };
    this.formError = '';
    this.changed();
    this.focusEditor();
  }
  private editor(root: HTMLElement) {
    const f = this.form!,
      v = f.values,
      box = el('form', 'wf-editor');
    const titles: Record<string, string> = {
      delete: 'Удалить запись?',
      plan: 'Смена в графике',
      time: 'Фактическая явка',
      rate: 'Почасовая ставка',
      bonus: 'Премия KPI',
      payroll: 'Начисление за месяц',
      employee: 'Карточка сотрудника',
      period: this.model.data!.period.closed ? 'Переоткрыть табель' : 'Закрыть табель',
    };
    box.append(el('h2', '', titles[f.kind]));
    if (this.formError) {
      const e = el('p', 'wf-alert', this.formError);
      e.setAttribute('role', 'alert');
      box.append(e);
    }
    const controls = grid();
    const input = (name: string, label: string, type = 'text', required = true) =>
      controls.append(
        field(
          label,
          v[name] ?? '',
          (s) => {
            v[name] = s;
          },
          { type, required, max: 500 },
        ),
      );
    const choice = (name: string, label: string, choices: string[]) => {
      const control = select(
        label,
        v[name] ?? choices[0]!,
        choices.map((s) => ({ value: s, label: status(s) })),
        (s) => {
          v[name] = s;
        },
      );
      control.querySelector('select')!.setAttribute('aria-label', label);
      controls.append(control);
    };
    if (f.kind === 'delete')
      controls.append(
        el(
          'p',
          'wf-note',
          `${v['name']}. Запись исчезнет из рабочих списков и расчётов. Автор, причина и прежние данные останутся в истории. ${v['target_kind'] === 'employee' ? 'Сначала удалите ошибочные графики, явки, ставки и премии этого сотрудника. Сотрудника с кассовыми сменами или отметками устройства можно только сделать неактивным.' : 'Закрытый табель сначала нужно переоткрыть.'}`,
        ),
      );
    if (!['employee', 'period', 'delete'].includes(f.kind))
      controls.append(
        select(
          'Сотрудник',
          v['employee_id']!,
          this.model
            .data!.employees.filter((e) => !e.payload.deleted)
            .map((e) => ({ value: e.id, label: e.payload.name })),
          (s) => {
            v['employee_id'] = s;
          },
        ),
      );
    if (f.id && !['employee', 'delete', 'period'].includes(f.kind))
      controls.querySelector('select')!.disabled = true;
    if (f.kind === 'plan') {
      input('start', 'Начало (Алматы)', 'datetime-local');
      input('end', 'Конец (Алматы)', 'datetime-local');
      const positions = [
        ...new Set([
          ...['manager', 'cashier', 'cook', 'assembler'].map((role) => labels[role]!),
          ...this.model.data!.employees.map((e) => e.payload.position ?? ''),
          ...this.model
            .data!.records.filter((record) => record.kind === 'plan')
            .map((record) => String(record.payload['position'] ?? '')),
          v['position'] ?? '',
        ]),
      ].filter(Boolean);
      const position = select(
        'Должность на смене',
        v['position'] ?? '',
        [
          { value: '', label: 'Выберите должность' },
          ...positions.map((value) => ({ value, label: value })),
        ],
        (value) => {
          v['position'] = value;
        },
      );
      position.querySelector('select')!.required = true;
      position.querySelector('select')!.setAttribute('aria-label', 'Должность на смене');
      controls.append(position);
      v['unpaid_break_minutes'] ??= '0';
      input('unpaid_break_minutes', 'План неоплачиваемого перерыва, мин', 'number');
      choice('status', 'Статус', ['draft', 'published', 'cancelled']);
    }
    if (f.kind === 'time') {
      input('date', 'Дата явки', 'date');
      choice('attendance', 'Тип явки', ['worked', 'day_off', 'absence', 'leave', 'sick']);
      const mode = select(
        'Способ ввода',
        v['entry_mode'] ?? 'duration',
        [
          { value: 'duration', label: 'Количество часов за день' },
          { value: 'intervals', label: 'Время прихода и ухода' },
        ],
        (value) => {
          v['entry_mode'] = value;
          this.changed();
        },
      );
      mode.querySelector('select')!.setAttribute('aria-label', 'Способ ввода');
      controls.append(mode);
      if (v['entry_mode'] === 'duration') {
        controls.append(
          field(
            'Отработано часов',
            v['paid_hours'] ?? '',
            (value) => {
              v['paid_hours'] = value;
            },
            {
              hint: 'Десятичные часы: 8,5 = 8 ч 30 мин. До трёх знаков после запятой. Для отсутствия оставьте пустым.',
            },
          ),
        );
      } else
        controls.append(
          field(
            'Оплачиваемые интервалы',
            v['intervals'] ?? '',
            (s) => {
              v['intervals'] = s;
            },
            {
              multiline: true,
              hint: 'По одному на строку: 09:00-12:00 и 12:30-18:00. Для отсутствия оставьте пустым. Конец раньше начала означает следующий день.',
            },
          ),
        );
      choice('status', 'Подтверждение', ['draft', 'approved', 'voided']);
      input('note', 'Примечание / основание явки');
    }
    if (f.kind === 'rate') {
      input('effective_date', 'Действует с', 'date');
      if (f.id) controls.querySelectorAll('input')[0]!.readOnly = true;
      input('hourly_minor', 'Ставка за час, ₸');
      input('valid_until', 'Действует по (необязательно)', 'date', false);
    }
    if (f.kind === 'bonus') {
      input('name', 'Показатель KPI');
      input('target', 'План');
      input('actual', 'Факт');
      input('evidence', 'Основание премии');
      input('amount_minor', 'Премия, ₸');
      choice('status', 'Подтверждение', ['draft', 'approved', 'voided']);
      controls.append(el('p', 'muted', `Месяц: ${this.model.month.slice(0, 7)}`));
    }
    if (f.kind === 'payroll') {
      controls.append(
        el(
          'p',
          'wf-note',
          'Пустая база - автоматический расчёт по подтверждённым часам и ставкам. Явная сумма заменяет только базу. Премии KPI учитываются отдельно. Запись не создаёт выплату.',
        ),
      );
      input('base_override_minor', 'База вручную, ₸ (необязательно)', 'text', false);
      input('note', 'Основание расчёта');
      choice('status', 'Подтверждение', ['draft', 'approved', 'voided']);
      const items = JSON.parse(v['items'] ?? '[]') as {
        name: string;
        effect: string;
        amount_minor: string;
      }[];
      const list = el('div', 'wf-pay-items');
      const sync = () => {
        v['items'] = JSON.stringify(items);
      };
      items.forEach((item, index) => {
        const row = el('div', 'wf-pay-item');
        row.append(
          field('Статья', item.name, (value) => {
            item.name = value;
            sync();
          }),
          select(
            'Вид',
            item.effect,
            [
              { value: 'addition', label: 'Доплата' },
              { value: 'deduction', label: 'Удержание / аванс' },
            ],
            (value) => {
              item.effect = value;
              sync();
            },
          ),
          field('Сумма, ₸', String(Number(item.amount_minor) / 100), (value) => {
            try {
              item.amount_minor = minor(value);
              sync();
            } catch {
              item.amount_minor = 'invalid';
              sync();
            }
          }),
        );
        row.append(
          button('Убрать', () => {
            items.splice(index, 1);
            sync();
            this.changed();
          }),
        );
        list.append(row);
      });
      list.append(
        button('Добавить статью', () => {
          items.push({ name: '', effect: 'deduction', amount_minor: '0' });
          sync();
          this.changed();
        }),
      );
      controls.append(list);
    }
    if (f.kind === 'employee') {
      input('name', 'Имя сотрудника');
      choice('role', 'Роль', ['cook', 'cashier', 'assembler', 'manager', 'staff']);
      input('position', 'Должность', 'text', false);
      input('note', 'Примечание', 'text', false);
      choice('employment_status', 'Текущий статус', ['working', 'inactive', 'unknown']);
    }
    if (f.kind === 'period')
      controls.append(
        el(
          'p',
          'wf-note',
          this.model.data!.period.closed
            ? 'После переоткрытия можно исправить табель. Предыдущий снимок и причина останутся в истории.'
            : 'Закрытие фиксирует подтверждённый табель и базовый расчёт за месяц. Оно не создаёт выплату зарплаты.',
        ),
      );
    input('reason', f.kind === 'delete' ? 'Причина удаления' : 'Причина добавления или изменения');
    box.append(controls);
    const actions = el('div', 'wf-actions'),
      save = el(
        'button',
        f.kind === 'delete' ? 'button wf-delete-confirm' : 'button primary',
        f.kind === 'delete' ? 'Удалить запись' : 'Сохранить',
      );
    save.type = 'submit';
    save.disabled = !this.model.writable;
    actions.append(
      save,
      button('Отмена', () => {
        if (this.model.busy || this.model.pending) return;
        this.clear();
        this.changed();
      }),
    );
    box.append(actions);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
    root.append(box);
  }
  private async submit() {
    const f = this.form!,
      v = f.values;
    try {
      if ((v['reason'] ?? '').trim().length < 3) throw Error('Укажите причину: минимум 3 символа.');
      let payload: Data = { employee_id: v['employee_id'] };
      let command: Data;
      if (f.kind === 'plan')
        payload = {
          ...payload,
          start: v['start'] + ':00+05:00',
          end: v['end'] + ':00+05:00',
          position: v['position'],
          unpaid_break_minutes: Number(v['unpaid_break_minutes']),
          status: v['status'],
        };
      if (f.kind === 'rate')
        payload = {
          ...payload,
          effective_date: v['effective_date'],
          ...(v['valid_until'] ? { valid_until: v['valid_until'] } : {}),
          hourly_minor: minor(v['hourly_minor'] ?? ''),
        };
      if (f.kind === 'time') {
        const intervals = (v['entry_mode'] === 'duration' ? '' : (v['intervals'] ?? ''))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const m = line.trim().match(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
            if (!m) throw Error('Интервал должен быть в формате 09:00-18:00.');
            return {
              start: `${v['date']}T${m[1]}:00+05:00`,
              end: `${m[2]! < m[1]! ? addDays(v['date']!, 1) : v['date']}T${m[2]}:00+05:00`,
            };
          });
        const previous = this.model.data!.records.find((r) => r.id === f.id);
        payload = {
          ...payload,
          date: v['date'],
          status: v['status'],
          attendance: v['attendance'],
          intervals,
          source_event_ids:
            v['entry_mode'] === 'duration' ? [] : (previous?.payload['source_event_ids'] ?? []),
          ...(previous?.payload['source'] ? { source: previous.payload['source'] } : {}),
          note: v['note'],
        };
        if (v['entry_mode'] === 'duration' && v['attendance'] === 'worked') {
          const text = (v['paid_hours'] ?? '').trim().replace(',', '.');
          if (!/^\d+(\.\d{1,3})?$/.test(text) || Number(text) <= 0 || Number(text) > 24)
            throw Error('Укажите отработанные часы от 0 до 24, до трёх знаков после запятой.');
          payload['paid_duration_ms'] = Math.round(Number(text) * 3600000);
        }
      }
      if (f.kind === 'bonus')
        payload = {
          ...payload,
          month: this.model.month,
          name: v['name'],
          target: v['target'],
          actual: v['actual'],
          evidence: v['evidence'],
          amount_minor: minor(v['amount_minor'] ?? ''),
          status: v['status'],
        };
      if (f.kind === 'payroll') {
        const previous = this.model.data!.records.find((r) => r.id === f.id);
        payload = {
          ...payload,
          month: this.model.month,
          status: v['status'],
          note: v['note'],
          base_override_minor: v['base_override_minor']?.trim()
            ? minor(v['base_override_minor'])
            : null,
          items: JSON.parse(v['items'] ?? '[]'),
          ...(previous?.payload['source'] ? { source: previous.payload['source'] } : {}),
        };
      }
      if (f.kind === 'employee')
        payload = {
          name: v['name'],
          role: v['role'],
          active: v['employment_status'] === 'working',
          employment_status: v['employment_status'],
          ...(v['position']?.trim() ? { position: v['position'] } : {}),
          note: v['note'] ?? '',
        };
      if (f.kind === 'delete')
        command = {
          type: 'delete',
          kind: v['target_kind'],
          id: f.id,
          expected_revision: f.revision,
        };
      else if (f.kind === 'period')
        command = {
          type: 'period',
          month: this.model.month,
          closed: !this.model.data!.period.closed,
          expected_revision: this.model.data!.period.revision,
        };
      else
        command = {
          type: f.kind === 'employee' ? 'employee' : 'save',
          ...(f.kind === 'employee' ? {} : { kind: f.kind }),
          id: f.id || crypto.randomUUID(),
          expected_revision: f.revision,
          payload,
        };
      if (await this.model.send(command, v['reason']!)) {
        this.clear();
        this.changed();
      }
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'Проверьте поля.';
      this.changed();
    }
  }
}
