import { element as el, button, field, select, check } from './dom.js';
import { message } from './api.js';
import { OperationsModel, object, type Data, type Entry } from './operations-model.js';

export const sections = [
  ['dash', 'Дашборд', 'Продажи, заказы и состояние точки'],
  ['orders', 'Заказы', 'Все каналы, оплата, кухня и история'],
  ['items', 'Номенклатура', 'Блюда, цены, модификаторы и КБЖУ'],
  ['stock', 'Остатки', 'Ингредиенты, техкарты и складские документы'],
  ['reports', 'Отчёты', 'Показатели за выбранный период'],
  ['finance', 'Касса и бухгалтерия', 'Оплаты, возвраты, чеки и сверка'],
  ['promo', 'Промо и баннеры', 'Контент, каналы и расписание публикаций'],
  ['games', 'Игры и челленджи', 'Шаблоны, доступность и расписание'],
  ['guests', 'Гости и push', 'Заказы гостей, согласия и кампании'],
  ['tickets', 'Обращения', 'Вопросы, жалобы и сроки ответа'],
  ['reviews', 'Отзывы', 'Оценки и обратная связь по заказам'],
  ['stations', 'Станции и маршруты', 'Состав кухни и наблюдаемое состояние заказов'],
  ['devices', 'Устройства', 'Доступ и последний обмен с точкой'],
  ['shifts', 'Смены и оценки', 'Сотрудники и управленческий журнал смен'],
  ['audit', 'Журнал аудита', 'Кто, когда и что изменил'],
] as const;
const labels: Record<string, string> = {
  'order.created': 'Заказ создан',
  'order.cancelled': 'Заказ отменён',
  'edge.fulfillment_accepted': 'Принят кухней',
  'edge.task_changed': 'Этап приготовления',
  'edge.fulfillment_ready': 'Готов к выдаче',
  'edge.fulfillment_handed_over': 'Выдан гостю',
  'edge.fulfillment_cancelled': 'Отменён на кухне',
  done: 'Готово',
  edge_pos: 'Касса',
  active: 'Активно',
  archived: 'В архиве',
  draft: 'Черновик',
  new: 'Новое',
  in_progress: 'В работе',
  resolved: 'Решено',
  closed: 'Закрыто',
  ready: 'Готово',
  reviewed: 'Просмотрено',
  pending: 'Ожидает',
  unknown: 'Неизвестно',
  failed: 'Ошибка',
  succeeded: 'Подтверждено',
  issued: 'Выдан',
  queued: 'В очереди',
  awaiting_payment: 'Ждёт оплаты',
  awaiting_admission: 'Проверка точки',
  paid_pending_acceptance: 'Оплачен, ждёт принятия',
  attention_required: 'Требует внимания',
  not_started: 'Не начата',
  held: 'Зарезервирован',
  accepted: 'Принят',
  in_production: 'Готовится',
  handed_over: 'Выдан',
  cancelled: 'Отменён',
  released: 'Резерв снят',
  blocked: 'Не допущен',
  receipt: 'Поступление',
  waste: 'Списание',
  count: 'Инвентаризация',
  production: 'Производство',
  consumption: 'По техкарте',
  pos: 'Касса',
  mobile: 'Приложение',
  kiosk: 'Киоск',
  display: 'Табло',
  edge: 'Точка',
  cloud: 'Облако',
  prep: 'Приготовление',
  assembly: 'Сборка',
  drinks: 'Напитки',
  handoff: 'Выдача',
  manager: 'Управляющий',
  cashier: 'Кассир',
  cook: 'Повар',
  assembler: 'Сборщик',
  normal: 'Обычный',
  urgent: 'Срочный',
  question: 'Вопрос',
  complaint: 'Жалоба',
  all_consented: 'С согласием на рассылку',
  repeat: 'Повторные гости',
  inactive_30d: 'Без заказов 30 дней',
  operator_recorded: 'Записано оператором',
  g: 'г',
  ml: 'мл',
  pcs: 'шт',
};
const val = (v: unknown) => (v === null || v === undefined || v === '' ? '-' : String(v));
const status = (v: unknown) => labels[String(v)] ?? val(v);
const date = (v: unknown) =>
  v
    ? new Date(String(v)).toLocaleString('ru-RU', {
        timeZone: 'Asia/Almaty',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '-';
const amount = (v: unknown) => {
  const n = BigInt(String(v ?? '0')),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${a % 100n ? ',' + (a % 100n).toString().padStart(2, '0') : ''} ₸`;
};
function badge(value: unknown) {
  const n = el('span', 'op-badge', status(value));
  if (['unknown', 'failed', 'attention_required', 'revoked'].includes(String(value)))
    n.classList.add('bad');
  if (['active', 'succeeded', 'issued', 'handed_over', 'resolved'].includes(String(value)))
    n.classList.add('good');
  return n;
}
function note(text: string) {
  return el('p', 'op-note', text);
}
function panel(title: string, sub = '', actions: HTMLElement[] = []) {
  const p = el('section', 'panel op-panel'),
    h = el('div', 'panel-head'),
    t = el('div');
  t.append(el('h2', '', title));
  if (sub) t.append(el('p', 'muted', sub));
  h.append(t, ...actions);
  p.append(h);
  return p;
}
function table(headers: string[], rows: (string | Node)[][], empty = 'Данных пока нет') {
  const wrap = el('div', 'table-wrap'),
    t = el('table', 'op-table'),
    head = el('thead'),
    tr = el('tr');
  for (const s of headers) tr.append(el('th', '', s));
  head.append(tr);
  t.append(head);
  const body = el('tbody');
  for (const row of rows) {
    const r = el('tr');
    for (const c of row) {
      const td = el('td');
      td.append(typeof c === 'string' ? document.createTextNode(c) : c);
      r.append(td);
    }
    body.append(r);
  }
  if (!rows.length) {
    const r = el('tr'),
      td = el('td', 'op-empty', empty);
    td.colSpan = headers.length;
    r.append(td);
    body.append(r);
  }
  t.append(body);
  wrap.append(t);
  return wrap;
}
function stats(items: [string, string, string?][]) {
  const n = el('div', 'stats');
  for (const [label, value, detail] of items) {
    const c = el('div', 'stat');
    c.append(el('span', 'muted', label), el('strong', '', value));
    if (detail) c.append(el('small', 'muted', detail));
    n.append(c);
  }
  return n;
}
function exportCsv(name: string, headers: string[], rows: string[][]) {
  const safe = (s: string) =>
    '"' + (/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"';
  const csv = '\uFEFF' + [headers, ...rows].map((r) => r.map(safe).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = el('a');
  link.href = url;
  link.download = `pickchick-${name}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function dialog(title: string, sub: string) {
  const d = el('dialog', 'op-dialog'),
    head = el('div', 'panel-head'),
    close = button(
      'Закрыть',
      () => {
        d.close();
        d.remove();
      },
      'button subtle',
    );
  head.append(el('h2', '', title), close);
  d.append(head, note(sub));
  document.body.append(d);
  d.showModal();
  d.addEventListener('close', () => d.remove(), { once: true });
  return d;
}
type F = {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'date' | 'number' | 'money' | 'boolean' | 'select';
  options?: { value: string; label: string }[];
  nullable?: boolean;
};
const opts = (values: string[]) => values.map((v) => ({ value: v, label: status(v) }));
const get = (p: Data, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Data)[k] : undefined), p);
function put(p: Data, path: string, v: unknown) {
  const parts = path.split('.');
  let r = p;
  for (const k of parts.slice(0, -1)) {
    if (!r[k]) r[k] = {};
    r = r[k] as Data;
  }
  r[parts.at(-1)!] = v;
}
const now = () => new Date().toISOString();
const schedule = () => ({
  starts_at: now(),
  ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
});
const defaultPayload = (kind: string): Data =>
  (
    ({
      ingredient: { name: '', unit: 'g', minimum: '0', active: true },
      recipe: {
        name: '',
        product_id: '',
        output_ingredient_id: null,
        yield_quantity: '1',
        lines: [],
      },
      promo: {
        name: '',
        title: { ru: '', kk: '' },
        body: { ru: '', kk: '' },
        image_asset_key: 'logo',
        channels: ['mobile'],
        schedule: schedule(),
        status: 'draft',
      },
      game: {
        name: '',
        template: 'pick-blocks',
        enabled: false,
        daily_attempts: 5,
        reward_chiki: '0',
        schedule: schedule(),
      },
      campaign: {
        name: '',
        title: { ru: '', kk: '' },
        body: { ru: '', kk: '' },
        segment: 'all_consented',
        status: 'draft',
        daily_limit: 100,
        schedule: schedule(),
      },
      ticket: {
        name: '',
        order_id: null,
        category: 'question',
        priority: 'normal',
        assignee_id: null,
        due_at: null,
        status: 'new',
        description: '',
        resolution: '',
      },
      review: {
        name: '',
        order_id: '',
        stars: 5,
        text: '',
        source: 'operator_recorded',
        status: 'new',
        internal_note: '',
      },
      station: {
        name: '',
        role: 'prep',
        device_id: null,
        active: true,
        product_ids: [],
        target_seconds: 300,
      },
      employee: { name: '', role: 'cook', active: true, note: '' },
      shift: {
        name: '',
        employee_id: '',
        opened_at: now(),
        closed_at: null,
        opening_cash_minor: '0',
        closing_cash_minor: null,
        note: '',
      },
    }) as Record<string, Data>
  )[kind]!;

export class OperationsView {
  constructor(
    readonly model: OperationsModel,
    private catalog: () => { products: { id: string; name: { ru: string } }[] } | null,
  ) {}
  private options(kind: string) {
    return this.model.entries(kind).map((r) => ({ value: r.id, label: val(r.payload['name']) }));
  }
  private async submit(d: HTMLDialogElement, command: () => Data, reason: string) {
    const error = d.querySelector('.op-form-error')!;
    error.textContent = '';
    try {
      const ok = await this.model.execute(command(), reason);
      if (ok) {
        d.close();
        d.remove();
      } else error.textContent = message(this.model.error);
    } catch (e) {
      error.textContent = message(e);
    }
  }
  private footer(d: HTMLDialogElement, command: () => Data, label = 'Сохранить') {
    let reason = '';
    d.append(
      field(
        'Причина изменения',
        reason,
        (v) => {
          reason = v;
        },
        { required: true, id: 'op-reason', max: 500 },
      ),
    );
    const error = el('p', 'notice error op-form-error');
    error.setAttribute('role', 'alert');
    d.append(error);
    const save = button(
      label,
      () => void this.submit(d, command, reason),
      'button primary',
      'op-save',
    );
    d.append(save);
  }
  edit(kind: string, record?: Entry) {
    const p = structuredClone(record?.payload ?? defaultPayload(kind)),
      d = dialog(
        record ? 'Изменить запись' : 'Новая запись',
        'Изменения сохраняются для выбранной точки и попадают в журнал аудита.',
      );
    d.dataset.testid = 'op-editor';
    const fields: F[] = [{ key: 'name', label: 'Название' }];
    const stateField: F = {
      key: 'status',
      label: 'Статус',
      type: 'select',
      options: opts(['draft', 'active', 'archived']),
    };
    const dates: F[] = [
      { key: 'schedule.starts_at', label: 'Начало, по Алматы', type: 'date' },
      { key: 'schedule.ends_at', label: 'Окончание, по Алматы', type: 'date' },
    ];
    if (kind === 'ingredient')
      fields.push(
        {
          key: 'unit',
          label: 'Учётная единица',
          type: 'select',
          options: opts(['g', 'ml', 'pcs']),
        },
        { key: 'minimum', label: 'Минимальный запас в учётных единицах' },
        { key: 'active', label: 'Используется', type: 'boolean' },
      );
    if (kind === 'promo' || kind === 'campaign')
      fields.push(
        { key: 'title.ru', label: 'Заголовок RU' },
        { key: 'title.kk', label: 'Заголовок KZ' },
        { key: 'body.ru', label: 'Текст RU', type: 'textarea' },
        { key: 'body.kk', label: 'Текст KZ', type: 'textarea' },
        ...dates,
      );
    if (kind === 'promo')
      fields.push(stateField, {
        key: 'image_asset_key',
        label: 'Изображение',
        type: 'select',
        options: [
          { value: 'logo', label: 'Логотип' },
          ...Array.from({ length: 24 }, (_, i) => i)
            .filter((i) => i !== 3 && i !== 21)
            .map((i) => ({
              value: 'i' + i,
              label: 'Фото меню ' + (i + 1),
            })),
        ],
      });
    if (kind === 'game')
      fields.push(
        {
          key: 'template',
          label: 'Игра',
          type: 'select',
          options: [
            { value: 'pick-run', label: 'PICK RUN' },
            { value: 'pick-man', label: 'PICK MAN' },
            { value: 'pick-blocks', label: 'PICK BLOCKS' },
          ],
        },
        { key: 'enabled', label: 'Доступна', type: 'boolean' },
        { key: 'daily_attempts', label: 'Планируемый лимит попыток', type: 'number' },
        ...dates,
      );
    if (kind === 'campaign')
      fields.push(
        {
          key: 'segment',
          label: 'Сегмент',
          type: 'select',
          options: opts(['all_consented', 'repeat', 'inactive_30d']),
        },
        { key: 'daily_limit', label: 'Дневной лимит', type: 'number' },
        { ...stateField, options: opts(['draft', 'ready', 'archived']) },
      );
    const orders = [...(this.model.data?.orders ?? []), ...(this.model.data?.pos ?? [])].map(
      (o) => ({
        value: String(o['id']),
        label: String(o['id']).slice(0, 8) + ' · ' + amount(o['total_minor']),
      }),
    );
    if (kind === 'ticket')
      fields.push(
        { key: 'order_id', label: 'Заказ', type: 'select', options: orders, nullable: true },
        { key: 'category', label: 'Тип', type: 'select', options: opts(['question', 'complaint']) },
        {
          key: 'priority',
          label: 'Приоритет',
          type: 'select',
          options: opts(['normal', 'urgent']),
        },
        {
          key: 'assignee_id',
          label: 'Ответственный',
          type: 'select',
          options: this.options('employee'),
          nullable: true,
        },
        { key: 'due_at', label: 'Ответить до, по Алматы', type: 'date', nullable: true },
        {
          key: 'status',
          label: 'Статус',
          type: 'select',
          options: opts(['new', 'in_progress', 'resolved', 'closed']),
        },
        { key: 'description', label: 'Описание', type: 'textarea' },
        { key: 'resolution', label: 'Результат работы', type: 'textarea' },
      );
    if (kind === 'review')
      fields.push(
        { key: 'order_id', label: 'Заказ', type: 'select', options: orders },
        { key: 'stars', label: 'Оценка от 1 до 5', type: 'number' },
        { key: 'text', label: 'Текст отзыва', type: 'textarea' },
        { key: 'status', label: 'Статус', type: 'select', options: opts(['new', 'reviewed']) },
        { key: 'internal_note', label: 'Внутренняя заметка', type: 'textarea' },
      );
    if (kind === 'station')
      fields.push(
        {
          key: 'role',
          label: 'Роль станции',
          type: 'select',
          options: opts(['prep', 'assembly', 'drinks', 'handoff']),
        },
        {
          key: 'device_id',
          label: 'Экран',
          type: 'select',
          options: (this.model.data?.devices ?? [])
            .filter((v) => ['kitchen', 'display'].includes(String(v['kind'])))
            .map((v) => ({ value: String(v['id']), label: String(v['name']) })),
          nullable: true,
        },
        { key: 'target_seconds', label: 'Норма, секунд', type: 'number' },
        { key: 'active', label: 'Активна', type: 'boolean' },
      );
    if (kind === 'employee')
      fields.push(
        {
          key: 'role',
          label: 'Роль в журнале смен',
          type: 'select',
          options: opts(['manager', 'cashier', 'cook', 'assembler']),
        },
        { key: 'active', label: 'Работает', type: 'boolean' },
        { key: 'note', label: 'Примечание', type: 'textarea' },
      );
    if (kind === 'shift')
      fields.push(
        {
          key: 'employee_id',
          label: 'Ответственный',
          type: 'select',
          options: this.options('employee'),
        },
        { key: 'opened_at', label: 'Открыта, по Алматы', type: 'date' },
        { key: 'closed_at', label: 'Закрыта, по Алматы', type: 'date', nullable: true },
        { key: 'opening_cash_minor', label: 'Наличность на начало, ₸', type: 'money' },
        {
          key: 'closing_cash_minor',
          label: 'Наличность при закрытии, ₸',
          type: 'money',
          nullable: true,
        },
        { key: 'note', label: 'Примечание', type: 'textarea' },
      );
    if (kind === 'recipe')
      fields.push(
        {
          key: 'product_id',
          label: 'Блюдо меню',
          type: 'select',
          options: (this.catalog()?.products ?? []).map((v) => ({ value: v.id, label: v.name.ru })),
        },
        {
          key: 'output_ingredient_id',
          label: 'Выход полуфабриката (если нужен)',
          type: 'select',
          options: this.options('ingredient'),
          nullable: true,
        },
        { key: 'yield_quantity', label: 'Выход полуфабриката в учётных единицах' },
      );
    const form = el('div', 'form-grid');
    for (const f of fields) {
      const v = get(p, f.key);
      const testId = 'op-' + f.key.replaceAll('.', '-');
      if (f.type === 'boolean') {
        form.append(check(f.label, Boolean(v), (n) => put(p, f.key, n), testId));
        continue;
      }
      if (f.type === 'select') {
        const options = f.nullable
          ? [{ value: '', label: 'Не задано' }, ...f.options!]
          : f.options!;
        if (!v && !f.nullable && options[0]) put(p, f.key, options[0].value);
        form.append(
          select(
            f.label,
            String(get(p, f.key) ?? ''),
            options,
            (n) => put(p, f.key, f.nullable && !n ? null : n),
            testId,
          ),
        );
        continue;
      }
      let value = String(v ?? '');
      if (f.type === 'date' && v)
        value = new Date(new Date(String(v)).getTime() + 5 * 3600000).toISOString().slice(0, 16);
      if (f.type === 'money' && v !== null)
        value =
          (BigInt(String(v ?? 0)) / 100n).toString() +
          '.' +
          (BigInt(String(v ?? 0)) % 100n).toString().padStart(2, '0');
      form.append(
        field(
          f.label,
          value,
          (n) => {
            let value: unknown = n;
            if (f.nullable && !n) value = null;
            else if (f.type === 'number') value = Number(n);
            else if (f.type === 'date')
              value = n
                ? Number.isFinite(Date.parse(n + ':00+05:00'))
                  ? new Date(n + ':00+05:00').toISOString()
                  : n
                : null;
            else if (f.type === 'money') {
              const m = n.replace(',', '.').match(/^(\d+)(?:\.(\d{1,2}))?$/);
              value = m
                ? (BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'))).toString()
                : n;
            }
            put(p, f.key, value);
          },
          {
            id: testId,
            multiline: f.type === 'textarea',
            type: f.type === 'date' ? 'datetime-local' : f.type === 'number' ? 'number' : 'text',
          },
        ),
      );
    }
    d.append(form);
    if (kind === 'promo') {
      const box = el('div', 'op-checks');
      for (const channel of ['mobile', 'kiosk', 'display'])
        box.append(
          check(status(channel), (p['channels'] as string[]).includes(channel), (on) => {
            p['channels'] = on
              ? [...(p['channels'] as string[]), channel]
              : (p['channels'] as string[]).filter((v) => v !== channel);
          }),
        );
      d.append(box);
    }
    if (kind === 'station') {
      const box = el('div', 'op-checks');
      for (const product of this.catalog()?.products ?? [])
        box.append(
          check(product.name.ru, (p['product_ids'] as string[]).includes(product.id), (on) => {
            p['product_ids'] = on
              ? [...(p['product_ids'] as string[]), product.id]
              : (p['product_ids'] as string[]).filter((v) => v !== product.id);
          }),
        );
      d.append(el('h3', '', 'Позиции станции'), box);
    }
    if (kind === 'recipe') {
      const lines = p['lines'] as Data[],
        wrap = el('div');
      const draw = () => {
        wrap.replaceChildren();
        for (const [i, line] of lines.entries()) {
          const row = el('div', 'op-line');
          row.append(
            select('Ингредиент', String(line['ingredient_id']), this.options('ingredient'), (v) => {
              line['ingredient_id'] = v;
            }),
            field('Количество в учётных единицах', String(line['quantity']), (v) => {
              line['quantity'] = v;
            }),
            button(
              'Убрать',
              () => {
                lines.splice(i, 1);
                draw();
              },
              'button subtle',
            ),
          );
          wrap.append(row);
        }
      };
      draw();
      d.append(
        el('h3', '', 'Состав на одну порцию / выпуск'),
        wrap,
        button('Добавить ингредиент', () => {
          lines.push({ ingredient_id: this.options('ingredient')[0]?.value ?? '', quantity: '1' });
          draw();
        }),
      );
    }
    if (kind === 'campaign')
      d.append(
        note(
          'Сохранение готовит кампанию. Отправка станет доступна после подключения push-провайдера.',
        ),
      );
    if (kind === 'game')
      d.append(note('Награды пока не начисляются. Для них нужен серверный валидатор результатов.'));
    if (kind === 'station')
      d.append(
        note(
          'Публикация сохраняет план. Применение на локальной кухне требует подтверждения устройства.',
        ),
      );
    this.footer(d, () => ({
      type: 'save',
      kind,
      id: record?.id ?? crypto.randomUUID(),
      expected_revision: record?.revision ?? 0,
      payload: p,
    }));
  }
  private confirm(title: string, detail: string, command: Data) {
    const d = dialog(title, detail);
    this.footer(d, () => command, 'Подтвердить');
  }
  private records(
    kind: string,
    title: string,
    fields: [string, (p: Data) => string | Node][],
    sub = '',
  ) {
    const writable = this.model.data?.role === 'manager',
      p = panel(
        title,
        sub,
        writable
          ? [button('Добавить', () => this.edit(kind), 'button primary', 'op-add-' + kind)]
          : [],
      );
    const rows = this.model.entries(kind).map((r) => {
      const actions = el('div', 'op-actions');
      if (writable)
        actions.append(
          button('Изменить', () => this.edit(kind, r), 'button subtle', 'op-edit-' + r.id),
        );
      if (writable && kind === 'recipe' && r.payload['output_ingredient_id'])
        actions.append(button('Произвести', () => this.produce(r), 'button subtle'));
      if (writable && ['promo', 'game', 'station'].includes(kind)) {
        const pub = this.model.data?.publications.find((v) => v['record_id'] === r.id);
        if (pub?.['revision'] === r.revision) actions.append(badge('Опубликовано'));
        else
          actions.append(
            button(
              'Опубликовать',
              () =>
                this.confirm('Опубликовать запись', String(r.payload['name']), {
                  type: 'publish',
                  kind,
                  id: r.id,
                  expected_revision: r.revision,
                }),
              'button subtle',
            ),
          );
      }
      return [
        String(r.payload['name']),
        ...fields.map(([, f]) => f(r.payload)),
        date(r.updated_at),
        actions,
      ];
    });
    p.append(table(['Название', ...fields.map(([t]) => t), 'Изменено', 'Действия'], rows));
    return p;
  }
  private balances() {
    return Object.fromEntries(
      (this.model.data?.stock ?? []).map((r) => [String(r['id']), r['revision']]),
    );
  }
  private produce(recipe: Entry) {
    const d = dialog(
      'Производство полуфабриката',
      'Ингредиенты будут списаны, а стоимость перенесена на изготовленный полуфабрикат одним документом.',
    );
    const expected = this.balances();
    let batches = '1',
      reference = '';
    d.append(
      el('h3', '', String(recipe.payload['name'])),
      field('Количество партий', batches, (v) => {
        batches = v;
      }),
      field('Номер документа', reference, (v) => {
        reference = v;
      }),
    );
    this.footer(
      d,
      () => ({
        type: 'produce',
        recipe_id: recipe.id,
        recipe_revision: recipe.revision,
        batches: Number(batches),
        reference,
        expected_balances: expected,
      }),
      'Провести производство',
    );
  }
  private stock(kind: 'receipt' | 'waste' | 'count') {
    const data = this.model.data!,
      d = dialog(
        status(kind),
        'Количество указывается в учётной единице ингредиента. Документ проводится целиком.',
      );
    let reference = '';
    d.append(
      field(
        'Номер документа',
        reference,
        (v) => {
          reference = v;
        },
        { id: 'op-reference' },
      ),
    );
    const lines: Data[] = [];
    const wrap = el('div');
    const draw = () => {
      wrap.replaceChildren();
      for (const [i, l] of lines.entries()) {
        const ingredient = data.stock.find((v) => v['id'] === l['ingredient_id']),
          unit = ingredient ? status(object(ingredient['payload'])['unit']) : '';
        const row = el('div', 'op-line');
        row.append(
          select(
            'Ингредиент',
            String(l['ingredient_id']),
            data.stock.map((v) => ({
              value: String(v['id']),
              label: String(object(v['payload'])['name']),
            })),
            (id) => {
              l['ingredient_id'] = id;
              draw();
            },
            'op-stock-ingredient-' + i,
          ),
          field(
            'Количество, ' + unit,
            String(l['quantity']),
            (v) => {
              l['quantity'] = v;
            },
            { id: 'op-stock-quantity-' + i },
          ),
        );
        if (kind === 'receipt')
          row.append(
            field(
              'Стоимость поступления, ₸',
              String(l['cost'] ?? ''),
              (v) => {
                l['cost'] = v;
              },
              { id: 'op-stock-cost-' + i },
            ),
          );
        row.append(
          button(
            'Убрать',
            () => {
              lines.splice(i, 1);
              draw();
            },
            'button subtle',
          ),
        );
        wrap.append(row);
      }
    };
    const add = () => {
      lines.push({ ingredient_id: String(data.stock[0]?.['id'] ?? ''), quantity: '', cost: '' });
      draw();
    };
    add();
    d.append(wrap, button('Добавить строку', add));
    this.footer(
      d,
      () => ({
        type: 'stock',
        kind,
        reference,
        lines: lines.map((l) => {
          const b = data.stock.find((v) => v['id'] === l['ingredient_id'])!,
            m = String(l['cost'] ?? '0')
              .replace(',', '.')
              .match(/^(\d+)(?:\.(\d{1,2}))?$/);
          return {
            ingredient_id: l['ingredient_id'],
            quantity: l['quantity'],
            value_minor:
              kind === 'receipt' && m
                ? (BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'))).toString()
                : kind === 'receipt'
                  ? String(l['cost'] ?? '')
                  : '0',
            expected_revision: Number(b['revision'] ?? 0),
          };
        }),
      }),
      'Провести документ',
    );
  }
  async order(id: string) {
    try {
      const data = await this.model.order(id),
        o = object(data['order']),
        s = object(o['snapshot']),
        d = dialog(
          'Заказ ' + id.slice(0, 8),
          'Источник: ' + status(data['owner']) + ' · ' + date(o['created_at']),
        );
      d.append(
        stats([
          ['Сумма заказа', amount(o['total_minor'])],
          ['Статус', status(o['state'])],
          ['Версия', val(o['version'])],
          ['Владелец', status(data['owner'])],
          ...(o['kitchen_state']
            ? [['Кухня', status(o['kitchen_state'])] as [string, string]]
            : []),
        ]),
      );
      const lines = (
        Array.isArray(s['lines']) ? s['lines'] : Array.isArray(s['items']) ? s['items'] : []
      ) as Data[];
      d.append(
        table(
          ['Позиция', 'Количество', 'Цена'],
          lines.map((l) => [
            val(
              l['title'] ??
                (l['name'] && typeof l['name'] === 'object' ? object(l['name'])['ru'] : l['name']),
            ),
            val(l['quantity']),
            amount(l['unitPriceMinor'] ?? l['unit_price_minor']),
          ]),
        ),
      );
      for (const [key, title] of [
        ['captures', 'Подтверждённые оплаты'],
        ['refunds', 'Возвраты'],
        ['fiscal', 'Фискальные документы'],
      ] as const)
        d.append(
          el('h3', '', title),
          table(
            ['Операция', 'Сумма', 'Статус'],
            (data[key] as Data[]).map((r) => [
              String(r['id']).slice(0, 8),
              amount(r['amount_minor']),
              badge(r['state'] ?? 'succeeded'),
            ]),
          ),
        );
      d.append(
        el('h3', '', 'История заказа и кухни'),
        table(
          ['Событие', 'Состояние', 'Версия', 'Получено'],
          (data['events'] as Data[]).map((r) => [
            status(r['event_type']),
            status(r['task_state'] ?? r['state']),
            val(r['aggregate_version']),
            date(r['received_at']),
          ]),
        ),
      );
      if (data['owner'] === 'cloud' && this.model.data?.role === 'manager') {
        d.append(
          button('Отменить неоплаченный заказ', () =>
            this.confirm(
              'Запросить отмену',
              'Отмена завершится после подтверждения локальной точки.',
              { type: 'cancel_order', id, expected_version: Number(o['version']) },
            ),
          ),
        );
        d.append(
          button('Списать ингредиенты по заказу', () =>
            this.confirm(
              'Списание по техкартам',
              'Сервер проверит подтверждение кухни и техкарты на момент заказа. Комбо и модификаторы требуют отдельных норм. Повторное списание запрещено.',
              { type: 'consume', order_id: id, expected_balances: this.balances() },
            ),
          ),
        );
        for (const capture of data['captures'] as Data[])
          d.append(
            button('Запросить возврат по оплате ' + String(capture['id']).slice(0, 8), () => {
              const refund = dialog(
                'Возврат денег',
                'Запрос уйдёт платёжному адаптеру. Результат будет показан после подтверждения; склад автоматически не восстанавливается.',
              );
              let value = '';
              refund.append(
                field('Сумма, ₸', value, (v) => {
                  value = v;
                }),
              );
              this.footer(
                refund,
                () => {
                  const parts = value.replace(',', '.').match(/^(\d+)(?:\.(\d{1,2}))?$/);
                  return {
                    type: 'refund',
                    id,
                    capture_id: capture['id'],
                    amount_minor: parts
                      ? (
                          BigInt(parts[1]!) * 100n +
                          BigInt((parts[2] ?? '').padEnd(2, '0'))
                        ).toString()
                      : value,
                  };
                },
                'Запросить возврат',
              );
            }),
          );
      }
    } catch (e) {
      const d = dialog('Не удалось открыть заказ', '');
      d.append(note(message(e)));
    }
  }
  render(page: string, content: HTMLElement) {
    const m = this.model,
      d = m.data;
    if (m.error) content.append(note(message(m.error)));
    if (m.pending)
      content.append(
        panel(
          'Проверить результат',
          'Предыдущая команда ещё не подтверждена. Новые изменения заблокированы.',
          [button('Проверить', () => void m.recover(), 'button primary', 'op-recover')],
        ),
      );
    if (!d) {
      content.append(
        panel(
          m.busy ? 'Загружаем данные…' : 'Данные недоступны',
          'Для операционных разделов нужен отдельный доступ управляющего к выбранной точке.',
          [button('Повторить', () => void m.load(m.actor, m.branch))],
        ),
      );
      return;
    }
    const metrics = d.metrics;
    if (page === 'dash' || page === 'reports') {
      content.append(
        stats([
          [
            'Подтверждённые оплаты',
            amount(metrics['captured_minor']),
            'По времени банковской операции',
          ],
          ['Возвраты', amount(metrics['refunded_minor']), 'Подтверждённые операции'],
          ['Заказы приложения', val(metrics['orders'])],
          ['Выдано', val(metrics['handed_over']), 'Из заказов выбранного периода'],
        ]),
      );
      const grid = el('div', 'op-grid'),
        chart = panel('Оплаты по дням', 'Подтверждённые суммы, ₸'),
        bars = el('div', 'op-bars');
      const max = d.chart.reduce(
        (a, r) => (BigInt(String(r['amount_minor'])) > a ? BigInt(String(r['amount_minor'])) : a),
        1n,
      );
      for (const r of d.chart) {
        const b = el('div', 'op-bar');
        const bar = el('progress');
        bar.max = 1000;
        bar.value = Number((BigInt(String(r['amount_minor'])) * 1000n) / max);
        bar.setAttribute('aria-label', val(r['day']));
        b.append(el('span', '', val(r['day'])), bar, el('strong', '', amount(r['amount_minor'])));
        bars.append(b);
      }
      if (!d.chart.length) bars.append(note('Подтверждённых оплат за этот период нет.'));
      chart.append(bars);
      const signals = panel('Требует внимания');
      signals.append(
        table(
          ['Показатель', 'Количество'],
          [
            ['Неизвестные платежи', val(metrics['unknown_payments'])],
            ['Заказы на кухне', val(metrics['kitchen_active'])],
            ['Сигналы сверки', String(d.issues.length)],
            ['POS-заказы', val(metrics['pos_orders'])],
          ],
        ),
      );
      grid.append(chart, signals);
      content.append(grid);
      const received = BigInt(String(metrics['captured_minor'])),
        refunded = BigInt(String(metrics['refunded_minor'])),
        completed = BigInt(String(metrics['completed_total_minor'])),
        count = BigInt(String(metrics['handed_over']));
      const report = [
        ['Оплаты', received.toString()],
        ['Возвраты', refunded.toString()],
        ['Оплаты за вычетом возвратов', (received - refunded).toString()],
        ['Средняя сумма выданного заказа', count ? (completed / count).toString() : '0'],
      ];
      if (page === 'reports') {
        const p = panel(
          'Финансовые показатели',
          'Средняя сумма: исходная сумма выданных заказов, до вычета возвратов.',
          [
            button('Экспорт CSV', () =>
              exportCsv('report', ['Показатель', 'Сумма, минимальные единицы KZT'], report),
            ),
          ],
        );
        p.append(
          table(
            ['Показатель', 'Значение'],
            report.map(([a, b]) => [a!, amount(b)]),
          ),
        );
        content.append(
          p,
          note(
            'Поступления на банковский счёт, комиссии и чистая прибыль не рассчитываются без банковского реестра и полной базы расходов.',
          ),
        );
      }
      return;
    }
    if (page === 'orders') {
      const rows = [...d.orders, ...d.pos].sort((a, b) =>
          String(b['created_at']).localeCompare(String(a['created_at'])),
        ),
        p = panel(
          'Реестр заказов',
          'Последние 200 записей каждого источника в выбранном периоде.',
          [
            button('Экспорт CSV', () =>
              exportCsv(
                'orders',
                ['Заказ', 'Канал', 'Сумма в минимальных единицах KZT', 'Статус'],
                rows.map((o) => [
                  val(o['id']),
                  status(o['channel']),
                  val(o['total_minor']),
                  status(o['state']),
                ]),
              ),
            ),
          ],
        );
      let query = '',
        channel = '';
      const list = el('div');
      const draw = () => {
        list.replaceChildren(
          table(
            ['Заказ', 'Канал', 'Сумма', 'Оплата', 'Кухня', 'Получено', ''],
            rows
              .filter(
                (o) => (!channel || o['channel'] === channel) && String(o['id']).includes(query),
              )
              .map((o) => [
                String(o['id']).slice(0, 8),
                status(o['channel']),
                amount(o['total_minor']),
                badge(o['payment_state']),
                badge(o['kitchen_state'] ?? o['state']),
                date(o['observed_at']),
                button('Открыть', () => void this.order(String(o['id'])), 'button subtle'),
              ]),
          ),
        );
      };
      const toolbar = el('div', 'toolbar');
      toolbar.append(
        field(
          'Найти заказ',
          query,
          (v) => {
            query = v;
            draw();
          },
          { id: 'op-order-search' },
        ),
        select('Канал', channel, [{ value: '', label: 'Все' }, ...opts(['mobile', 'pos'])], (v) => {
          channel = v;
          draw();
        }),
      );
      p.append(toolbar, list);
      draw();
      content.append(p);
      return;
    }
    if (page === 'stock') {
      content.append(
        stats([
          ['Ингредиентов', String(d.stock.length)],
          [
            'Оценка запасов',
            amount(d.stock.reduce((v, r) => v + BigInt(String(r['value_minor'] ?? 0)), 0n)),
          ],
          [
            'Ниже минимума',
            String(
              d.stock.filter(
                (r) =>
                  BigInt(String(r['quantity'] ?? 0)) <
                  BigInt(String(object(r['payload'])['minimum'])),
              ).length,
            ),
          ],
          ['Документы', String(d.documents.length), 'Последние 200'],
        ]),
      );
      const actions =
        d.role === 'manager'
          ? [
              button('Поставка', () => this.stock('receipt'), 'button primary', 'op-receipt'),
              button('Списание', () => this.stock('waste'), 'button', 'op-waste'),
              button('Инвентаризация', () => this.stock('count'), 'button', 'op-count'),
            ]
          : [];
      const p = panel(
        'Остатки',
        'Учёт по ингредиентам. Себестоимость списания - средневзвешенная.',
        actions,
      );
      p.append(
        table(
          ['Ингредиент', 'Единица', 'Остаток', 'Минимум', 'Стоимость'],
          d.stock.map((r) => {
            const p = object(r['payload']);
            return [
              val(p['name']),
              status(p['unit']),
              val(r['quantity'] ?? 0),
              val(p['minimum']),
              amount(r['value_minor']),
            ];
          }),
        ),
      );
      content.append(
        p,
        this.records('ingredient', 'Ингредиенты', [
          ['Единица', (p) => status(p['unit'])],
          ['Используется', (p) => (p['active'] ? 'Да' : 'Нет')],
        ]),
        this.records('recipe', 'Техкарты', [
          [
            'Блюдо',
            (p) =>
              this.catalog()?.products.find((v) => v.id === p['product_id'])?.name.ru ??
              val(p['product_id']),
          ],
          ['Компоненты', (p) => String((p['lines'] as Data[]).length)],
        ]),
      );
      const docs = panel('Документы склада');
      docs.append(
        table(
          ['Документ', 'Тип', 'Причина', 'Создан'],
          d.documents.map((v) => [
            val(v['reference']),
            status(v['kind']),
            val(v['reason']),
            date(v['created_at']),
          ]),
        ),
      );
      content.append(docs);
      return;
    }
    if (page === 'finance') {
      content.append(
        stats([
          ['Оплаты', amount(metrics['captured_minor'])],
          ['Возвраты', amount(metrics['refunded_minor'])],
          ['Неизвестные платежи', val(metrics['unknown_payments'])],
          ['Проблемы сверки', String(d.issues.length)],
        ]),
      );
      const p = panel('Фискальные документы', 'Статус приходит от фискального адаптера.');
      p.append(
        table(
          ['Документ', 'Заказ', 'Тип', 'Сумма', 'Статус'],
          d.finance.map((v) => [
            String(v['id']).slice(0, 8),
            String(v['order_id']).slice(0, 8),
            v['kind'] === 'sale' ? 'Продажа' : 'Возврат',
            amount(v['amount_minor']),
            badge(v['state']),
          ]),
        ),
      );
      const r = panel('Возвраты');
      r.append(
        table(
          ['Заказ', 'Сумма', 'Причина', 'Статус'],
          d.refunds.map((v) => [
            String(v['order_id']).slice(0, 8),
            amount(v['amount_minor']),
            val(v['reason']),
            badge(v['state']),
          ]),
        ),
      );
      content.append(
        p,
        r,
        note(
          'Закрытие фискальной смены и выгрузка в 1С ожидают подключения и проверки соответствующих адаптеров.',
        ),
      );
      return;
    }
    if (page === 'promo')
      content.append(
        this.records('promo', 'Промо и баннеры', [
          ['Каналы', (p) => (p['channels'] as string[]).map(status).join(' · ')],
          ['Статус', (p) => badge(p['status'])],
          ['Начало', (p) => date(object(p['schedule'])['starts_at'])],
        ]),
      );
    if (page === 'games')
      content.append(
        this.records(
          'game',
          'Игры и челленджи',
          [
            ['Игра', (p) => val(p['template']).toUpperCase().replaceAll('-', ' ')],
            ['Доступ', (p) => (p['enabled'] ? 'Включена' : 'Выключена')],
            ['Плановый лимит', (p) => val(p['daily_attempts'])],
          ],
          'Публикация меняет доступность игры в приложении. Лимит попыток подготовлен для будущей серверной проверки; награды отключены.',
        ),
      );
    if (page === 'guests') {
      const p = panel(
        'Гости точки',
        'Только гости с заказами в этой точке. Контактные данные скрыты.',
      );
      p.append(
        table(
          ['Гость', 'Заказов', 'Последний заказ', 'Маркетинг'],
          d.guests.map((v) => [
            String(v['id']).slice(0, 8),
            val(v['orders']),
            date(v['last_order_at']),
            v['marketing_consent'] ? 'Согласие получено' : 'Нет согласия',
          ]),
        ),
      );
      content.append(
        p,
        this.records(
          'campaign',
          'Кампании',
          [
            ['Сегмент', (p) => status(p['segment'])],
            ['Статус', (p) => badge(p['status'])],
            ['Лимит', (p) => val(p['daily_limit'])],
          ],
          'Черновики кампаний. Отправка пока не подключена.',
        ),
      );
    }
    if (page === 'tickets')
      content.append(
        this.records('ticket', 'Обращения', [
          ['Тип', (p) => status(p['category'])],
          ['Статус', (p) => badge(p['status'])],
          ['Срок', (p) => date(p['due_at'])],
          [
            'Ответственный',
            (p) => this.options('employee').find((v) => v.value === p['assignee_id'])?.label ?? '-',
          ],
        ]),
      );
    if (page === 'reviews')
      content.append(
        this.records(
          'review',
          'Отзывы',
          [
            ['Оценка', (p) => '★'.repeat(Number(p['stars']))],
            ['Отзыв', (p) => val(p['text'])],
            ['Статус', (p) => badge(p['status'])],
          ],
          'Отзывы по заказам, записанные оператором. Внешние площадки не подключены.',
        ),
      );
    if (page === 'stations') {
      content.append(
        this.records(
          'station',
          'План станций',
          [
            ['Роль', (p) => status(p['role'])],
            ['Позиций', (p) => String((p['product_ids'] as string[]).length)],
            ['Норма', (p) => val(p['target_seconds']) + ' с'],
          ],
          'Изменение плана не меняет маршруты уже принятых заказов.',
        ),
      );
      const p = panel(
        'Наблюдаемые заказы кухни',
        'Последнее подтверждённое состояние из обмена с локальной точкой.',
      );
      p.append(
        table(
          ['Заказ', 'Статус', 'Версия маршрута', 'Получено'],
          d.kitchen.map((v) => [
            val(v['display_number'] ?? String(v['order_id']).slice(0, 8)),
            badge(v['state']),
            val(v['routing_version']),
            date(v['observed_at']),
          ]),
        ),
      );
      content.append(p);
    }
    if (page === 'devices') {
      const p = panel(
        'Устройства точки',
        'Время обмена не является подтверждением, что устройство сейчас онлайн.',
      );
      p.append(
        table(
          ['Устройство', 'Тип', 'Доступ', 'Обмен с кухней', 'POS-обмен', ''],
          d.devices.map((v) => [
            val(v['name']),
            status(v['kind']),
            badge(v['status']),
            date(v['last_fulfillment_at']),
            date(v['last_pos_at']),
            d.role === 'manager' && v['status'] !== 'revoked'
              ? button(
                  'Отозвать доступ',
                  () =>
                    this.confirm(
                      'Отозвать доступ устройства',
                      String(v['name']) + '. Новые запросы этого устройства будут запрещены.',
                      { type: 'revoke_device', id: v['id'] },
                    ),
                  'button subtle',
                )
              : el('span'),
          ]),
        ),
      );
      content.append(p);
    }
    if (page === 'shifts')
      content.append(
        this.records(
          'shift',
          'Журнал смен',
          [
            [
              'Ответственный',
              (p) =>
                this.options('employee').find((v) => v.value === p['employee_id'])?.label ?? '-',
            ],
            ['Открыта', (p) => date(p['opened_at'])],
            ['Закрыта', (p) => date(p['closed_at'])],
          ],
          'Управленческая смена. Не заменяет фискальную смену кассы.',
        ),
        this.records(
          'employee',
          'Сотрудники',
          [
            ['Роль', (p) => status(p['role'])],
            ['Работает', (p) => (p['active'] ? 'Да' : 'Нет')],
          ],
          'Карточки для учёта. Доступ к кассе и кухне выдаётся отдельно.',
        ),
      );
    if (page === 'audit') {
      const rows = [...d.audit, ...d.catalog_audit].sort((a, b) =>
          String(b['created_at']).localeCompare(String(a['created_at'])),
        ),
        p = panel('История изменений', 'Последние 200 операций бэк-офиса и 100 операций каталога.');
      p.append(
        table(
          ['Время', 'Автор', 'Операция', 'Причина'],
          rows.map((v) => [
            date(v['created_at']),
            String(v['actor_id']).slice(0, 8),
            val(v['action']),
            val(v['reason']),
          ]),
        ),
      );
      content.append(p);
    }
  }
}
