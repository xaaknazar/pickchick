import { element as el, button, field, select, check, grid } from '../dom.js';
import {
  COVERAGE_LABELS,
  METHOD_LABELS,
  RULE_LABELS,
  SOURCE_LABELS,
  STATE_LABELS,
  STATUS_LABELS,
  ReconciliationModel,
  almatyTime,
  csvText,
  dayCsv,
  decodeStatement,
  draftFromMapping,
  mappingFromDraft,
  signedMinor,
  tenge,
  type MappingDraft,
  type RecRow,
  type RecSnapshot,
} from '../reconciliation-model.js';

/**
 * «Оплаты и чеки» -> «Ежедневная сверка оплат» (stage 2, lane rec). Rendered only when the
 * server has the section (BACKOFFICE_RECONCILIATION_ENABLED); otherwise the page is unchanged.
 * Analysts see everything read-only; the manager and the designated accountant may act.
 */
type Filter = 'open' | 'differences' | 'matched' | 'all';
const ROWS_SHOWN = 300;
/** Below the proxy's 300 KB JSON limit, leaving room for the mapping and the request envelope. */
const UPLOAD_MAX_BYTES = 280 * 1024;
const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : '-');
const time = (iso: string | null | undefined) => almatyTime(iso).slice(5, 16) || '-';
const ISSUES: Record<string, string> = {
  missing_column: 'Нет такой колонки в заголовке',
  date: 'Не распознана дата',
  amount: 'Не распознана сумма',
  empty_file: 'Пустой файл',
  too_many_rows: 'Слишком много строк',
  too_many_errors: 'Ошибок слишком много, показаны первые',
  unreadable: 'Пропущена: не распознана',
  zero: 'Пропущена: нулевая сумма',
};
const COLUMN_LABELS: Record<string, string> = {
  occurred_at: 'Дата',
  time: 'Время',
  amount: 'Сумма',
  fee: 'Комиссия',
  operation_id: 'Номер операции',
  reference: 'Ссылка/счёт',
  method: 'Способ',
  direction: 'Тип операции',
  description: 'Описание',
};
const ROLE_LABELS: Record<string, string> = {
  manager: 'управляющий',
  accountant: 'бухгалтер',
  analyst: 'просмотр',
};
function badge(text: string, tone: '' | 'good' | 'bad' = '') {
  return el('span', 'op-badge' + (tone ? ' ' + tone : ''), text);
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
function note(text: string) {
  return el('p', 'op-note', text);
}
function notice(text: string, tone: 'error' | 'good' | '', testId: string) {
  const n = el('div', 'notice' + (tone === 'error' ? ' error' : ''), text);
  n.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  n.dataset.testid = testId;
  return n;
}
/** First part as the value, the rest as secondary lines (`td small` is a block in styles.css). */
function lines(...parts: (string | null | undefined)[]) {
  const n = el('div');
  parts
    .filter((p): p is string => !!p)
    .forEach((p, i) => n.append(i ? el('small', 'muted', p) : el('span', '', p)));
  if (!n.childNodes.length) n.append('-');
  return n;
}
function table(headers: string[], rows: (string | Node)[][], empty: string, testId?: string) {
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
  if (testId) wrap.dataset.testid = testId;
  return wrap;
}
function dialog(title: string, sub: string) {
  const d = el('dialog', 'op-dialog'),
    head = el('div', 'panel-head');
  head.append(
    el('h2', '', title),
    button(
      'Закрыть',
      () => {
        d.close();
        d.remove();
      },
      'button subtle',
    ),
  );
  d.append(head, note(sub));
  document.body.append(d);
  d.showModal();
  d.addEventListener('close', () => d.remove(), { once: true });
  return d;
}
const methodOptions = (source?: string) =>
  Object.entries(METHOD_LABELS)
    .filter(([, m]) => !source || m.source === source)
    .map(([value, m]) => ({ value, label: m.label }));

export class ReconciliationView {
  private filter: Filter = 'open';
  private draft: MappingDraft = draftFromMapping(null);
  private profileId = '';
  private profileName = '';
  private file: { name: string; content: string; bytes: ArrayBuffer } | null = null;
  private total = { method: 'cash', source: 'kkm', amount: '', comment: '' };
  private localError = '';
  constructor(readonly model: ReconciliationModel) {}
  /** Follow the cabinet's signed-in actor and branch. */
  sync(actor: string, branch: string) {
    if (actor && branch && (this.model.actor !== actor || this.model.branch !== branch)) {
      this.file = null;
      this.localError = '';
      void this.model.scope(actor, branch);
    }
  }
  render(target: HTMLElement) {
    const m = this.model,
      d = m.data;
    if (m.unavailable) return;
    const root = el('div', 'reconciliation');
    root.dataset.testid = 'reconciliation';
    const day = el('input');
    day.type = 'date';
    day.value = m.day;
    day.max = m.today;
    day.setAttribute('aria-label', 'День сверки');
    day.dataset.testid = 'rec-day';
    day.addEventListener('change', () => void m.setDay(day.value));
    const exportButton = button(
      'Выгрузить CSV',
      () => d && this.download(d),
      'button',
      'rec-export',
    );
    exportButton.disabled = !d;
    const head = panel(
      'Ежедневная сверка оплат',
      'День по времени Алматы. Оплаты и возвраты PickChick сравниваются с выпиской банка или итогом, введённым вручную. У каждой суммы должно быть объяснение.',
      [day, button('Обновить', () => void m.load(), 'button subtle', 'rec-refresh'), exportButton],
    );
    root.append(head);
    if (m.pending) {
      const n = notice(
        'Последнее действие ещё не подтверждено сервером. Проверьте результат - запрос будет повторён с тем же номером и не выполнится дважды.',
        '',
        'rec-pending',
      );
      const retry = button('Проверить результат', () => void m.recover(), 'button primary');
      retry.disabled = m.busy;
      n.append(retry);
      root.append(n);
    }
    if (m.error || this.localError)
      root.append(notice(this.localError || m.error, 'error', 'rec-error'));
    if (m.notice) root.append(notice(m.notice, 'good', 'rec-notice'));
    if (!d) {
      if (m.busy) root.append(note('Загружаем сверку…'));
      target.append(root);
      return;
    }
    root.append(
      this.status(d),
      this.methods(d),
      this.rows(d),
      this.imports(d),
      this.totals(d),
      this.history(d),
    );
    target.append(root);
  }
  private download(d: RecSnapshot) {
    const url = URL.createObjectURL(
      new Blob([csvText(dayCsv(d))], { type: 'text/csv;charset=utf-8' }),
    );
    const link = el('a');
    link.href = url;
    link.download = `pickchick-reconciliation-${d.day}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private status(d: RecSnapshot) {
    const m = this.model,
      box = el('section', 'panel op-panel');
    box.dataset.testid = 'rec-status';
    const badges = el('div', 'channel-badges');
    badges.append(
      d.state === 'closed'
        ? badge(
            `День закрыт ${almatyTime(d.closed?.at).slice(5, 16)}, ${d.closed?.by ?? ''}`,
            'good',
          )
        : badge(d.day_finished ? 'День открыт' : 'День ещё идёт'),
      d.report.open_items
        ? badge(`Нерешённых расхождений: ${d.report.open_items}`, 'bad')
        : badge('Нерешённых расхождений нет', 'good'),
      badge('Ваша роль: ' + (ROLE_LABELS[d.role] ?? d.role)),
    );
    box.append(badges);
    if (d.drift)
      box.append(
        notice(
          `После закрытия появились новые данные (нерешённых сейчас: ${d.live_open_items}). Закрытый день не меняется: откройте его заново с причиной, чтобы учесть их.`,
          'error',
          'rec-drift',
        ),
      );
    const sum = (v: (string | null)[]) =>
      String(v.reduce((a, x) => a + (x && /^-?\d+$/.test(x) ? BigInt(x) : 0n), 0n));
    const stats = el('div', 'stats');
    for (const [label, value, detail] of [
      [
        'Ожидается по PickChick',
        tenge(sum(d.report.methods.map((x) => x.expected_minor))),
        'Оплаты минус возвраты',
      ],
      [
        'По выписке банка',
        tenge(
          sum(d.report.methods.filter((x) => x.coverage === 'statement').map((x) => x.bank_minor)),
        ),
        'Без повторов строк',
      ],
      [
        'Подарки без оплаты',
        tenge(d.report.gifts.discount_minor),
        `Заказов: ${d.report.gifts.orders}`,
      ],
      ['Нерешённых расхождений', String(d.report.open_items), ''],
    ] as [string, string, string][]) {
      const c = el('div', 'stat');
      c.append(el('span', 'muted', label), el('strong', '', value));
      if (detail) c.append(el('small', 'muted', detail));
      stats.append(c);
    }
    box.append(stats);
    if (!m.writable) {
      if (d.role === 'analyst')
        box.append(note('Только просмотр. Решения и закрытие дня - у управляющего и бухгалтера.'));
      return box;
    }
    const actions = el('div', 'channel-badges');
    if (d.state === 'open') {
      const close = button(
        'Закрыть день',
        () =>
          void m.send({ type: 'close', day: d.day, expected_revision: d.revision }, 'День сверен'),
        'button primary',
        'rec-close',
      );
      close.disabled = !d.day_finished || d.report.open_items > 0;
      actions.append(close);
      if (!d.day_finished)
        actions.append(note('Закрыть можно после окончания дня по времени Алматы.'));
      else if (d.report.open_items)
        actions.append(note('Сначала решите или примите с причиной все расхождения.'));
    } else
      actions.append(
        button(
          'Открыть заново',
          () =>
            this.reasonDialog(
              'Открыть день заново',
              'Закрытый день не меняется. Откройте его, чтобы учесть новые данные; причина попадёт в журнал.',
              (reason) =>
                m.send({ type: 'reopen', day: d.day, expected_revision: d.revision }, reason),
            ),
          'button',
          'rec-reopen',
        ),
      );
    box.append(actions);
    return box;
  }
  private methods(d: RecSnapshot) {
    const p = panel(
      'По способам оплаты',
      'Ожидается = оплаты минус возвраты за день в PickChick. Разница = банк (или итог вручную) минус ожидаемое.',
    );
    p.append(
      table(
        [
          'Способ оплаты',
          'Заказов',
          'Оплаты',
          'Возвраты',
          'Подарки',
          'Ожидается',
          'Банк / итог',
          'Разница',
          'Данные банка',
        ],
        d.report.methods.map((x) => {
          const external =
            x.coverage === 'statement'
              ? tenge(x.bank_minor) + (x.bank_count ? ` (${x.bank_count})` : '')
              : x.totals.length
                ? x.totals
                    .map((t) => `${t.source === 'bank' ? 'Банк' : 'ККМ'}: ${tenge(t.amount_minor)}`)
                    .join(', ')
                : '-';
          const diff = x.difference_minor;
          return [
            lines(
              x.label,
              x.unknown_attempts ? `Неизвестный результат оплаты: ${x.unknown_attempts}` : null,
            ),
            String(x.orders_paid),
            tenge(x.captures_minor),
            tenge(x.refunds_minor),
            tenge(x.gifts_minor),
            x.recorded ? tenge(x.expected_minor) : '-',
            external,
            diff === null ? '-' : badge(tenge(diff), diff === '0' ? 'good' : 'bad'),
            COVERAGE_LABELS[x.coverage] ?? x.coverage,
          ];
        }),
        'Оплат за день нет',
        'rec-methods',
      ),
      note(
        'Наличные и Kaspi Smart POS на кассе PickChick пока не учитывает: касса передаёт заказы без оплаты. Для них введите итог ККМ или банка вручную. Чики в оплате заказов пока не используются.',
      ),
    );
    if (d.tiptoppay_test?.payments)
      p.append(
        note(
          `Тестовые платежи TipTopPay (песочница, денег нет): ${d.tiptoppay_test.payments} на ${tenge(d.tiptoppay_test.amount_minor)}. В сверке не участвуют.`,
        ),
      );
    return p;
  }
  private rows(d: RecSnapshot) {
    const m = this.model;
    const filter = select(
      'Показать',
      this.filter,
      [
        { value: 'open', label: 'Нерешённые расхождения' },
        { value: 'differences', label: 'Все расхождения' },
        { value: 'matched', label: 'Совпавшие операции' },
        { value: 'all', label: 'Все строки' },
      ],
      (v) => {
        this.filter = v as Filter;
        m.refresh();
      },
      'rec-filter',
    );
    const shown = d.report.rows.filter((r) =>
      this.filter === 'open'
        ? r.blocking
        : this.filter === 'differences'
          ? r.state !== 'matched'
          : this.filter === 'matched'
            ? r.state === 'matched'
            : true,
    );
    const actions: HTMLElement[] = [filter];
    const editable = m.writable && d.state === 'open';
    if (editable && this.filter === 'open' && shown.length)
      actions.push(
        button(
          'Принять показанные с причиной',
          () =>
            this.reasonDialog(
              'Принять расхождения',
              `Будет принято расхождений: ${Math.min(shown.length, 500)}. Причина сохранится у каждого из них.`,
              (reason) =>
                m.send(
                  {
                    type: 'accept',
                    day: d.day,
                    comment: reason,
                    items: shown
                      .slice(0, 500)
                      .map((r) => ({ key: r.key, state: r.state, amount_minor: r.amount_minor })),
                  },
                  'Расхождения приняты',
                ),
            ),
          'button',
          'rec-accept-all',
        ),
      );
    const p = panel(
      'Расхождения и операции',
      'Каждое расхождение получает ответственного, статус и комментарий. День закрывается, когда все расхождения решены или приняты с причиной.',
      actions,
    );
    p.append(
      table(
        ['Состояние', 'Способ', 'PickChick', 'Банк', 'Разница', 'Пояснение', 'Решение', ''],
        shown
          .slice(0, ROWS_SHOWN)
          .map((r) => [
            lines(STATE_LABELS[r.state] ?? r.state, RULE_LABELS[r.rule] ?? r.rule),
            METHOD_LABELS[r.method]?.label ?? r.method,
            r.pickchick
              ? lines(
                  tenge(r.pickchick_minor),
                  time(r.pickchick.occurred_at),
                  'Заказ ' + short(r.pickchick.order_id),
                  r.pickchick.operation_id,
                )
              : r.pickchick_minor !== null
                ? lines(tenge(r.pickchick_minor), r.order_id ? 'Заказ ' + short(r.order_id) : null)
                : '-',
            r.bank
              ? lines(
                  tenge(r.bank_minor),
                  time(r.bank.occurred_at),
                  r.bank.operation_id ?? r.bank.reference,
                  'Строка ' + r.bank.row_number,
                )
              : r.total
                ? lines(
                    tenge(r.bank_minor),
                    (r.total.source === 'bank' ? 'Итог банка' : 'Итог ККМ') + ', ' + r.total.author,
                  )
                : '-',
            r.state === 'matched' && r.amount_minor === '0'
              ? '0'
              : badge(tenge(r.amount_minor), r.blocking ? 'bad' : ''),
            lines(r.explanation, r.total?.comment, r.bank?.description),
            this.decision(r),
            editable && r.state !== 'matched'
              ? button('Решение', () => this.decide(d, r), 'button subtle', 'rec-decide')
              : '',
          ]),
        this.filter === 'open' ? 'Нерешённых расхождений нет' : 'Строк нет',
        'rec-rows',
      ),
    );
    if (shown.length > ROWS_SHOWN)
      p.append(
        note(`Показаны первые ${ROWS_SHOWN} строк из ${shown.length}. Полный список - в CSV.`),
      );
    return p;
  }
  private decision(r: RecRow) {
    if (r.state === 'matched') return '-';
    const res = r.resolution;
    if (!res)
      return lines(
        'Не решено',
        r.stale_resolution
          ? `Прежнее решение устарело: ${STATUS_LABELS[r.stale_resolution.status]}`
          : 'Ответственный не назначен',
      );
    return lines(
      STATUS_LABELS[res.status] ?? res.status,
      res.assignee_name ? 'Ответственный: ' + res.assignee_name : 'Ответственный не назначен',
      res.comment,
    );
  }
  private decide(d: RecSnapshot, r: RecRow) {
    const m = this.model,
      res = r.resolution;
    const state = {
      status: res?.status ?? 'in_progress',
      assignee: res?.assignee_id ?? r.stale_resolution?.assignee_id ?? d.actor_id,
      comment: res?.comment ?? '',
    };
    const box = dialog(
      'Решение по расхождению',
      `${STATE_LABELS[r.state]}: ${tenge(r.amount_minor)}. ${r.explanation}`,
    );
    const error = el('p', 'op-note');
    const save = button(
      'Сохранить',
      () => {
        if (['resolved', 'accepted'].includes(state.status) && state.comment.trim().length < 3) {
          error.textContent = 'Для «Решено» и «Принято» напишите пояснение (от 3 символов).';
          return;
        }
        save.disabled = true;
        void m
          .send(
            {
              type: 'item',
              day: d.day,
              key: r.key,
              state: r.state,
              amount_minor: r.amount_minor,
              status: state.status,
              assignee_id: state.assignee || null,
              comment: state.comment.trim(),
              expected_revision: r.item_revision,
            },
            'Решение по расхождению',
          )
          .then(() => {
            box.close();
            box.remove();
          });
      },
      'button primary',
      'rec-decision-save',
    );
    box.append(
      grid(
        select(
          'Ответственный',
          state.assignee,
          [
            { value: '', label: 'Не назначен' },
            ...d.assignees.map((a) => ({
              value: a.id,
              label: `${a.name} (${ROLE_LABELS[a.role] ?? a.role})`,
            })),
          ],
          (v) => (state.assignee = v),
          'rec-assignee',
        ),
        select(
          'Статус',
          state.status,
          Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
          (v) => (state.status = v as typeof state.status),
          'rec-status-select',
        ),
      ),
      field('Комментарий', state.comment, (v) => (state.comment = v), {
        id: 'rec-comment',
        multiline: true,
        max: 1000,
        hint: 'Что произошло и что сделано. Для «Принято» - причина, почему разница допустима.',
      }),
      error,
      save,
    );
  }
  private reasonDialog(title: string, sub: string, run: (reason: string) => Promise<boolean>) {
    const box = dialog(title, sub);
    let reason = '';
    const error = el('p', 'op-note');
    const ok = button(
      'Подтвердить',
      () => {
        if (reason.trim().length < 3) {
          error.textContent = 'Укажите причину (от 3 символов).';
          return;
        }
        ok.disabled = true;
        void run(reason.trim()).then(() => {
          box.close();
          box.remove();
        });
      },
      'button primary',
      'rec-reason-confirm',
    );
    box.append(
      field('Причина', '', (v) => (reason = v), { id: 'rec-reason', multiline: true, max: 500 }),
      error,
      ok,
    );
  }
  private imports(d: RecSnapshot) {
    const m = this.model;
    const p = panel(
      'Выписки банка',
      'Формат выписки Kaspi Pay не подтверждён: колонки задаются профилем. Перед загрузкой файл проверяется; повторная загрузка того же файла не принимается, уже загруженные операции пропускаются.',
    );
    p.dataset.testid = 'rec-imports';
    p.append(
      table(
        ['Файл', 'Источник', 'Строк', 'Дни', 'Загружен', 'Статус', ''],
        d.imports.map((i) => [
          i.file_name,
          SOURCE_LABELS[i.source] ?? i.source,
          lines(
            String(i.line_count),
            i.duplicate_count ? `уже были: ${i.duplicate_count}` : null,
            i.skipped_count ? `пропущено: ${i.skipped_count}` : null,
          ),
          (i.days ?? []).map((x) => x.slice(8, 10) + '.' + x.slice(5, 7)).join(', ') || '-',
          lines(time(i.created_at), i.author),
          i.void_reason ? lines('Отменена', i.void_reason) : 'Учитывается',
          m.writable && !i.void_reason
            ? button(
                'Отменить',
                () =>
                  this.reasonDialog(
                    'Отменить загрузку',
                    `Строки файла «${i.file_name}» перестанут участвовать в сверке. Запись о загрузке останется.`,
                    (reason) => m.send({ type: 'void_import', id: i.id }, reason),
                  ),
                'button subtle',
              )
            : '',
        ]),
        'Выписки за этот день не загружены',
      ),
    );
    if (m.writable) p.append(this.importForm(d));
    return p;
  }
  private importForm(d: RecSnapshot) {
    const m = this.model,
      box = el('div', 'rec-import');
    const profiles = d.profiles.filter((x) => !x.archived);
    box.append(
      grid(
        select(
          'Профиль выписки',
          this.profileId,
          [
            { value: '', label: 'Новый профиль' },
            ...profiles.map((x) => ({ value: x.id, label: x.name })),
          ],
          (v) => {
            this.profileId = v;
            const profile = profiles.find((x) => x.id === v);
            this.draft = draftFromMapping(profile?.mapping ?? null);
            this.profileName = profile?.name ?? '';
            m.preview = null;
            m.refresh();
          },
          'rec-profile',
        ),
        this.fileInput(d),
      ),
    );
    const settings = el('details', 'rec-mapping');
    settings.open = !this.profileId;
    settings.append(el('summary', '', 'Колонки и формат файла'), this.mappingForm());
    box.append(settings);
    const mapping = () => {
      try {
        this.localError = '';
        return mappingFromDraft(this.draft);
      } catch (e) {
        this.localError = e instanceof Error ? e.message : 'Проверьте профиль.';
        m.refresh();
        return null;
      }
    };
    const saveProfile = button(
      'Сохранить профиль',
      () => {
        const value = mapping();
        if (!value) return;
        if (!this.profileName.trim()) {
          this.localError = 'Укажите название профиля.';
          m.refresh();
          return;
        }
        const current = profiles.find((x) => x.id === this.profileId);
        const id = current?.id ?? crypto.randomUUID();
        void m
          .send(
            {
              type: 'profile',
              id,
              expected_revision: current?.revision ?? 0,
              name: this.profileName.trim(),
              mapping: value,
              archived: false,
            },
            'Профиль выписки',
          )
          .then((ok) => {
            if (ok) this.profileId = id;
          });
      },
      'button',
      'rec-profile-save',
    );
    const checkFile = button(
      'Проверить файл',
      () => {
        const value = mapping();
        if (!value || !this.file) return;
        void m.check(value, this.file.content);
      },
      'button',
      'rec-check',
    );
    checkFile.disabled = !this.file || m.busy;
    const preview = m.preview;
    const load = button(
      'Загрузить',
      () => {
        const value = mapping();
        if (!value || !this.file) return;
        const name = this.file.name;
        void m
          .send(
            {
              type: 'import',
              id: crypto.randomUUID(),
              profile_id: this.profileId || null,
              mapping: value,
              file_name: name,
              content: this.file.content,
            },
            'Загрузка выписки ' + name.slice(0, 200),
          )
          .then((ok) => {
            if (ok) this.file = null;
          });
      },
      'button primary',
      'rec-import',
    );
    load.disabled =
      !preview ||
      !preview.valid ||
      !!preview.duplicate_import ||
      preview.days.some((x) => x.closed) ||
      !this.file ||
      m.busy;
    box.append(
      field('Название профиля', this.profileName, (v) => (this.profileName = v), {
        id: 'rec-profile-name',
        max: 100,
      }),
    );
    const buttons = el('div', 'channel-badges');
    buttons.append(saveProfile, checkFile, load);
    box.append(buttons);
    if (preview) box.append(this.previewView(preview));
    return box;
  }
  private fileInput(d: RecSnapshot) {
    const m = this.model,
      wrap = el('label', 'field'),
      input = el('input');
    wrap.append(el('span', 'field-label', 'Файл выписки (CSV)'));
    input.type = 'file';
    input.accept = '.csv,text/csv,text/plain';
    input.dataset.testid = 'rec-file';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) return;
      void f.arrayBuffer().then((bytes) => {
        const content = decodeStatement(bytes, this.draft.encoding);
        // The private proxy accepts JSON bodies up to 300 KB; Cyrillic text takes 2 bytes a letter.
        const size = new Blob([JSON.stringify(content)]).size;
        if (content.length > d.limits.statement_max_chars || size > UPLOAD_MAX_BYTES) {
          this.localError =
            'Файл слишком большой для одной загрузки: разделите выписку на части (например, по дням).';
          this.file = null;
        } else {
          this.localError = '';
          this.file = { name: f.name.slice(0, 200), content, bytes };
        }
        m.preview = null;
        m.refresh();
      });
    });
    wrap.append(input);
    if (this.file) wrap.append(el('small', 'muted', 'Выбран: ' + this.file.name));
    return wrap;
  }
  private mappingForm() {
    const d = this.draft,
      m = this.model;
    const text = (key: keyof MappingDraft, label: string, hint?: string) =>
      field(label, String(d[key]), (v) => ((d as Record<string, unknown>)[key] = v), {
        id: 'rec-map-' + key,
        max: 100,
        ...(hint ? { hint } : {}),
      });
    const choose = (
      key: keyof MappingDraft,
      label: string,
      items: { value: string; label: string }[],
      rerender = false,
    ) =>
      select(
        label,
        String(d[key]),
        items,
        (v) => {
          (d as Record<string, unknown>)[key] = v;
          if (key === 'encoding' && this.file)
            this.file = { ...this.file, content: decodeStatement(this.file.bytes, d.encoding) };
          if (rerender) m.refresh();
        },
        'rec-map-' + key,
      );
    const form = el('div', 'rec-mapping-form');
    form.append(
      grid(
        choose(
          'source',
          'Источник выписки',
          Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label })),
          true,
        ),
        choose('default_method', 'Способ по умолчанию', [
          { value: '', label: 'Не определён' },
          ...methodOptions(d.source),
        ]),
        choose('encoding', 'Кодировка файла', [
          { value: 'utf-8', label: 'UTF-8' },
          { value: 'windows-1251', label: 'Windows-1251 (Excel)' },
        ]),
        choose('delimiter', 'Разделитель', [
          { value: ';', label: 'Точка с запятой' },
          { value: ',', label: 'Запятая' },
          { value: '\t', label: 'Табуляция' },
        ]),
        check('Первая строка - заголовок', d.has_header, (v) => (d.has_header = v)),
        text('skip_rows', 'Строк до заголовка'),
        text('occurred_at', 'Колонка даты (или даты и времени)'),
        text('time', 'Колонка времени, если отдельно'),
        text('amount', 'Колонка суммы'),
        text('fee', 'Колонка комиссии'),
        text('operation_id', 'Колонка номера операции'),
        text('reference', 'Колонка номера счёта / ссылки'),
        text('method', 'Колонка способа оплаты'),
        text('direction', 'Колонка типа операции'),
        text('description', 'Колонка описания', 'Номера телефонов в описании скрываются.'),
        choose('date_format', 'Формат даты', [
          { value: 'dmy', label: 'ДД.ММ.ГГГГ ЧЧ:ММ' },
          { value: 'ymd', label: 'ГГГГ-ММ-ДД ЧЧ:ММ' },
          { value: 'iso', label: 'ISO 8601' },
        ]),
        choose('decimal_separator', 'Десятичный разделитель', [
          { value: ',', label: 'Запятая: 1 500,00' },
          { value: '.', label: 'Точка: 1500.00' },
        ]),
        choose('amount_unit', 'Суммы указаны в', [
          { value: 'major', label: 'тенге' },
          { value: 'minor', label: 'тиынах' },
        ]),
        text(
          'refund_values',
          'Значения типа «возврат»',
          'Через запятую, например: Возврат, Refund',
        ),
        field('Значения способа оплаты', d.method_values, (v) => (d.method_values = v), {
          id: 'rec-map-method_values',
          multiline: true,
          max: 2000,
          hint:
            'По одному на строку: значение=способ. Способы: ' +
            methodOptions(d.source)
              .map((x) => x.value)
              .join(', '),
        }),
        check(
          'Пропускать нераспознанные строки (например «Итого»)',
          d.skip_invalid_rows,
          (v) => (d.skip_invalid_rows = v),
        ),
        text('window_minutes', 'Окно сопоставления по сумме и времени, минут'),
      ),
    );
    return form;
  }
  private previewView(p: NonNullable<ReconciliationModel['preview']>) {
    const box = el('div', 'rec-preview');
    box.dataset.testid = 'rec-preview';
    box.append(
      note(
        `Строк в файле: ${p.rows}. К загрузке: ${p.lines - p.already_imported}. Уже загружены раньше: ${p.already_imported}. Пропущено: ${p.skipped.length}. Ошибок: ${p.errors.length}.`,
      ),
    );
    if (p.duplicate_import)
      box.append(
        notice('Этот файл уже загружен. Сначала отмените прежнюю загрузку.', 'error', 'rec-dup'),
      );
    if (p.days.some((x) => x.closed))
      box.append(
        notice(
          'В файле есть строки закрытых дней. Откройте эти дни заново или уберите строки из файла.',
          'error',
          'rec-closed-days',
        ),
      );
    box.append(
      table(
        ['День', 'Строк', 'Сумма', 'День закрыт'],
        p.days.map((x) => [x.day, String(x.lines), tenge(x.amount_minor), x.closed ? 'да' : 'нет']),
        'Строк с операциями нет',
      ),
    );
    if (p.errors.length || p.skipped.length)
      box.append(
        table(
          ['Строка', 'Колонка', 'Проблема'],
          [...p.errors, ...p.skipped].map((x) => [
            x.row ? String(x.row) : '-',
            COLUMN_LABELS[x.column] ?? x.column ?? '-',
            ISSUES[x.code] ?? x.code,
          ]),
          '',
        ),
      );
    box.append(
      table(
        ['Строка', 'Время', 'Сумма', 'Операция', 'Способ', 'Описание'],
        p.sample
          .slice(0, 10)
          .map((x) => [
            String(x.row_number),
            time(x.occurred_at),
            tenge(x.amount_minor),
            x.operation_id ?? x.reference ?? '-',
            x.method ? (METHOD_LABELS[x.method]?.label ?? x.method) : 'Не определён',
            x.description || '-',
          ]),
        'Нет строк',
      ),
    );
    return box;
  }
  private totals(d: RecSnapshot) {
    const m = this.model,
      p = panel(
        'Итоги вручную',
        'Итог банка или ККМ за день по способу оплаты, с обязательным комментарием. Исправление отменяет прежний итог и сохраняет историю.',
      );
    p.dataset.testid = 'rec-totals';
    p.append(
      table(
        ['Способ', 'Источник', 'Сумма', 'Комментарий', 'Кто', 'Статус', ''],
        d.totals.map((t) => [
          METHOD_LABELS[t.method]?.label ?? t.method,
          t.source === 'bank' ? 'Банк' : 'ККМ',
          tenge(t.amount_minor),
          t.comment,
          lines(t.author, time(t.created_at)),
          t.void_reason ? lines('Отменён', t.void_reason) : 'Учитывается',
          m.writable && d.state === 'open' && !t.void_reason
            ? button(
                'Отменить',
                () =>
                  this.reasonDialog('Отменить итог', 'Итог перестанет участвовать в сверке.', (r) =>
                    m.send({ type: 'void_total', id: t.id }, r),
                  ),
                'button subtle',
              )
            : '',
        ]),
        'Итогов вручную нет',
      ),
    );
    if (!m.writable || d.state !== 'open') return p;
    const form = this.total;
    const active = () =>
      d.totals.find((t) => !t.void_reason && t.method === form.method && t.source === form.source);
    const save = button(
      'Сохранить итог',
      () => {
        let amount: string;
        try {
          amount = signedMinor(form.amount);
        } catch (e) {
          this.localError = (e as Error).message;
          m.refresh();
          return;
        }
        if (form.comment.trim().length < 3) {
          this.localError = 'Комментарий к итогу обязателен (от 3 символов).';
          m.refresh();
          return;
        }
        this.localError = '';
        const replaced = active();
        void m
          .send(
            {
              type: 'total',
              id: crypto.randomUUID(),
              day: d.day,
              method: form.method,
              source: form.source,
              amount_minor: amount,
              comment: form.comment.trim(),
              replaces: replaced?.id ?? null,
            },
            replaced ? 'Исправление итога' : 'Итог за день',
          )
          .then((ok) => {
            if (ok) this.total = { ...form, amount: '', comment: '' };
          });
      },
      'button primary',
      'rec-total-save',
    );
    p.append(
      grid(
        select(
          'Способ оплаты',
          form.method,
          methodOptions(),
          (v) => (form.method = v),
          'rec-total-method',
        ),
        select(
          'Источник',
          form.source,
          [
            { value: 'kkm', label: 'ККМ (Z-отчёт)' },
            { value: 'bank', label: 'Банк' },
          ],
          (v) => (form.source = v),
          'rec-total-source',
        ),
        field('Сумма, ₸', form.amount, (v) => (form.amount = v), {
          id: 'rec-total-amount',
          max: 20,
          hint: 'Минус - если за день вернули больше, чем получили.',
        }),
        field('Комментарий', form.comment, (v) => (form.comment = v), {
          id: 'rec-total-comment',
          max: 500,
        }),
      ),
      save,
    );
    return p;
  }
  private history(d: RecSnapshot) {
    const p = panel('Журнал дня', 'Закрытия и повторные открытия с причинами.');
    p.append(
      table(
        ['Событие', 'Когда', 'Кто', 'Причина'],
        d.history.map((h) => [
          h.kind === 'close' ? 'Закрыт' : 'Открыт заново',
          time(h.created_at),
          h.author,
          h.reason,
        ]),
        'День ещё не закрывали',
      ),
    );
    return p;
  }
}
