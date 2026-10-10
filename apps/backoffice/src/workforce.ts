import { element as el, button, field, select, check, grid } from './dom.js';
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
  MISSING_RATE: 'Не задана ставка',
  MISSING_TIME: 'Нет подтверждённого табеля',
  UNAPPROVED_TIME: 'Табель ждёт проверки',
  UNAPPROVED_BONUS: 'Премия ждёт подтверждения',
};
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
    if (r.kind === 'bonus') return date === this.model.month;
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
    filters.append(
      field(
        'Месяц',
        this.model.month.slice(0, 7),
        (v) => {
          if (/^\d{4}-\d{2}$/.test(v)) {
            this.model.month = v + '-01';
            this.day = this.model.month;
            void this.model.load();
          }
        },
        { type: 'month' },
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
        bar.append(b);
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
            `BioCheck пока не подключён. Вводите фактические оплачиваемые интервалы вручную. ${data.period.closed ? 'Месячный табель закрыт.' : 'Табель открыт.'}`,
          ),
        );
      const records = data.records
        .filter((r) => r.kind === this.tab && this.matching(r))
        .sort((a, b) =>
          String(a.payload['start'] ?? a.payload['date']).localeCompare(
            String(b.payload['start'] ?? b.payload['date']),
          ),
        );
      const rows = records.map((r) => {
        const p = r.payload;
        const spans =
          this.tab === 'plan'
            ? [{ start: String(p['start']), end: String(p['end']) }]
            : (p['intervals'] as { start: string; end: string }[]);
        const date =
          this.tab === 'plan' ? localDateTime(String(p['start'])).slice(0, 10) : String(p['date']);
        const total =
          intervalSeconds(spans) -
          (this.tab === 'plan' ? Number(p['unpaid_break_minutes']) * 60 : 0);
        const actions = this.recordActions(r.kind, r);
        if (this.tab === 'plan')
          actions.append(this.button('+7 дней', () => this.edit('plan', r, true)));
        return [
          dateText(date),
          this.name(p['employee_id']),
          spans.length ? spanText(spans) : status(p['attendance']),
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
              status(e.payload.role),
              e.payload.active ? 'Работает' : 'Неактивен',
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
              dateText(String(r.payload['effective_date'])),
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
                    unpaid_break_minutes: 'План перерыва, мин',
                    target: 'План KPI',
                    actual: 'Факт KPI',
                    evidence: 'Основание',
                  };
                  if (!names[k]) continue;
                  let text = String(v);
                  if (k === 'employee_id') text = this.name(v);
                  else if (k.endsWith('_minor')) text = money(String(v));
                  else if (k === 'intervals')
                    text = spanText(v as { start: string; end: string }[]);
                  else if (['status', 'attendance', 'role'].includes(k)) text = status(v);
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
    root.append(
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
    root.append(summary);
    if (problems.length || unresolved) {
      const box = el('div', 'wf-alert');
      box.append(el('strong', '', 'Расчёт неполный - проверьте записи'));
      problems.forEach((i) =>
        box.append(el('p', '', `${this.name(i.employee_id)}: ${issues[i.code] ?? i.code}`)),
      );
      if (unresolved) box.append(el('p', '', `Не разобрано отметок устройства: ${unresolved}`));
      root.append(box);
    }
    const rows = lines.map((r) => [
      this.name(r.employee_id),
      hours(r.seconds),
      hours(r.night_seconds),
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
    root.append(
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
    root.append(bar, el('h2', '', 'Премии KPI'));
    root.append(
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
  private edit(kind: string, record?: WorkRecord | EmployeeRecord, duplicate = false) {
    const p = (record?.payload ?? {}) as Data;
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(p)) if (typeof v !== 'object') values[k] = String(v);
    values['employee_id'] ??=
      this.employee || this.model.data?.employees.find((e) => e.payload.active)?.id || '';
    values['date'] ??= this.day;
    values['effective_date'] ??= today();
    values['status'] ??= 'draft';
    values['attendance'] ??= 'worked';
    values['reason'] = '';
    values['role'] ??= 'cook';
    if (kind === 'plan') {
      values['start'] = p['start'] ? localDateTime(String(p['start'])) : this.day + 'T09:00';
      values['end'] = p['end'] ? localDateTime(String(p['end'])) : this.day + 'T18:00';
      if (duplicate) {
        for (const k of ['start', 'end'])
          values[k] = addDays(values[k]!.slice(0, 10), 7) + values[k]!.slice(10);
        values['status'] = 'draft';
      }
    }
    if (kind === 'time')
      values['intervals'] =
        (p['intervals'] as { start: string; end: string }[] | undefined)
          ?.map((s) => `${localDateTime(s.start).slice(11)}-${localDateTime(s.end).slice(11)}`)
          .join('\n') ?? '09:00-18:00';
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
      input('position', 'Должность на смене');
      v['unpaid_break_minutes'] ??= '0';
      input('unpaid_break_minutes', 'План неоплачиваемого перерыва, мин', 'number');
      choice('status', 'Статус', ['draft', 'published', 'cancelled']);
    }
    if (f.kind === 'time') {
      input('date', 'Дата явки', 'date');
      choice('attendance', 'Тип явки', ['worked', 'day_off', 'absence', 'leave', 'sick']);
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
    if (f.kind === 'employee') {
      input('name', 'Имя сотрудника');
      choice('role', 'Роль', ['cook', 'cashier', 'assembler', 'manager']);
      input('note', 'Примечание', 'text', false);
      controls.append(
        check('Сотрудник активен', f.active, (s) => {
          f.active = s;
        }),
      );
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
          hourly_minor: minor(v['hourly_minor'] ?? ''),
        };
      if (f.kind === 'time') {
        const intervals = (v['intervals'] ?? '')
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
          source_event_ids: previous?.payload['source_event_ids'] ?? [],
          note: v['note'],
        };
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
      if (f.kind === 'employee')
        payload = { name: v['name'], role: v['role'], active: f.active, note: v['note'] ?? '' };
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
