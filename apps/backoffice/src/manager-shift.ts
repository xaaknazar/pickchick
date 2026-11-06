import { element as el, button, field, select, check } from './dom.js';
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
  ANSWER_LABELS,
  CHECK_LABELS,
  HANDOVER_MAX,
  answerProblems,
  checkText,
  closeCommand,
  draftCommand,
  needsComment,
  newItemCode,
  openCommand,
  problemText,
  remarks,
  shiftChecklist,
  shiftTitle,
  templateCommand,
  type Answer,
  type AnswerStatus,
  type ChecklistItem,
  type ManagerShift,
  type ManagerShiftsView,
  type StoredAnswer,
} from './manager-shift-model.js';

type Data = Record<string, unknown>;
/**
 * What the «Смены» page hands to «Смена менеджера» (lane bo-ui step 6). `execute` sends one
 * command with its reason and answers null on success or the error in words.
 */
export type ManagerShiftCallbacks = {
  load: (date: string) => Promise<ManagerShiftsView>;
  execute: (command: Data, reason: string) => Promise<string | null>;
  can: (permission: string) => boolean;
  rights: (permission: string) => string | null;
  employees: () => { value: string; label: string }[];
  /** «Списать»: open «Остатки» (the opening dialog keeps its draft). */
  toStock: () => void;
  /** actor:branch, the key of the drafts of this person and branch. */
  scope: () => string;
  changed: () => void;
};
const DRAFT = 'pickchick.backoffice.manager-shift.v1';
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date());
const dayText = (v: string) => {
  const [y, m, d] = v.split('-');
  return `${d}.${m}.${y}`;
};

function shiftDialog(title: string, sub: string, testId: string) {
  const d = el('dialog', 'op-dialog ms-dialog'),
    head = el('div', 'panel-head'),
    close = button(
      'Закрыть',
      () => {
        if (!mayClose(d)) return;
        d.close();
        d.remove();
      },
      'button subtle',
    );
  d.dataset.testid = testId;
  head.append(el('h2', '', title), close);
  d.append(head, el('p', 'op-note', sub));
  document.body.append(d);
  d.showModal();
  d.addEventListener('close', () => d.remove(), { once: true });
  return d;
}

/**
 * «Смена менеджера» (design-backoffice 5 «Смены»): the open shift with its automatic checks,
 * «Открыть смену» with the opening checklist, the «Закрыть смену» wizard (checklist, then the
 * handover), the shifts of a day and the checklist template of the manager. Loads its own view.
 */
export class ManagerShiftView {
  private view: ManagerShiftsView | null = null;
  private error = '';
  private loading = false;
  private date = today();
  private loadedFor = '';
  constructor(private cb: ManagerShiftCallbacks) {}
  clear() {
    this.view = null;
    this.error = '';
    this.loadedFor = '';
    this.date = today();
  }
  async reload() {
    this.loading = true;
    this.cb.changed();
    try {
      this.view = await this.cb.load(this.date);
      this.error = '';
    } catch {
      this.error = 'Смена менеджера не загрузилась. Проверьте связь и нажмите «Обновить».';
    } finally {
      this.loading = false;
      this.cb.changed();
    }
  }
  render(host: HTMLElement) {
    const scope = this.cb.scope() + ':' + this.date;
    if (this.loadedFor !== scope && !this.loading) {
      this.loadedFor = scope;
      void this.reload();
    }
    const p = el('section', 'panel manager-shift');
    p.dataset.testid = 'manager-shift';
    const head = el('div', 'panel-head');
    head.append(el('h2', '', 'Смена менеджера'));
    const tools = el('div', 'op-actions');
    tools.append(button('Обновить', () => void this.reload(), 'button subtle', 'ms-refresh'));
    if (this.view?.template && this.cb.can('manager_shifts.template'))
      tools.append(button('Чек-лист', () => this.templateDialog(), 'button subtle', 'ms-template'));
    head.append(tools);
    p.append(head);
    host.append(p);
    if (this.error) {
      const e = el('p', 'notice error', this.error);
      e.setAttribute('role', 'alert');
      p.append(e);
    }
    const v = this.view;
    if (!v) {
      p.append(el('p', 'op-note', this.loading ? 'Загружаем смену менеджера...' : ''));
      return;
    }
    const write = this.cb.can('manager_shifts.write');
    const why = write ? null : this.cb.rights('manager_shifts.write');
    if (v.open) this.openCard(p, v, v.open, write, why);
    else {
      const box = el('div', 'ms-card');
      box.dataset.testid = 'ms-closed';
      box.append(el('p', 'ms-title', 'Смена не открыта'));
      const b = button('Открыть смену', () => this.openDialog(v), 'button primary', 'ms-open');
      b.disabled = !write;
      if (why) b.title = why;
      box.append(b);
      if (why) box.append(el('p', 'op-note', why));
      p.append(box);
    }
    this.history(p, v);
  }
  private checkLine(auto: string | null, v: ManagerShiftsView) {
    if (!auto) return null;
    const c = v.checks[auto];
    const line = el('p', 'ms-check ms-check-' + (c?.status ?? 'no_data'));
    line.dataset.testid = 'ms-check-' + auto;
    line.append(el('strong', '', CHECK_LABELS[c?.status ?? 'no_data'] + ': '), checkText(auto, c));
    return line;
  }
  private openCard(
    p: HTMLElement,
    v: ManagerShiftsView,
    shift: ManagerShift,
    write: boolean,
    why: string | null,
  ) {
    const box = el('div', 'ms-card ms-open');
    box.dataset.testid = 'ms-open-card';
    box.append(
      el('p', 'ms-title', shiftTitle(shift)),
      el(
        'p',
        'op-note',
        `Открыта ${almatyDateTime(shift.opened_at)}${shift.opened_by_name ? ', открыл(а) ' + shift.opened_by_name : ''}. День смены: ${dayText(shift.business_date)}.` +
          (shift.business_date !== today()
            ? ' Смена закрывается после полуночи и относится ко дню открытия.'
            : ''),
      ),
    );
    const list = shiftChecklist(v);
    const checks = el('div', 'ms-checks');
    checks.append(el('h3', '', 'Авто-проверки к закрытию'));
    for (const item of list.closing) {
      const line = this.checkLine(item.auto, v);
      if (line) checks.append(line);
    }
    box.append(checks);
    const notes = remarks(shift.opening.items);
    if (notes.length) {
      box.append(el('h3', '', 'Замечания открытия'));
      for (const a of notes)
        box.append(
          el(
            'p',
            'op-note',
            `${a.label}: ${ANSWER_LABELS[a.status]}${a.comment ? ' - ' + a.comment : ''}`,
          ),
        );
    }
    if (shift.closing?.draft) box.append(el('p', 'op-note', 'Есть сохранённый черновик закрытия.'));
    const close = button(
      'Закрыть смену',
      () => this.closeDialog(v, shift),
      'button primary',
      'ms-close',
    );
    close.disabled = !write;
    if (why) close.title = why;
    box.append(close);
    if (why) box.append(el('p', 'op-note', why));
    p.append(box);
  }
  private history(p: HTMLElement, v: ManagerShiftsView) {
    const bar = el('div', 'inventory-filters ms-history-bar');
    bar.append(
      field(
        'Смены за день',
        this.date,
        (value) => {
          if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            this.date = value;
            this.cb.changed();
          }
        },
        { id: 'ms-date', type: 'date' },
      ),
    );
    p.append(el('h3', '', `Смены за ${dayText(v.date)}`), bar);
    const head = ['Менеджер', 'Открыта', 'Закрыта', 'Замечания', 'Передача смены', ''];
    const rows = v.shifts.map((s) => {
      const notes = [...remarks(s.opening.items), ...remarks(s.closing?.items)];
      return [
        s.manager_name ?? s.opened_by_name ?? '-',
        almatyDateTime(s.opened_at),
        s.closed_at ? almatyDateTime(s.closed_at) : 'Открыта',
        notes.length ? String(notes.length) : 'Нет',
        s.state === 'closed' ? (s.closing?.handover ?? '-') : '-',
        button('Подробнее', () => this.details(s), 'button subtle', 'ms-details'),
      ];
    });
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
    if (!rows.length) wrap.append(el('p', 'op-note', 'За этот день смен менеджера нет.'));
    p.append(labelledCards(wrap, head));
  }
  private details(s: ManagerShift) {
    const d = shiftDialog(
      shiftTitle(s),
      `День смены ${dayText(s.business_date)}.`,
      'ms-details-dialog',
    );
    const phase = (title: string, items: StoredAnswer[] | undefined) => {
      d.append(el('h3', '', title));
      for (const a of items ?? []) {
        const line = el('p', 'op-note');
        line.append(
          el('strong', '', `${a.label}: ${ANSWER_LABELS[a.status]}`),
          a.comment ? ` - ${a.comment}` : '',
          a.check && a.auto ? ` (${checkText(a.auto, a.check)})` : '',
        );
        d.append(line);
      }
    };
    phase('Открытие', s.opening.items);
    if (s.closing && !s.closing.draft) {
      phase('Закрытие', s.closing.items);
      d.append(el('h3', '', 'Передача смены'), el('p', 'ms-handover', s.closing.handover ?? ''));
      d.append(
        el(
          'p',
          'op-note',
          `Закрыта ${almatyDateTime(s.closed_at)}${s.closed_by_name ? ', закрыл(а) ' + s.closed_by_name : ''}.`,
        ),
      );
    }
  }
  /** The answer rows of one phase; `answers` is updated in place, `onChange` after each change. */
  private checklist(
    host: HTMLElement,
    items: readonly ChecklistItem[],
    answers: Answer[],
    v: ManagerShiftsView,
    onChange: () => void,
    extra?: (item: ChecklistItem) => HTMLElement | null,
  ) {
    for (const item of items) {
      const row = el('fieldset', 'ms-item');
      row.dataset.testid = 'ms-item-' + item.code;
      row.append(el('legend', '', item.label + (item.required ? '' : ' (необязательно)')));
      const line = this.checkLine(item.auto, v);
      if (line) row.append(line);
      const more = extra?.(item);
      if (more) row.append(more);
      const current = () => answers.find((a) => a.code === item.code);
      const options = el('div', 'ms-options');
      options.setAttribute('role', 'radiogroup');
      const comment = field(
        'Комментарий',
        current()?.comment ?? '',
        (value) => {
          const a = current();
          if (a) a.comment = value;
          onChange();
        },
        { id: 'ms-comment-' + item.code, max: 500 },
      );
      const hint = el('small', 'muted');
      const sync = () => {
        const a = current();
        comment.hidden = !a;
        hint.textContent =
          a && needsComment(item, a, v.checks) ? 'Комментарий обязателен: минимум 3 символа.' : '';
        for (const b of options.querySelectorAll<HTMLButtonElement>('button')) {
          const on = b.dataset.status === a?.status;
          b.className = on ? 'button selected' : 'button';
          b.setAttribute('aria-checked', String(on));
        }
      };
      for (const status of ['done', 'problem', 'not_applicable'] as AnswerStatus[]) {
        const b = button(
          ANSWER_LABELS[status],
          () => {
            const a = current();
            if (a) a.status = status;
            else answers.push({ code: item.code, status, comment: null });
            sync();
            onChange();
            row.dispatchEvent(new Event('change', { bubbles: true }));
          },
          'button',
          `ms-${status}-${item.code}`,
        );
        b.type = 'button';
        b.dataset.status = status;
        b.setAttribute('role', 'radio');
        options.append(b);
      }
      row.append(options, comment, hint);
      sync();
      host.append(row);
    }
  }
  private draftKey(phase: string) {
    return `${DRAFT}:${this.cb.scope()}:${phase}`;
  }
  private openDialog(v: ManagerShiftsView) {
    const store = sessionStore();
    const key = this.draftKey('opening');
    type Draft = { answers: Answer[]; manager: string; version: number };
    const saved = readDraft<Draft>(store, key);
    const restored = saved && saved.version === v.template.version ? saved : null;
    const answers: Answer[] = restored?.answers ?? [];
    let manager = restored?.manager ?? '';
    const d = shiftDialog(
      'Открыть смену',
      'Чек-лист открытия. «Есть проблема» и «Не применимо» требуют комментария.',
      'ms-open-dialog',
    );
    guard(d, {
      question: 'Закрыть окно? Ответы сохранятся как черновик.',
      store: null,
      key: null,
      dirty: restored !== null,
    });
    const persist = () => writeDraft(store, key, { answers, manager, version: v.template.version });
    if (restored) d.append(el('p', 'notice', 'Восстановлен черновик открытия.'));
    d.append(
      select(
        'Менеджер смены',
        manager,
        [{ value: '', label: 'Не указан' }, ...this.cb.employees()],
        (value) => {
          manager = value;
          persist();
        },
        'ms-manager',
      ),
    );
    const error = el('p', 'notice error op-form-error');
    error.setAttribute('role', 'alert');
    this.checklist(d, v.template.opening, answers, v, persist, (item) =>
      item.code === 'meat_prep' && this.cb.can('stock.waste')
        ? button(
            'Списать в «Остатки»',
            () => {
              persist();
              settle(d);
              d.close();
              this.cb.toStock();
            },
            'button subtle',
            'ms-to-stock',
          )
        : null,
    );
    const save = button(
      'Открыть смену',
      () =>
        void (async () => {
          const problems = answerProblems(v.template.opening, answers, v.checks);
          if (problems.length) {
            error.textContent = problemText(problems, v.template.opening);
            return;
          }
          save.disabled = true;
          const failed = await this.cb.execute(
            openCommand(crypto.randomUUID(), manager || null, answers),
            'Открытие смены менеджера',
          );
          save.disabled = false;
          if (failed) {
            error.textContent = failed;
            return;
          }
          dropDraft(store, key);
          settle(d);
          // The new state first, so the page never offers the old shift or version.
          await this.reload();
          d.close();
        })(),
      'button primary',
      'ms-open-save',
    );
    d.append(error, save);
  }
  private closeDialog(v: ManagerShiftsView, shift: ManagerShift) {
    const items = shiftChecklist(v).closing;
    const saved = shift.closing?.draft ? shift.closing : null;
    const answers: Answer[] = (saved?.items ?? []).map((a) => ({
      code: a.code,
      status: a.status,
      comment: a.comment,
    }));
    let handover = saved?.handover ?? '';
    const d = shiftDialog(
      'Закрыть смену',
      'Шаг 1 из 2: чек-лист закрытия. «Есть проблема» и «Не применимо» требуют комментария.',
      'ms-close-dialog',
    );
    guard(d, { question: 'Закрыть окно? Несохранённые ответы пропадут.' });
    const step1 = el('div', 'ms-step');
    const step2 = el('div', 'ms-step');
    step2.hidden = true;
    const error = el('p', 'notice error op-form-error');
    error.setAttribute('role', 'alert');
    this.checklist(step1, items, answers, v, () => {
      error.textContent = '';
    });
    const draft = button(
      'Сохранить черновик',
      () =>
        void (async () => {
          const failed = await this.cb.execute(
            draftCommand(shift, answers, handover),
            'Черновик закрытия смены менеджера',
          );
          if (failed) error.textContent = failed;
          else {
            settle(d);
            await this.reload();
            d.close();
          }
        })(),
      'button subtle',
      'ms-close-draft',
    );
    const next = button(
      'Далее',
      () => {
        const problems = answerProblems(items, answers, v.checks);
        if (problems.length) {
          error.textContent = problemText(problems, items);
          return;
        }
        error.textContent = '';
        step1.hidden = true;
        step2.hidden = false;
        d.querySelector('.op-note')!.textContent = 'Шаг 2 из 2: передача смены.';
      },
      'button primary',
      'ms-close-next',
    );
    step1.append(draft, next);
    const back = button(
      'Назад',
      () => {
        step2.hidden = true;
        step1.hidden = false;
      },
      'button subtle',
    );
    const confirm = button(
      'Закрыть смену',
      () =>
        void (async () => {
          if (handover.trim().length < 3) {
            error.textContent = 'Заполните передачу смены.';
            return;
          }
          confirm.disabled = true;
          const failed = await this.cb.execute(
            closeCommand(shift, answers, handover),
            'Закрытие смены менеджера',
          );
          confirm.disabled = false;
          if (failed) {
            error.textContent = failed;
            return;
          }
          settle(d);
          // The new state first, so the page never offers the old shift or version.
          await this.reload();
          d.close();
        })(),
      'button primary',
      'ms-close-save',
    );
    step2.append(
      field(
        'Передача смены',
        handover,
        (value) => {
          handover = value;
          error.textContent = '';
        },
        {
          id: 'ms-handover',
          multiline: true,
          max: HANDOVER_MAX,
          required: true,
          hint: 'Что передаёте следующему менеджеру: остатки, поломки, договорённости.',
        },
      ),
      back,
      confirm,
    );
    d.append(step1, step2, error);
  }
  /** The checklist template of the manager: labels, required, new items (design-bo-ui 5.6). */
  private templateDialog() {
    const v = this.view;
    if (!v) return;
    const phases = {
      opening: v.template.opening.map((i) => ({ ...i })),
      closing: v.template.closing.map((i) => ({ ...i })),
    };
    let reason = '';
    const d = shiftDialog(
      'Чек-лист смены',
      `Версия ${v.template.version}${v.template.updated_at ? ' от ' + almatyDateTime(v.template.updated_at) : ''}. Новая версия действует для смен, открытых после сохранения.`,
      'ms-template-dialog',
    );
    guard(d, { question: 'Закрыть окно? Изменения чек-листа не сохранятся.' });
    if (!v.template.editable)
      d.append(
        el('p', 'notice', 'Сервер пока не хранит свой чек-лист точки: действует встроенный.'),
      );
    const lists = el('div');
    const draw = () => {
      lists.replaceChildren();
      for (const [phase, title] of [
        ['opening', 'Открытие'],
        ['closing', 'Закрытие'],
      ] as const) {
        lists.append(el('h3', '', title));
        phases[phase].forEach((item, index) => {
          const row = el('div', 'inventory-filters ms-template-row');
          row.append(
            field(
              item.auto ? 'Пункт (с авто-проверкой)' : 'Пункт',
              item.label,
              (value) => {
                item.label = value;
              },
              { id: `ms-template-${phase}-${index}`, max: 120 },
            ),
            check('Обязательный', item.required, (value) => {
              item.required = value;
            }),
          );
          if (!item.auto)
            row.append(
              button(
                'Убрать',
                () => {
                  phases[phase].splice(index, 1);
                  draw();
                },
                'button subtle',
              ),
            );
          lists.append(row);
        });
        lists.append(
          button(
            'Добавить пункт',
            () => {
              phases[phase].push({
                code: newItemCode([...phases.opening, ...phases.closing]),
                label: '',
                auto: null,
                required: true,
              });
              draw();
            },
            'button subtle',
            'ms-template-add-' + phase,
          ),
        );
      }
    };
    draw();
    const error = el('p', 'notice error op-form-error');
    error.setAttribute('role', 'alert');
    const save = button(
      'Сохранить версию',
      () =>
        void (async () => {
          const all = [...phases.opening, ...phases.closing];
          if (all.some((i) => !i.label.trim())) {
            error.textContent = 'У каждого пункта должен быть текст.';
            return;
          }
          if (!phases.opening.length || !phases.closing.length) {
            error.textContent = 'В открытии и закрытии нужен хотя бы один пункт.';
            return;
          }
          if (reason.trim().length < 3) {
            error.textContent = 'Укажите причину изменения: минимум 3 символа.';
            return;
          }
          const failed = await this.cb.execute(
            templateCommand(v.template.version, phases.opening, phases.closing),
            reason,
          );
          if (failed) error.textContent = failed;
          else {
            settle(d);
            await this.reload();
            d.close();
          }
        })(),
      'button primary',
      'ms-template-save',
    );
    save.disabled = !v.template.editable;
    d.append(
      lists,
      field(
        'Причина изменения',
        reason,
        (value) => {
          reason = value;
        },
        { id: 'op-reason', max: 500, required: true },
      ),
      error,
      save,
    );
  }
}
